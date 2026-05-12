/* eslint-disable no-restricted-syntax */
//
// Config-source / threading file — reads process.env directly for
// dynamic-key operations or to pass rawEnv into typed helpers that
// themselves use env-registry. Per Sprint ι policy, file-level
// disable instead of accessor-bloat.
//
import { lstatSync } from 'node:fs';

import {
  hasRequiredBridgeExports,
  loadPlatformAwareBridge,
  resolveBridgeContract,
  type BridgeAliasMap,
} from './napi-contract.js';
import { NapiChainAdapter } from './rust-chain-adapter.js';
import { getChainPath, normalizeChainName } from '../../config/paths.js';
import { parseBool } from '../../core/env.js';
import { stableStringify } from '../../core/stable-stringify.js';
import { assertAuditWriteAllowed } from '../logging/audit-write-guard.js';
import { resolveRustBridgePath } from '../runtime/install-root.js';

// Chains that count as audit/system surfaces. Writes to these from a
// VITEST process must opt in via MEMPHIS_TEST_ALLOW_AUDIT_WRITE=1 or
// they're refused (Block 1853 incident, 2026-05-12). Other chains
// (journal, case, decisions, etc.) are unguarded — tests legitimately
// produce those via the mocked chain adapter pattern.
const AUDIT_GUARDED_CHAINS: ReadonlySet<string> = new Set(['system', 'security']);

export type ChainBackend = 'ts-legacy' | 'rust-napi';

export interface ChainAdapterStatus {
  backend: ChainBackend;
  rustEnabled: boolean;
  rustBridgePath?: string;
  rustBridgeLoaded: boolean;
}

const CHAIN_STATUS_ALIASES = {
  chain_append: ['chain_append', 'chainAppend'],
  chain_validate: ['chain_validate', 'chainValidate'],
  chain_query: ['chain_query', 'chainQuery'],
} satisfies BridgeAliasMap<'chain_append' | 'chain_validate' | 'chain_query'>;

function getRustBridgePath(rawEnv: NodeJS.ProcessEnv): string {
  return resolveRustBridgePath(rawEnv);
}

export function getChainAdapterStatus(rawEnv: NodeJS.ProcessEnv = process.env): ChainAdapterStatus {
  const rustEnabled = parseBool(rawEnv.RUST_CHAIN_ENABLED, false);
  const rustBridgePath = getRustBridgePath(rawEnv);

  if (!rustEnabled) {
    return {
      backend: 'ts-legacy',
      rustEnabled,
      rustBridgePath,
      rustBridgeLoaded: false,
    };
  }

  const resolution = resolveBridgeContract(
    loadPlatformAwareBridge(rustBridgePath),
    CHAIN_STATUS_ALIASES,
  );
  if (!resolution.bridgeLoaded) {
    return {
      backend: 'ts-legacy',
      rustEnabled,
      rustBridgePath,
      rustBridgeLoaded: false,
    };
  }

  const hasCoreFns = hasRequiredBridgeExports(resolution, [
    'chain_append',
    'chain_validate',
    'chain_query',
  ]);

  return {
    backend: hasCoreFns ? 'rust-napi' : 'ts-legacy',
    rustEnabled,
    rustBridgePath,
    rustBridgeLoaded: hasCoreFns,
  };
}

export interface AppendBlockResult {
  index: number;
  hash: string;
  chain: string;
  timestamp: string;
}

const GENESIS_PREV_HASH = '0'.repeat(64);
const SAFE_CHAIN_NAME = /^[A-Za-z0-9_-]{1,64}$/;
const APPEND_LOCK_FILE = '.append.lock';
const APPEND_LOCK_RETRY_MS = 10;
const APPEND_LOCK_MAX_ATTEMPTS = 200;

export interface ChainBlock {
  index: number;
  timestamp: string;
  chain: string;
  data: Record<string, unknown>;
  prev_hash: string;
  hash: string;
  signer?: string;
  signature?: string;
}

interface CanonicalHashData {
  type: string;
  content: string;
  tags: string[];
}

export interface ChainExportEnvelope {
  chainName: string;
  exportedAt: string;
  blockCount: number;
  blocks: ChainBlock[];
}

