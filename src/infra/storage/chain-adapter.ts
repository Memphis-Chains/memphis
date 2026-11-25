/* eslint-disable no-restricted-syntax */
//
// Config-source / threading file — reads process.env directly for
// dynamic-key operations or to pass rawEnv into typed helpers that
// themselves use env-registry. Per Sprint ι policy, file-level
// disable instead of accessor-bloat.
//
import * as chainCrypto from 'node:crypto';
import { lstatSync, readdirSync } from 'node:fs';

import { serializeBlockForDisk, writeBlockAtomic } from './chain-file-io.js';
import {
  isValidChainStart,
  readChainRotationHead,
  ROTATION_HEAD_FILENAME,
} from './chain-rotation-head.js';
import { assertChainWriteAllowed } from './chain-write-guard.js';
import { withChainWriteLock } from './chain-write-lock.js';
import {
  hasRequiredBridgeExports,
  loadPlatformAwareBridge,
  resolveBridgeContract,
  type BridgeAliasMap,
} from './napi-contract.js';
import { NapiChainAdapter } from './rust-chain-adapter.js';
import { getChainPath, getDataDir, normalizeChainName } from '../../config/paths.js';
import { normalizeBlockPayload } from '../../core/block-payload.js';
import { canonicalHash } from '../../core/chain-hash.js';
import { parseBool } from '../../core/env.js';
import { stableStringify } from '../../core/stable-stringify.js';
import {
  isChainBackupDirectory,
  isKnownChainName,
  logicalChainNameForDirectory,
  SAFE_CHAIN_NAME,
} from '../../memory/chain-catalog.js';
import { assertAuditWriteAllowed } from '../logging/audit-write-guard.js';
import { resolveRustBridgePath } from '../runtime/install-root.js';

// Chains that count as audit/system surfaces. Writes to these from a
// VITEST process must opt in via MEMPHIS_TEST_ALLOW_AUDIT_WRITE=1 or
// they're refused (Block 1853 incident, 2026-05-12). Other chains
// (journal, case, decisions, etc.) are unguarded HERE — but they are
// still covered by the path-level guard in chain-write-guard.ts, which
// refuses any VITEST write that resolves outside the OS temp dir. The
// 2026-10-24 journal pollution came from exactly that gap: a test
// called the real appendBlock with a rawEnv that omitted
// MEMPHIS_DATA_DIR, so the write landed in the operator's live
// ~/.memphis chain.
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
/**
 * The shape of a chain directory name.
 *
 * Re-exported from the registry (src/memory/chain-catalog.ts), which
 * owns it — this module used to carry a copy of its own, and the two
 * copies disagreed about the archives (see `isScannableChainDirectoryName`).
 */
export { SAFE_CHAIN_NAME };

/**
 * A chain directory the verifier may open.
 *
 * A plain chain (`journal`) OR an archive of one (`journal.backup-…`).
 *
 * The archive shape used to be unreachable: the allowlist carried three
 * frozen backup directories, but `SAFE_CHAIN_NAME` has no dot in it, so
 * the scanner filtered them out and `chain verify --chain
 * journal.backup-1784913076785` answered `ok: true` after checking
 * NOTHING. Measured on this host: three allowlisted archives, zero of
 * them openable, and a backup the operator had explicitly listed.
 *
 * The rule that decides it is the catalog's, not a second list here:
 * a directory is a chain when the chain it holds is named by the
 * taxonomy (see `deriveChainRegistry`).
 */
export function isScannableChainDirectoryName(name: string): boolean {
  return SAFE_CHAIN_NAME.test(name) || isChainBackupDirectory(name);
}

/**
 * The registry: every chain directory on disk that holds a chain the
 * taxonomy names.
 *
 * This is the ONE place the chain list is decided. It used to be a
 * hand-maintained constant (`DEFAULT_CHAIN_ALLOWLIST`) that had to be
 * edited every time a chain appeared — and that was edited wrong: it
 * carried three archives the scanner could not open, and it said nothing
 * about the chains that were actually on the disk.
 *
 * Derivation, in order:
 *   1. a directory whose name is a chain the taxonomy names;
 *   2. an archive of such a chain (`journal.backup-…` → `journal`).
 *
 * A directory that is not a chain — the quarantine container, a
 * sidecar writer's dump — is not in the registry. It is reported by
 * the audit, but it is not a chain and the verifier must not open it.
 */