/**
 * Match a config block in either shape:
 *   - Legacy (≤2026-05-05): `data.type === 'config'` (now aliased to
 *     SystemEvent on Rust side, but old on-disk blocks still have the
 *     literal 'config' type field).
 *   - Current: `data.type === 'system_event' && data.kind === 'config'`
 *     — new writes adopted this shape so Rust round-trip serialisation
 *     no longer normalises the kind tag away.
 *
 * Append-only chain means both shapes coexist forever for the journal
 * chain. Callers must accept both to read the full config history.
 */
function isConfigBlock(data: Record<string, unknown>): data is { type: string; key?: string; value?: string; kind?: string } {
  if (typeof data?.type !== 'string') return false;
  if (data.type === 'config') return true;
  if (data.type === 'system_event' && data.kind === 'config') return true;
  return false;
}

export async function appendBlock(
  chainName: string,
  data: Record<string, unknown>,
  rawEnv: NodeJS.ProcessEnv = process.env,
): Promise<AppendBlockResult> {
  const normalizedChainName = normalizeChainName(chainName) ?? chainName;
  // Block 1853 incident (2026-05-12) — refuse `system`/`security`
  // chain writes from VITEST processes that haven't opted in. Throws
  // a clear error rather than silent-skipping; emitRuntimeSecurityEvent's
  // own try/catch absorbs it, and direct callers see exactly what to
  // do (set MEMPHIS_TEST_ALLOW_AUDIT_WRITE=1 + tmpdir MEMPHIS_HOME).
  if (AUDIT_GUARDED_CHAINS.has(normalizedChainName)) {
    assertAuditWriteAllowed(`appendBlock:${normalizedChainName}`, rawEnv);
  }
  const status = getChainAdapterStatus(rawEnv);

  if (status.backend === 'rust-napi') {
    try {
      const adapter = new NapiChainAdapter(rawEnv);
      return await adapter.appendBlock(normalizedChainName, data);
    } catch (error) {
      throw new Error(`rust chain append failed: ${String(error)}`, { cause: error });
    }
  }

  // Legacy fallback: write directly to the configured chains directory.
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  const os = await import('node:os');
  const crypto = await import('node:crypto');

  const chainsDir = resolveChainDir(normalizedChainName, {
    homedir: os.homedir(),
    resolve: path.resolve,
    sep: path.sep,
  });
  await fs.mkdir(chainsDir, { recursive: true });

  return withAppendLock(chainsDir, fs, path, async () => {
    await pruneTrailingEmptyBlockFiles(chainsDir, fs, path);
    const blocks = await readAndValidateChainBlocks(chainsDir, fs, crypto);
    const previousBlock = blocks.at(-1);
    const nextIndex = previousBlock ? previousBlock.index + 1 : 1;

    const timestamp = new Date().toISOString();
    const blockWithoutHash = {
      index: nextIndex,
      timestamp,
      chain: normalizedChainName,
      data,
      prev_hash: previousBlock?.hash ?? GENESIS_PREV_HASH,
    };
    const block: ChainBlock = {
      ...blockWithoutHash,
      hash: hashBlock(blockWithoutHash, crypto),
    };

    const filename = path.join(chainsDir, `${String(nextIndex).padStart(6, '0')}.json`);
    const tmpFilename = `${filename}.tmp-${process.pid}-${Date.now()}`;
    const payload = JSON.stringify(block, null, 2);

    await fs.writeFile(tmpFilename, payload, 'utf8');
    try {
      await fs.rename(tmpFilename, filename);
    } catch (error) {
      await fs.unlink(tmpFilename).catch(() => undefined);
      throw error;
    }

    return {
      index: nextIndex,
      hash: block.hash,
      chain: normalizedChainName,
      timestamp,
    };
  });
}

/**
 * Appends a pre-computed block directly to the chain directory.
 * Used by SyncManager.writeChain when blocks are pre-validated and pre-hashed.
 * The caller must hold the append lock for the chain directory.
 */
export async function appendPrecomputedBlock(
  chainName: string,
  block: {
    index: number;
    timestamp: string;
    hash: string;
    prev_hash: string;
    data: Record<string, unknown>;
    signer?: string;
    signature?: string;
  },
  _rawEnv: NodeJS.ProcessEnv = process.env,
): Promise<{ index: number; hash: string; chain: string; timestamp: string }> {
  const normalizedChainName = normalizeChainName(chainName) ?? chainName;
  const fs = await import('node:fs/promises');
  const path = await import('node:path');

  const chainsDir = resolveChainDir(normalizedChainName, {
    homedir: (await import('node:os')).homedir(),
    resolve: path.resolve,
    sep: path.sep,
  });

  await fs.mkdir(chainsDir, { recursive: true });

  const chainBlock: ChainBlock = {
    index: block.index,
    timestamp: block.timestamp,
    chain: normalizedChainName,
    data: block.data,
    prev_hash: block.prev_hash,
    hash: block.hash,
    ...(block.signer !== undefined ? { signer: block.signer } : {}),
    ...(block.signature !== undefined ? { signature: block.signature } : {}),
  };

  const filename = path.join(chainsDir, `${String(block.index).padStart(6, '0')}.json`);
  const tmpFilename = `${filename}.tmp-${process.pid}-${Date.now()}`;
  const payload = JSON.stringify(chainBlock, null, 2);

  await fs.writeFile(tmpFilename, payload, 'utf8');
  try {
    await fs.rename(tmpFilename, filename);
  } catch (error) {
    await fs.unlink(tmpFilename).catch(() => undefined);
    throw error;
  }

  return {
    index: block.index,
    hash: block.hash,
    chain: normalizedChainName,
    timestamp: block.timestamp,
  };
}

export async function getConfigKeys(): Promise<string[]> {
  const status = getChainAdapterStatus();

  if (status.backend === 'rust-napi') {
    try {
      const adapter = new NapiChainAdapter();
      const blocks = await adapter.getRecentBlocks('journal', 10000);
      const keys = new Set<string>();
      for (const block of blocks) {
        const data = block.data as Record<string, unknown>;
        if (isConfigBlock(data) && typeof data.key === 'string') {
          keys.add(data.key);
        }
      }
      return Array.from(keys).sort();
    } catch {
      // fall through to TS path
    }
  }

  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  const os = await import('node:os');

  const chainsDir = resolveChainDir('journal', {
    homedir: os.homedir(),
    resolve: path.resolve,
    sep: path.sep,
  });

  const keys = new Set<string>();
  try {
    const files = (await fs.readdir(chainsDir)).filter((f) => f.endsWith('.json')).sort();
    for (const file of files) {
      const raw = await fs.readFile(path.join(chainsDir, file), 'utf8');
      const block = JSON.parse(raw) as ChainBlock;
      const data = block.data as Record<string, unknown>;
      if (isConfigBlock(data) && typeof data.key === 'string') {
        keys.add(data.key);
      }
    }
  } catch {
    // directory empty or no blocks yet
  }

  return Array.from(keys).sort();
}

export interface ConfigHistoryEntry {
  key: string;
  value: string | null;
  index: number;
  timestamp: string;
}

export async function getConfigHistory(key: string): Promise<ConfigHistoryEntry[]> {
  const status = getChainAdapterStatus();

  if (status.backend === 'rust-napi') {
    try {
      const adapter = new NapiChainAdapter();
      const blocks = await adapter.getRecentBlocks('journal', 10000);
      const history: ConfigHistoryEntry[] = [];
      for (const block of blocks) {
        const data = block.data as Record<string, unknown>;
        if (isConfigBlock(data) && data.key === key) {
          history.push({
            key,
            value: data.value ?? null,
            index: block.index ?? 0,
            timestamp: block.timestamp ?? new Date().toISOString(),
          });
        }
      }
      return history;
    } catch {
      // fall through to TS path
    }
  }

  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  const os = await import('node:os');

  const chainsDir = resolveChainDir('journal', {
    homedir: os.homedir(),
    resolve: path.resolve,
    sep: path.sep,
  });

  const history: ConfigHistoryEntry[] = [];
  try {
    const files = (await fs.readdir(chainsDir)).filter((f) => f.endsWith('.json')).sort();
    for (const file of files) {
      const raw = await fs.readFile(path.join(chainsDir, file), 'utf8');
      const block = JSON.parse(raw) as ChainBlock;
      const data = block.data as Record<string, unknown>;
      if (isConfigBlock(data) && data.key === key) {
        history.push({
          key,
          value: data.value ?? null,
          index: block.index,
          timestamp: block.timestamp,
        });
      }
    }
  } catch {
    // directory empty or no blocks yet
  }

  return history;
}