export function deriveChainRegistry(rawEnv: NodeJS.ProcessEnv = process.env): ReadonlySet<string> {
  const chainsDir = getChainPath(undefined, rawEnv);
  const registry = new Set<string>();
  let entries: { name: string; isDirectory: boolean }[] = [];
  try {
    entries = readdirSync(chainsDir, { withFileTypes: true }).map((entry) => ({
      name: entry.name,
      isDirectory: entry.isDirectory(),
    }));
  } catch {
    return registry;
  }

  for (const entry of entries) {
    if (!entry.isDirectory) continue;
    if (!isScannableChainDirectoryName(entry.name)) continue;
    const logical = logicalChainNameForDirectory(entry.name);
    if (!isKnownChainName(logical)) continue;
    registry.add(entry.name);
  }
  return registry;
}

/**
 * The allowlist in force: the registry, narrowed by the live config.
 *
 * The config may only NARROW the registry. It may not invent a chain
 * the registry does not name — that was the old behaviour (the config
 * REPLACED the code default), which is how a forgotten chain became a
 * silent skip and why an operator had to hand-edit the list at all.
 *
 * Exported for the runtime audit: it has to compare the registry, the
 * config and what is actually scanned, and the whole point is that it
 * must not keep its own copy of any of them.
 */
export function getChainAllowlist(rawEnv: NodeJS.ProcessEnv = process.env): ReadonlySet<string> {
  const registry = deriveChainRegistry(rawEnv);
  const explicit = rawEnv.MEMPHIS_CHAINS_ALLOWLIST;
  if (explicit === undefined || explicit === '') return registry;

  const narrowed = new Set<string>();
  for (const name of explicit
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)) {
    if (registry.has(name)) narrowed.add(name);
  }
  return narrowed;
}

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

export interface ChainExportEnvelope {
  chainName: string;
  exportedAt: string;
  blockCount: number;
  blocks: ChainBlock[];
}