export async function getConfigValue(key: string): Promise<string | null> {
  const status = getChainAdapterStatus();

  if (status.backend === 'rust-napi') {
    try {
      const adapter = new NapiChainAdapter();
      const blocks = await adapter.getRecentBlocks('journal', 1000);
      // Scan reverse (most recent first)
      for (let i = blocks.length - 1; i >= 0; i--) {
        const block = blocks[i]!;
        const data = block.data as Record<string, unknown>;
        if (isConfigBlock(data) && data.key === key && typeof data.value === 'string') {
          return data.value;
        }
      }
      return null;
    } catch {
      // fall through to TS path
    }
  }

  // TS/legacy path: read journal blocks directly
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  const os = await import('node:os');

  const chainsDir = resolveChainDir('journal', {
    homedir: os.homedir(),
    resolve: path.resolve,
    sep: path.sep,
  });

  try {
    const files = (await fs.readdir(chainsDir)).filter((f) => f.endsWith('.json')).sort();
    // Scan reverse
    for (let i = files.length - 1; i >= 0; i--) {
      const file = files[i]!;
      const raw = await fs.readFile(path.join(chainsDir, file), 'utf8');
      const block = JSON.parse(raw) as ChainBlock;
      const data = block.data as Record<string, unknown>;
      if (isConfigBlock(data) && data.key === key && typeof data.value === 'string') {
        return data.value;
      }
    }
  } catch {
    // directory empty or no blocks yet
  }

  return null;
}

export function resolveChainDir(
  chainName: string,
  deps: { homedir: string; resolve: (...paths: string[]) => string; sep: string },
): string {
  if (typeof chainName !== 'string' || chainName.trim().length === 0) {
    throw new Error('invalid chain name');
  }

  if (chainName.includes('\0')) {
    throw new Error('invalid chain name');
  }

  const normalized = normalizeChainName(chainName)?.trim() ?? '';
  if (normalized.includes('..') || normalized.includes('/') || normalized.includes('\\')) {
    throw new Error('invalid chain name');
  }
  if (!SAFE_CHAIN_NAME.test(normalized)) {
    throw new Error('invalid chain name');
  }

  const baseDir = deps.resolve(getChainPath());
  const targetDir = deps.resolve(baseDir, normalized);
  if (targetDir !== baseDir && !targetDir.startsWith(`${baseDir}${deps.sep}`)) {
    throw new Error('invalid chain name');
  }

  try {
    if (lstatSync(targetDir).isSymbolicLink()) {
      throw new Error('invalid chain name');
    }
  } catch {
    // ignore missing paths
  }

  return targetDir;
}

export function hashBlock(
  block: Omit<ChainBlock, 'hash'>,
  crypto: typeof import('node:crypto'),
): string {
  const canonical = stableStringify({
    ...block,
    data: toCanonicalHashData(block.data),
  });
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

function toCanonicalHashData(data: Record<string, unknown>): CanonicalHashData {
  const tags = Array.isArray(data.tags)
    ? data.tags.filter((value): value is string => typeof value === 'string')
    : [];
  const content = typeof data.content === 'string' ? data.content : JSON.stringify(data);
  const type = typeof data.type === 'string' ? data.type : 'journal';
  return { type, content, tags };
}

async function readAndValidateChainBlocks(
  chainsDir: string,
  fs: typeof import('node:fs/promises'),
  crypto: typeof import('node:crypto'),
): Promise<ChainBlock[]> {
  const files = (await fs.readdir(chainsDir)).filter((file) => file.endsWith('.json'));
  if (files.length === 0) {
    return [];
  }

  const indexed = files
    .map((file) => ({ file, index: Number.parseInt(file.replace('.json', ''), 10) }))
    .filter((entry) => Number.isFinite(entry.index))
    .sort((a, b) => a.index - b.index);

  if (indexed.length === 0) {
    return [];
  }

  // Read and parse blocks concurrently to reduce I/O latency on long chains.
  const loaded = await Promise.all(
    indexed.map(async (entry) => ({
      file: entry.file,
      block: await readBlockFile(`${chainsDir}/${entry.file}`, entry.file, fs),
    })),
  );

  const blocks: ChainBlock[] = [];
  // Pull a chain name from the directory path for diagnostic messages —
  // without this, operators saw bare `chain integrity check failed for
  // 00042.json: hash mismatch` and had to grep their data dir to find
  // out which chain (journal? cases? soul?) was corrupted. Live
  // 2026-05-08 session surfaced exactly this confusion.
  const chainName = chainsDir.split(/[\\/]/).filter(Boolean).pop() ?? '<unknown>';
  const formatHashFingerprint = (hash: string | undefined): string => {
    if (!hash) return '<empty>';
    return hash.length > 12 ? `${hash.slice(0, 8)}…${hash.slice(-4)}` : hash;
  };
  for (const { file, block: current } of loaded) {
    const mismatch = checkBlockHashMismatch(current, crypto, file);
    if (mismatch?.mismatch) {
      if (isChainRepairEnabled()) {
        await repairBlockHash(current, file, chainsDir, crypto, fs);
        // Re-check hash after repair (block was updated in place)
        current.hash = mismatch.expectedHash;
      } else {
        throw new Error(
          `chain '${chainName}' integrity check failed at block ${current.index} (${file}): ` +
            `stored hash ${formatHashFingerprint(mismatch.storedHash)} ≠ ` +
            `computed ${formatHashFingerprint(mismatch.expectedHash)}. ` +
            `Run \`memphis chain rebuild\` (or \`memphis doctor --fix\`) to recompute the chain — \`memphis repair runtime\` only rebuilds derived runtime/index state, not block hashes. Or set MEMPHIS_CHAIN_REPAIR_ON_MISMATCH=true to auto-heal individual blocks at read time.`,
        );
      }
    }

    if (blocks.length === 0) {
      // Accept index 0 or 1 as valid genesis (Rust uses index 0, TS uses index 1)
      if (current.index !== 0 && current.index !== 1) {
        throw new Error(
          `chain '${chainName}' integrity check failed at block ${current.index} (${file}): ` +
            `missing genesis block (chain must start at index 0 or 1)`,
        );
      }
      // For index=0 genesis: prev_hash must be GENESIS_PREV_HASH
      // For index=1 genesis: prev_hash must be '' or GENESIS_PREV_HASH
      if (current.index === 0 && current.prev_hash !== GENESIS_PREV_HASH) {
        throw new Error(
          `chain '${chainName}' integrity check failed at genesis block 0 (${file}): ` +
            `prev_hash ${formatHashFingerprint(current.prev_hash)} ≠ expected ${formatHashFingerprint(GENESIS_PREV_HASH)}`,
        );
      }
      if (
        current.index === 1 &&
        current.prev_hash !== '' &&
        current.prev_hash !== GENESIS_PREV_HASH
      ) {
        throw new Error(
          `chain '${chainName}' integrity check failed at genesis block 1 (${file}): ` +
            `prev_hash ${formatHashFingerprint(current.prev_hash)} ≠ expected '' or ${formatHashFingerprint(GENESIS_PREV_HASH)}`,
        );
      }
      blocks.push(current);
      continue;
    }

    const previous = blocks[blocks.length - 1]!;
    if (current.index !== previous.index + 1) {
      throw new Error(
        `chain '${chainName}' integrity check failed at block ${current.index} (${file}): ` +
          `non-sequential index after block ${previous.index}`,
      );
    }

    if (current.prev_hash !== previous.hash) {
      throw new Error(
        `chain '${chainName}' integrity check failed at block ${current.index} (${file}): ` +
          `prev_hash ${formatHashFingerprint(current.prev_hash)} ≠ previous block's hash ${formatHashFingerprint(previous.hash)}`,
      );
    }

    blocks.push(current);
  }

  return blocks;
}

async function readBlockFile(
  filename: string,
  file: string,
  fs: typeof import('node:fs/promises'),
): Promise<ChainBlock> {
  const raw = await fs.readFile(filename, 'utf8');
  const parsed = parseJsonObject(raw, file) as Partial<ChainBlock>;
  return toChainBlock(parsed, file);
}

function isStrictChainValidation(): boolean {
  return (process.env.MEMPHIS_STRICT_CHAIN_VALIDATION ?? 'true').toLowerCase() === 'true';
}

function isChainRepairEnabled(): boolean {
  return parseBool(process.env.MEMPHIS_CHAIN_REPAIR_ON_MISMATCH, false);
}

interface HashMismatchResult {
  mismatch: true;
  expectedHash: string;
  storedHash: string;
}

function checkBlockHashMismatch(
  block: ChainBlock,
  crypto: typeof import('node:crypto'),
  _file: string,
): HashMismatchResult | undefined {
  const blockWithoutHash = {
    index: block.index,
    timestamp: block.timestamp,
    chain: block.chain,
    data: block.data,
    prev_hash: block.prev_hash,
  };
  const expectedHash = hashBlock(blockWithoutHash, crypto);
  const legacyStableHash = crypto
    .createHash('sha256')
    .update(stableStringify(blockWithoutHash))
    .digest('hex');

  if (block.hash === expectedHash || block.hash === legacyStableHash) {
    // Canonical hash matches — pass
    return undefined;
  } else if (!isStrictChainValidation()) {
    // Legacy fallback: accept older hash formats when strict mode is off
    const legacyDataHash = crypto
      .createHash('sha256')
      .update(JSON.stringify(block.data))
      .digest('hex');
    const legacyBlockHash = crypto
      .createHash('sha256')
      .update(JSON.stringify(blockWithoutHash))
      .digest('hex');

    if (block.hash !== legacyDataHash && block.hash !== legacyBlockHash) {
      return { mismatch: true, expectedHash, storedHash: block.hash };
    }
    return undefined;
  } else {
    return { mismatch: true, expectedHash, storedHash: block.hash };
  }
}

async function repairBlockHash(
  block: ChainBlock,
  file: string,
  chainsDir: string,
  crypto: typeof import('node:crypto'),
  fs: typeof import('node:fs/promises'),
): Promise<void> {
  const blockWithoutHash = {
    index: block.index,
    timestamp: block.timestamp,
    chain: block.chain,
    data: block.data,
    prev_hash: block.prev_hash,
  };
  const correctHash = hashBlock(blockWithoutHash, crypto);
  const repairedBlock: ChainBlock = { ...block, hash: correctHash };

  const filename = `${chainsDir}/${file}`;
  const tmpFilename = `${filename}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tmpFilename, JSON.stringify(repairedBlock, null, 2), 'utf8');
  await fs.rename(tmpFilename, filename);

  // Append repair audit block
  await appendBlock('system', {
    type: 'system_event',
    kind: 'chain.repair',
    source: 'chain-adapter',
    schemaVersion: 1,
    payload: {
      chain: block.chain,
      blockIndex: block.index,
      file,
      storedHash: block.hash,
      correctHash,
      repairedAt: new Date().toISOString(),
    },
  });
}

function toChainBlock(block: Partial<ChainBlock>, file: string): ChainBlock {
  if (
    typeof block.index !== 'number' ||
    typeof block.timestamp !== 'string' ||
    typeof block.chain !== 'string' ||
    typeof block.prev_hash !== 'string' ||
    typeof block.hash !== 'string' ||
    typeof block.data !== 'object' ||
    block.data === null ||
    Array.isArray(block.data)
  ) {
    throw new Error(`chain integrity check failed for ${file}: invalid block shape`);
  }

  return {
    ...(block as ChainBlock),
    chain: normalizeChainName(block.chain) ?? block.chain,
  };
}

export async function verifyChainIntegrity(
  chainName?: string,
  _rawEnv: NodeJS.ProcessEnv = process.env,
): Promise<{ ok: boolean; chainsChecked: number; blockCount: number; chain?: string }> {
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  const os = await import('node:os');
  const crypto = await import('node:crypto');

  const baseDir = path.resolve(getChainPath());
  const selectedChains = chainName
    ? [normalizeChainName(chainName) ?? chainName]
    : (await fs.readdir(baseDir).catch(() => [])).filter((name) => SAFE_CHAIN_NAME.test(name));

  let chainsChecked = 0;
  let blockCount = 0;

  for (const chain of selectedChains) {
    const chainsDir = resolveChainDir(chain, {
      homedir: os.homedir(),
      resolve: path.resolve,
      sep: path.sep,
    });

    const blocks = await readAndValidateChainBlocks(chainsDir, fs, crypto);
    chainsChecked += 1;
    blockCount += blocks.length;
  }

  return { ok: true, chainsChecked, blockCount, chain: chainName };
}

export async function exportChain(
  chainName: string,
  rawEnv: NodeJS.ProcessEnv = process.env,
): Promise<ChainExportEnvelope> {
  const normalizedChainName = normalizeChainName(chainName) ?? chainName;
  if (!SAFE_CHAIN_NAME.test(normalizedChainName)) {
    throw new Error(`chain export failed: invalid chain name "${chainName}"`);
  }

  const fs = await import('node:fs/promises');
  const crypto = await import('node:crypto');

  const chainsDir = getChainPath(normalizedChainName, rawEnv);

  const dirStats = await fs.stat(chainsDir).catch(() => null);
  if (!dirStats || !dirStats.isDirectory()) {
    throw new Error(`chain export failed: chain "${normalizedChainName}" not found`);
  }

  const blocks = await readAndValidateChainBlocks(chainsDir, fs, crypto);
  return {
    chainName: normalizedChainName,
    exportedAt: new Date().toISOString(),
    blockCount: blocks.length,
    blocks,
  };
}

function parseJsonObject(raw: string, file: string): unknown {
  const source = raw.trim();
  if (source.length === 0) {
    throw new Error(`chain integrity check failed for ${file}: invalid json (empty file)`);
  }

  try {
    return JSON.parse(source);
  } catch (error) {
    const extracted = extractJsonObjects(raw);
    if (extracted.length > 0) {
      return extracted[extracted.length - 1]!;
    }

    const detail = error instanceof Error ? error.message : 'parse failed';
    const wrappedError = new Error(
      `chain integrity check failed for ${file}: invalid json (${detail})`,
    );
    if (error instanceof Error) {
      wrappedError.cause = error;
    }
    throw wrappedError;
  }
}

function extractJsonObjects(raw: string): unknown[] {
  const out: unknown[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]!;

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }

    if (ch === '{') {
      if (depth === 0) {
        start = i;
      }
      depth += 1;
      continue;
    }

    if (ch === '}' && depth > 0) {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        const chunk = raw.slice(start, i + 1);
        try {
          out.push(JSON.parse(chunk));
        } catch {
          // Best-effort recovery: skip malformed chunk and continue.
        }
        start = -1;
      }
    }
  }

  return out;
}

const APPEND_LOCK_STALE_MS = 30_000;

export async function withAppendLock<T>(
  chainsDir: string,
  fs: typeof import('node:fs/promises'),
  path: typeof import('node:path'),
  fn: () => Promise<T>,
): Promise<T> {
  const lockPath = path.join(chainsDir, APPEND_LOCK_FILE);

  for (let attempt = 0; attempt < APPEND_LOCK_MAX_ATTEMPTS; attempt += 1) {
    try {
      const lockHandle = await fs.open(lockPath, 'wx');
      try {
        return await fn();
      } finally {
        await lockHandle.close().catch(() => undefined);
        await fs.unlink(lockPath).catch(() => undefined);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'EEXIST') {
        throw error;
      }
      // Detect stale lock from a crashed process
      try {
        const lockStat = await fs.stat(lockPath);
        if (Date.now() - lockStat.mtimeMs > APPEND_LOCK_STALE_MS) {
          await fs.unlink(lockPath).catch(() => undefined);
          continue;
        }
      } catch {
        // lock file disappeared — retry immediately
        continue;
      }
      await delay(APPEND_LOCK_RETRY_MS);
    }
  }

  throw new Error(`chain append lock timeout for ${chainsDir}`);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function pruneTrailingEmptyBlockFiles(
  chainsDir: string,
  fs: typeof import('node:fs/promises'),
  path: typeof import('node:path'),
): Promise<void> {
  const indexed = (await fs.readdir(chainsDir))
    .filter((file) => file.endsWith('.json'))
    .map((file) => ({ file, index: Number.parseInt(file.replace('.json', ''), 10) }))
    .filter((entry) => Number.isFinite(entry.index))
    .sort((a, b) => b.index - a.index);

  for (const entry of indexed) {
    const abs = path.join(chainsDir, entry.file);
    const stats = await fs.stat(abs).catch(() => null);
    if (!stats || !stats.isFile()) {
      continue;
    }

    if (stats.size > 0) {
      break;
    }

    await fs.unlink(abs).catch(() => undefined);
  }
}

// ── Chain Hash Diagnosis & Repair ─────────────────────────────────────────────

export interface ChainHashDiagnosis {
  chainName: string;
  totalBlocks: number;
  mismatches: number;
  details: Array<{ file: string; storedHash: string; expectedHash: string }>;
}

/**
 * Diagnose hash mismatches in a chain without throwing.
 * Returns a report of which blocks have wrong hashes.
 */
export async function diagnoseChainHashes(
  chainName: string,
  _rawEnv: NodeJS.ProcessEnv = process.env,
): Promise<ChainHashDiagnosis> {
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  const os = await import('node:os');
  const crypto = await import('node:crypto');

  const normalizedName = normalizeChainName(chainName) ?? chainName;
  const chainsDir = resolveChainDir(normalizedName, {
    homedir: os.homedir(),
    resolve: path.resolve,
    sep: path.sep,
  });

  const details: ChainHashDiagnosis['details'] = [];

  let files: string[];
  try {
    files = (await fs.readdir(chainsDir)).filter((f) => f.endsWith('.json')).sort();
  } catch {
    return { chainName: normalizedName, totalBlocks: 0, mismatches: 0, details };
  }

  for (const file of files) {
    try {
      const raw = await fs.readFile(path.join(chainsDir, file), 'utf8');
      const block = JSON.parse(raw) as ChainBlock;
      const blockWithoutHash = {
        index: block.index,
        timestamp: block.timestamp,
        chain: block.chain,
        data: block.data,
        prev_hash: block.prev_hash,
      };
      const expected = hashBlock(blockWithoutHash, crypto);
      if (block.hash !== expected) {
        details.push({ file, storedHash: block.hash, expectedHash: expected });
      }
    } catch {
      details.push({ file, storedHash: '(unreadable)', expectedHash: '(unknown)' });
    }
  }

  return {
    chainName: normalizedName,
    totalBlocks: files.length,
    mismatches: details.length,
    details,
  };
}

export interface ChainRebuildResult {
  chainName: string;
  blocksProcessed: number;
  blocksRewritten: number;
  backupDir: string | null;
}

/**
 * Rebuild chain hashes using the canonical hash function.
 * Creates a backup of the chain directory before any writes.
 * Recomputes all hashes sequentially, fixing both block hashes and prev_hash linkage.
 */
export async function rebuildChainHashes(
  chainName: string,
  _rawEnv: NodeJS.ProcessEnv = process.env,
): Promise<ChainRebuildResult> {
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  const os = await import('node:os');
  const crypto = await import('node:crypto');

  const normalizedName = normalizeChainName(chainName) ?? chainName;
  const chainsDir = resolveChainDir(normalizedName, {
    homedir: os.homedir(),
    resolve: path.resolve,
    sep: path.sep,
  });

  const files = (await fs.readdir(chainsDir)).filter((f) => f.endsWith('.json')).sort();

  if (files.length === 0) {
    return { chainName: normalizedName, blocksProcessed: 0, blocksRewritten: 0, backupDir: null };
  }

  // Create backup before modifying
  const backupDir = `${chainsDir}.backup-${Date.now()}`;
  await fs.cp(chainsDir, backupDir, { recursive: true });

  // Read all blocks
  const blocks: ChainBlock[] = [];
  for (const file of files) {
    const raw = await fs.readFile(path.join(chainsDir, file), 'utf8');
    const parsed = JSON.parse(raw) as ChainBlock;
    blocks.push(parsed);
  }

  // Rebuild hashes sequentially
  let rewritten = 0;
  let prevHash = GENESIS_PREV_HASH;

  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i]!;
    const file = files[i]!;

    const blockWithoutHash = {
      index: block.index,
      timestamp: block.timestamp,
      chain: normalizedName,
      data: block.data,
      prev_hash: prevHash,
    };
    const correctHash = hashBlock(blockWithoutHash, crypto);

    const needsRewrite =
      block.hash !== correctHash || block.prev_hash !== prevHash || block.chain !== normalizedName;

    if (needsRewrite) {
      const repairedBlock: ChainBlock = {
        ...blockWithoutHash,
        hash: correctHash,
        ...(block.signer ? { signer: block.signer } : {}),
        ...(block.signature ? { signature: block.signature } : {}),
      };

      const target = path.join(chainsDir, file);
      const tmp = `${target}.repair-${process.pid}-${Date.now()}`;
      await fs.writeFile(tmp, `${JSON.stringify(repairedBlock, null, 2)}\n`, 'utf8');
      await fs.rename(tmp, target);
      rewritten++;

      prevHash = correctHash;
    } else {
      prevHash = block.hash;
    }
  }

  return {
    chainName: normalizedName,
    blocksProcessed: blocks.length,
    blocksRewritten: rewritten,
    backupDir: rewritten > 0 ? backupDir : null,
  };
}