/** Validate a complete immutable snapshot without rewriting indices or hashes. */
export function validateChainSnapshot(chainName: string, candidates: unknown[]): ChainBlock[] {
  if (!SAFE_CHAIN_NAME.test(chainName)) throw new Error('Invalid snapshot chain');
  const blocks: ChainBlock[] = [];
  for (const candidate of candidates) {
    const block = toChainBlock(candidate as Partial<ChainBlock>, 'snapshot');
    if (
      block.chain !== chainName ||
      !Number.isSafeInteger(block.index) ||
      block.index < 0 ||
      !Number.isFinite(Date.parse(block.timestamp)) ||
      !/^[a-f0-9]{64}$/.test(block.hash)
    )
      throw new Error('Invalid snapshot block');
    const previous = blocks.at(-1);
    if (
      previous
        ? block.index !== previous.index + 1 || block.prev_hash !== previous.hash
        : ![0, 1].includes(block.index) ||
          (block.prev_hash !== GENESIS_PREV_HASH && !(block.index === 1 && block.prev_hash === ''))
    )
      throw new Error('Snapshot continuity mismatch');
    if (checkBlockHashMismatch(block, chainCrypto, 'snapshot'))
      throw new Error('Snapshot block hash mismatch');
    if (block.signer !== undefined || block.signature !== undefined) {
      if (
        !/^[a-f0-9]{64}$/.test(block.signer ?? '') ||
        !/^[a-f0-9]{128}$/.test(block.signature ?? '')
      )
        throw new Error('Invalid snapshot block signature');
      const key = chainCrypto.createPublicKey({
        key: Buffer.concat([
          Buffer.from('302a300506032b6570032100', 'hex'),
          Buffer.from(block.signer!, 'hex'),
        ]),
        format: 'der',
        type: 'spki',
      });
      if (
        !chainCrypto.verify(
          null,
          Buffer.from(block.hash),
          key,
          Buffer.from(block.signature!, 'hex'),
        )
      )
        throw new Error('Invalid snapshot block signature');
    }
    blocks.push(block);
  }
  return blocks;
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
function isConfigBlock(
  data: Record<string, unknown>,
): data is { type: string; key?: string; value?: string; kind?: string } {
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
  // Capture the block before waiting for a lock, as the old append path did.
  const normalizedData = normalizeBlockPayload(data);
  const result = await appendBlockConditionalInternal(chainName, async () => ({ data: normalizedData, value: undefined }), rawEnv, false);
  if (!result.block) throw new Error('chain append unexpectedly skipped');
  return result.block;
}

/** Decide and append while holding the writer lock; no callback may prompt for input. */
export async function appendBlockConditional<T>(
  chainName: string,
  decide: () => Promise<{ data?: Record<string, unknown>; value: T }>,
  rawEnv: NodeJS.ProcessEnv = process.env,
): Promise<{ value: T; block?: AppendBlockResult }> {
  return appendBlockConditionalInternal(chainName, decide, rawEnv, true);
}

async function appendBlockConditionalInternal<T>(
  chainName: string,
  decide: () => Promise<{ data?: Record<string, unknown>; value: T }>,
  rawEnv: NodeJS.ProcessEnv,
  preflight: boolean,
): Promise<{ value: T; block?: AppendBlockResult }> {
  rawEnv = { ...rawEnv };
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
      if (!preflight) {
        const decision = await decide();
        if (!decision.data) return { value: decision.value };
        return { value: decision.value, block: await adapter.appendBlock(normalizedChainName, normalizeBlockPayload(decision.data)) };
      }
      return await adapter.appendBlockConditional(normalizedChainName, async () => {
        const decision = await decide();
        return { ...decision, data: decision.data ? normalizeBlockPayload(decision.data) : undefined };
      });
    } catch (error) {
      throw new Error(`rust chain append failed: ${String(error)}`, { cause: error });
    }
  }

  // Legacy fallback: write directly to the configured chains directory.
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  const os = await import('node:os');
  const crypto = await import('node:crypto');

  const chainsDir = resolveChainDir(
    normalizedChainName,
    {
      homedir: os.homedir(),
      resolve: path.resolve,
      sep: path.sep,
    },
    rawEnv,
  );
  assertChainWriteAllowed(chainsDir, rawEnv);
  await fs.mkdir(chainsDir, { recursive: true });

  return withAppendLock(chainsDir, fs, path, async () => {
    if (!preflight) await pruneTrailingEmptyBlockFiles(chainsDir, fs, path);
    const blocks = await readAndValidateChainBlocks(chainsDir, fs, crypto, rawEnv, {
      repairOnMismatch: !preflight,
    });
    const decision = await decide();
    if (!decision.data) return { value: decision.value };
    const normalizedData = normalizeBlockPayload(decision.data);
    const previousBlock = blocks.at(-1);
    const nextIndex = previousBlock ? previousBlock.index + 1 : 1;

    const timestamp = new Date().toISOString();
    const blockWithoutHash = {
      index: nextIndex,
      timestamp,
      chain: normalizedChainName,
      data: normalizedData,
      prev_hash: previousBlock?.hash ?? GENESIS_PREV_HASH,
    };
    const block: ChainBlock = {
      ...blockWithoutHash,
      hash: hashBlock(blockWithoutHash, crypto),
    };

    // Publish without replacing a committed block, even if index allocation
    // was wrong or another writer ignored the lock.
    await writeBlockAtomic(chainsDir, nextIndex, serializeBlockForDisk(block));

    return { value: decision.value, block: {
      index: nextIndex,
      hash: block.hash,
      chain: normalizedChainName,
      timestamp,
    } };
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
  const rawEnv = _rawEnv ?? process.env;

  const chainsDir = resolveChainDir(
    normalizedChainName,
    {
      homedir: (await import('node:os')).homedir(),
      resolve: path.resolve,
      sep: path.sep,
    },
    rawEnv,
  );

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

  await writeBlockAtomic(chainsDir, block.index, serializeBlockForDisk(chainBlock));

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
  rawEnv: NodeJS.ProcessEnv = process.env,
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

  const baseDir = deps.resolve(getChainPath(undefined, rawEnv));
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
  // The canonical hash has ONE implementation: `core/chain-hash.ts`.
  //
  // This function used to carry its own copy of the canonical shape, and
  // it did not agree with the repair path in `infra/runtime/chain-canonical.ts`:
  // the copy here fell back `type` -> `journal` while the repair path fell
  // back `type` -> `block_type` -> `journal`, exactly like the native core.
  // A block carrying only `block_type` was therefore hashed two different
  // ways by two writers of the same chain.
  //
  // Measured on this host: 0 of 27 159 blocks on disk carry `block_type`
  // without `type`, so the disagreement never bit. It is still the shape of
  // bug this repository keeps hitting, and the fix is one line.
  return canonicalHash(block, crypto);
}

/**
 * The identity every block of a chain directory must carry.
 *
 * A chain's identity is its LOGICAL name — an archive's `.backup-<stamp>`
 * suffix is a COPY marker, not part of the chain's name — put through the
 * alias table, because a directory named `case` holds the chain `cases`.
 *
 * The rule is the owner's own (`memory/chain-catalog.ts`, projected from the
 * Rust core): _"the blocks inside it carry `chain: "journal"`, and that is
 * what the hash chain was built over. Reading the directory name as the
 * chain name is how a repair would rewrite every archived block's `chain`
 * field and invalidate the archive's hashes."_
 *
 * It matters because the identity is INSIDE the hash: a block that carries
 * the wrong one hashes consistently over the wrong value, so every hash
 * check passes and the copy verifies clean while being a different history
 * of the same blocks.
 */
export function expectedChainIdentity(directoryName: string): string {
  const logical = logicalChainNameForDirectory(directoryName);
  return normalizeChainName(logical) ?? logical;
}

async function readAndValidateChainBlocks(
  chainsDir: string,
  fs: typeof import('node:fs/promises'),
  crypto: typeof import('node:crypto'),
  rawEnv: NodeJS.ProcessEnv = process.env,
  options: { repairOnMismatch?: boolean } = {},
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
  // The chain's IDENTITY is part of every block's hashed content, so a
  // block that carries the wrong one hashes consistently OVER the wrong
  // value — the hash check below cannot see it. Measured on this host
  // (2026-11-25): the archive `system.backup-1782897312539` carried its own
  // DIRECTORY name in all 261 of its blocks, every hash was self-consistent,
  // and `chain verify` answered `ok: true`. The copy verified clean and could
  // not be rolled back: its last block no longer seamed with the rotation
  // archive that holds the blocks after it.
  const expectedIdentity = expectedChainIdentity(chainName);
  const formatHashFingerprint = (hash: string | undefined): string => {
    if (!hash) return '<empty>';
    return hash.length > 12 ? `${hash.slice(0, 8)}…${hash.slice(-4)}` : hash;
  };
  for (const { file, block: current } of loaded) {
    if (current.chain !== expectedIdentity) {
      throw new Error(
        `chain '${chainName}' integrity check failed at block ${current.index} (${file}): ` +
          `chain field '${current.chain}' ≠ expected '${expectedIdentity}'. ` +
          `A chain's identity is its LOGICAL name — an archive carries the chain it copies, not its own directory name — ` +
          `and the identity sits inside the hash, so a copy that carries the wrong one is a DIFFERENT history of the same blocks. ` +
          `Run \`memphis chain repair-archive-identity --chain ${chainName}\` to restore the copy's identity, ` +
          `or \`memphis chain verify --chain ${chainName}\` to see it again.`,
      );
    }
    const mismatch = checkBlockHashMismatch(current, crypto, file);
    if (mismatch?.mismatch) {
      if (options.repairOnMismatch === true && isChainRepairEnabled(rawEnv)) {
        await repairBlockHash(current, file, chainsDir, crypto, fs, rawEnv);
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
      // The chain may CONTINUE an archived prefix instead of starting at
      // genesis. Rotation archives the old blocks and leaves a marker
      // with the head of the archive; the first live block then links to
      // that head, and the chain's history stays provable.
      //
      // Without this the validators rejected every rotated chain with
      // "missing genesis block", which is why rotation was never
      // enabled. See `src/infra/storage/chain-rotation-head.ts`.
      const head = await readChainRotationHead(chainsDir);
      if (isValidChainStart(head, current.index, current.prev_hash)) {
        blocks.push(current);
        continue;
      }
      // Accept index 0 or 1 as valid genesis (Rust uses index 0, TS uses index 1)
      if (current.index !== 0 && current.index !== 1) {
        throw new Error(
          `chain '${chainName}' integrity check failed at block ${current.index} (${file}): ` +
            `missing genesis block (chain must start at index 0 or 1` +
            (head
              ? `, or continue the archived prefix recorded in ${ROTATION_HEAD_FILENAME}`
              : '') +
            `)`,
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

function isChainRepairEnabled(rawEnv: NodeJS.ProcessEnv = process.env): boolean {
  return parseBool(rawEnv.MEMPHIS_CHAIN_REPAIR_ON_MISMATCH, false);
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

  // There used to be a THIRD formula here, called `rustCompatHash`: the
  // canonical payload built inline, with its own copy of the three-field
  // projection. It was byte-identical to `expectedHash` for every input --
  // the same five top-level keys, the same three data fields, the same
  // sorted-key serialisation -- so the branch could never accept a block
  // that the first comparison had rejected. It was dead code that looked
  // like a compatibility layer, and it was a third place to change the
  // hash. It is gone.

  if (block.hash === expectedHash || block.hash === legacyStableHash) {
    // Canonical or legacy hash matches — pass
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
  rawEnv: NodeJS.ProcessEnv = process.env,
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
  await fs.writeFile(tmpFilename, serializeBlockForDisk(repairedBlock), 'utf8');
  await fs.rename(tmpFilename, filename);

  // Append repair audit block
  await appendBlock(
    'system',
    {
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
    },
    rawEnv,
  );
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
  const crypto = await import('node:crypto');
  const rawEnv = _rawEnv ?? process.env;

  const baseDir = path.resolve(getChainPath(undefined, rawEnv));
  const allowlist = getChainAllowlist(rawEnv);
  const allDirs = (await fs.readdir(baseDir).catch(() => [])).filter((name) =>
    isScannableChainDirectoryName(name),
  );
  const selectedChains = chainName
    ? [normalizeChainName(chainName) ?? chainName]
    : allDirs.filter((name) => allowlist.has(name));
  // A caller may pass a chain name that came from a directory listing (the
  // backup drill does exactly that). Names outside the safe shape — a
  // rebuild-hashes backup directory like `journal.backup-1792925651264` —
  // are skipped instead of aborting the whole verification. Throwing here
  // made every scheduled backup report "restore-drill FAILED — invalid
  // chain name" while the archive itself was complete and correct.
  //
  // An archive IS scannable: it holds the same blocks a chain holds, and
  // the operator listed those archives in the allowlist precisely because
  // they want them verified. Skipping them is what made
  // `chain verify --chain journal.backup-…` answer `ok: true` after
  // checking nothing at all.
  const unsafeChains = selectedChains.filter((name) => !isScannableChainDirectoryName(name));
  // Only recognized recovery directories are optional. Invalid explicit chain
  // names must still fail instead of reporting success after checking nothing.
  if (unsafeChains.some((name) => !isChainBackupDirectory(name))) {
    throw new Error('invalid chain name');
  }
  const safeChains = selectedChains.filter((name) => isScannableChainDirectoryName(name));
  if (unsafeChains.length > 0) {
    console.warn(
      `[chain-adapter] skipping ${unsafeChains.length} chain dir(s) with unsafe names under ${baseDir}: ${unsafeChains.join(', ')}.`,
    );
  }
  const skipped = chainName ? [] : allDirs.filter((name) => !allowlist.has(name));
  if (skipped.length > 0) {
    // Non-fatal: sidecar writers (halt-aware audit, log dumps, …)
    // sometimes leave directories here that aren't real chains.
    // List them once so an operator can spot a misconfigured writer.
    console.warn(
      `[chain-adapter] skipping ${skipped.length} non-allowlisted chain dir(s) under ${baseDir}: ${skipped.join(', ')}. Set MEMPHIS_CHAINS_ALLOWLIST to scan explicitly.`,
    );
  }

  let chainsChecked = 0;
  let blockCount = 0;

  for (const chain of safeChains) {
    const normalizedChain = normalizeChainName(chain) ?? chain;
    if (!isScannableChainDirectoryName(normalizedChain)) {
      throw new Error('invalid chain name');
    }
    const chainsDir = path.resolve(getChainPath(normalizedChain, rawEnv));
    if (chainsDir !== baseDir && !chainsDir.startsWith(`${baseDir}${path.sep}`)) {
      throw new Error('invalid chain name');
    }

    // A named chain that is not there is a chain that was not checked.
    // Saying "ok: true" for it is the shape of lie this stage removes:
    // the verifier used to answer exactly that for every archive it
    // could not open.
    if (!(await fs.stat(chainsDir).catch(() => null))) {
      throw new Error(`chain not found: ${chain}`);
    }

    const blocks = await readAndValidateChainBlocks(chainsDir, fs, crypto, rawEnv);
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

  const blocks = await readAndValidateChainBlocks(chainsDir, fs, crypto, rawEnv);
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

export async function withAppendLock<T>(
  chainsDir: string,
  _fs: typeof import('node:fs/promises'),
  _path: typeof import('node:path'),
  fn: () => Promise<T>,
): Promise<T> {
  return withChainWriteLock(chainsDir, fn);
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
  const crypto = await import('node:crypto');
  const rawEnv = _rawEnv ?? process.env;

  const normalizedName = normalizeChainName(chainName) ?? chainName;
  const chainsDir = getChainPath(normalizedName, rawEnv);

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
      await fs.writeFile(tmp, `${serializeBlockForDisk(repairedBlock)}\n`, 'utf8');
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

/**
 * The result of restoring an archive's chain identity.
 *
 * `blocksRewritten` counts the blocks whose bytes changed — the identity is
 * inside the hash, so a copy that carries the wrong one needs every block
 * rewritten, not just the first.
 */
export interface ChainArchiveIdentityRepairResult {
  archive: string;
  chain: string;
  archivePath: string;
  blocksProcessed: number;
  blocksRewritten: number;
  backupPath: string | null;
  firstIndex: number | null;
  lastIndex: number | null;
}

/**
 * Restore the chain identity of a ROLLBACK COPY that carries the wrong one.
 *
 * The archive of a chain holds the chain's blocks, so the blocks carry the
 * chain's LOGICAL name — never the archive's own directory name. When they
 * carry the directory name instead, the copy is not a copy: it is a
 * different history of the same blocks, because the identity is inside the
 * hash. Measured on this host (2026-11-25) on the archive
 * `system.backup-1782897312539`: all 261 blocks carried the directory name,
 * every hash was self-consistent, `chain verify` answered `ok: true`, and
 * the copy's last block no longer seamed with the rotation archive that
 * holds the blocks after it — so the copy could not be rolled back and
 * nothing said so.
 *
 * This restores it: the identity goes back to the chain's logical name and
 * the hash chain is recomputed over it. The blocks' DATA is never touched,
 * and the pre-repair copy is kept under the data dir's `backups/` before
 * the first byte is written.
 *
 * It refuses anything that is not an archive directory — a LIVE chain's
 * identity is its own name, and a live chain whose blocks disagree with it
 * is a different problem with a different tool.
 */
export async function repairArchiveIdentity(
  archiveName: string,
  rawEnv: NodeJS.ProcessEnv = process.env,
): Promise<ChainArchiveIdentityRepairResult> {
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  const crypto = await import('node:crypto');

  const trimmed = archiveName.trim();
  if (!isChainBackupDirectory(trimmed)) {
    throw new Error(
      `chain archive identity repair refused: '${trimmed}' is not an archive directory ` +
        `(an archive is '<chain>.backup-<stamp>'). This repair exists for a COPY that carries the wrong chain identity.`,
    );
  }

  const identity = expectedChainIdentity(trimmed);
  const baseDir = path.resolve(getChainPath(undefined, rawEnv));
  const archivePath = path.resolve(getChainPath(trimmed, rawEnv));
  if (!archivePath.startsWith(`${baseDir}${path.sep}`)) {
    throw new Error(
      'chain archive identity repair refused: the archive is outside the chains directory',
    );
  }

  const files = (await fs.readdir(archivePath)).filter((file) => file.endsWith('.json')).sort();
  const loaded: { file: string; block: ChainBlock }[] = [];
  for (const file of files) {
    const parsed = JSON.parse(
      await fs.readFile(path.join(archivePath, file), 'utf8'),
    ) as ChainBlock;
    loaded.push({ file, block: parsed });
  }
  loaded.sort((a, b) => a.block.index - b.block.index);
  const blocks = loaded.map((entry) => entry.block);

  const backupPath = await backUpArchiveDirectory(archivePath, trimmed, rawEnv);

  let rewritten = 0;
  let prevHash = GENESIS_PREV_HASH;
  for (const { file, block } of loaded) {
    const withoutHash = {
      index: block.index,
      timestamp: block.timestamp,
      chain: identity,
      data: block.data,
      prev_hash: prevHash,
    };
    const correctHash = hashBlock(withoutHash, crypto);
    const needsRewrite =
      block.hash !== correctHash || block.prev_hash !== prevHash || block.chain !== identity;

    if (needsRewrite) {
      const repaired: ChainBlock = {
        ...withoutHash,
        hash: correctHash,
        ...(block.signer ? { signer: block.signer } : {}),
        ...(block.signature ? { signature: block.signature } : {}),
      };
      const target = path.join(archivePath, file);
      const tmp = `${target}.identity-repair-${process.pid}-${Date.now()}`;
      await fs.writeFile(tmp, `${serializeBlockForDisk(repaired)}\n`, 'utf8');
      await fs.rename(tmp, target);
      rewritten += 1;
    }

    // The next block links to THIS block's hash — the repaired one when it
    // changed, the stored one when it did not. They are the same value when
    // nothing changed, because that is what "did not change" means.
    prevHash = correctHash;
  }

  return {
    archive: trimmed,
    chain: identity,
    archivePath,
    blocksProcessed: blocks.length,
    blocksRewritten: rewritten,
    backupPath,
    firstIndex: blocks[0]?.index ?? null,
    lastIndex: blocks.at(-1)?.index ?? null,
  };
}

/**
 * Copy an archive directory aside before it is rewritten.
 *
 * The copy lives under the data dir's `backups/`, NOT under `chains/` —
 * a directory under `chains/` is either a chain or an archive, and a third
 * kind of thing there is a thing every chain scan has to learn about.
 */
async function backUpArchiveDirectory(
  archivePath: string,
  archiveName: string,
  rawEnv: NodeJS.ProcessEnv,
): Promise<string | null> {
  const fs = await import('node:fs/promises');
  const path = await import('node:path');

  const backupsDir = path.join(getDataDir(rawEnv), 'backups');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const destination = path.join(backupsDir, `archive-identity-repair-${archiveName}-${stamp}`);

  try {
    await fs.mkdir(backupsDir, { recursive: true });
    await fs.cp(archivePath, destination, { recursive: true });
    return destination;
  } catch {
    // A missing backup is not a reason to refuse the repair — the repair
    // itself is what restores a COPY. But the caller must be able to see
    // that it happened without one, so the null is reported rather than
    // swallowed.
    return null;
  }
}
