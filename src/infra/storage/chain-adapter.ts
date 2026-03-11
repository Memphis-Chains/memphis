import { createRequire } from 'node:module';
import { NapiChainAdapter } from './rust-chain-adapter.js';

export type ChainBackend = 'ts-legacy' | 'rust-napi';

export interface ChainAdapterStatus {
  backend: ChainBackend;
  rustEnabled: boolean;
  rustBridgePath?: string;
  rustBridgeLoaded: boolean;
}

interface RustBridgeLike {
  chain_append?: (chainJson: string, blockJson: string) => string;
  chain_validate?: (blockJson: string, prevJson?: string) => string;
  chain_query?: (chainJson: string, contains?: string, tag?: string) => string;
}

function parseBool(v: string | undefined, fallback = false): boolean {
  if (typeof v !== 'string') return fallback;
  return v.toLowerCase() === 'true';
}

function getRustBridgePath(rawEnv: NodeJS.ProcessEnv): string {
  return rawEnv.RUST_CHAIN_BRIDGE_PATH ?? './crates/memphis-napi';
}

function tryLoadRustBridge(rustBridgePath: string): RustBridgeLike | null {
  try {
    // Dynamic load to keep default path non-breaking when rust bridge is absent.
    const req = createRequire(`${process.cwd()}/`);
    const mod = req(rustBridgePath) as RustBridgeLike;
    return mod;
  } catch {
    return null;
  }
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

  const bridge = tryLoadRustBridge(rustBridgePath);
  if (!bridge) {
    return {
      backend: 'ts-legacy',
      rustEnabled,
      rustBridgePath,
      rustBridgeLoaded: false,
    };
  }

  const hasCoreFns =
    typeof bridge.chain_append === 'function' &&
    typeof bridge.chain_validate === 'function' &&
    typeof bridge.chain_query === 'function';

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

interface ChainBlock {
  index: number;
  timestamp: string;
  chain: string;
  data: Record<string, unknown>;
  prev_hash: string;
  hash: string;
}

export async function appendBlock(
  chainName: string,
  data: Record<string, unknown>,
  rawEnv: NodeJS.ProcessEnv = process.env,
): Promise<AppendBlockResult> {
  const status = getChainAdapterStatus(rawEnv);

  if (status.backend === 'rust-napi') {
    try {
      const adapter = new NapiChainAdapter(rawEnv);
      return await adapter.appendBlock(chainName, data);
    } catch (error) {
      throw new Error(`rust chain append failed: ${String(error)}`, { cause: error });
    }
  }

  // Legacy fallback: write directly to ~/.memphis/chains/{chain}/
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  const os = await import('node:os');
  const crypto = await import('node:crypto');

  const chainsDir = resolveChainDir(chainName, {
    homedir: os.homedir(),
    resolve: path.resolve,
    sep: path.sep,
  });
  await fs.mkdir(chainsDir, { recursive: true });

  const blocks = await readAndValidateChainBlocks(chainsDir, fs, crypto);
  const previousBlock = blocks.at(-1);
  const nextIndex = previousBlock ? previousBlock.index + 1 : 1;

  const timestamp = new Date().toISOString();
  const blockWithoutHash = {
    index: nextIndex,
    timestamp,
    chain: chainName,
    data,
    prev_hash: previousBlock?.hash ?? GENESIS_PREV_HASH,
  };
  const block: ChainBlock = {
    ...blockWithoutHash,
    hash: hashBlock(blockWithoutHash, crypto),
  };

  const filename = path.join(chainsDir, `${String(nextIndex).padStart(6, '0')}.json`);
  await fs.writeFile(filename, JSON.stringify(block, null, 2), 'utf8');

  return {
    index: nextIndex,
    hash: block.hash,
    chain: chainName,
    timestamp,
  };
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

  const normalized = chainName.trim();
  if (!SAFE_CHAIN_NAME.test(normalized)) {
    throw new Error('invalid chain name');
  }

  const baseDir = deps.resolve(deps.homedir, '.memphis', 'chains');
  const targetDir = deps.resolve(baseDir, normalized);
  if (targetDir !== baseDir && !targetDir.startsWith(`${baseDir}${deps.sep}`)) {
    throw new Error('invalid chain name');
  }

  return targetDir;
}

function hashBlock(
  block: Omit<ChainBlock, 'hash'>,
  crypto: typeof import('node:crypto'),
): string {
  const canonical = stableStringify(block);
  return crypto.createHash('sha256').update(canonical).digest('hex');
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

  const last = await readBlockFile(`${chainsDir}/${indexed[indexed.length - 1]!.file}`, indexed[indexed.length - 1]!.file, fs);
  validateBlockHash(last, crypto, indexed[indexed.length - 1]!.file);

  if (last.prev_hash !== '' && last.index > 1) {
    const previousEntry = indexed.find((entry) => entry.index === last.index - 1);
    if (!previousEntry) {
      throw new Error(`chain integrity check failed for ${indexed[indexed.length - 1]!.file}: missing previous block`);
    }
    const previous = await readBlockFile(`${chainsDir}/${previousEntry.file}`, previousEntry.file, fs);
    validateBlockHash(previous, crypto, previousEntry.file);
    if (last.prev_hash !== previous.hash) {
      throw new Error(`chain integrity check failed for ${indexed[indexed.length - 1]!.file}: prev_hash mismatch`);
    }
  }

  return [last];
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

function validateBlockHash(block: ChainBlock, crypto: typeof import('node:crypto'), file: string): void {
  const expectedHash = hashBlock(
    {
      index: block.index,
      timestamp: block.timestamp,
      chain: block.chain,
      data: block.data,
      prev_hash: block.prev_hash,
    },
    crypto,
  );
  const legacyHash = crypto.createHash('sha256').update(JSON.stringify(block.data)).digest('hex');

  if (block.hash !== expectedHash && block.hash !== legacyHash) {
    throw new Error(`chain integrity check failed for ${file}: hash mismatch`);
  }

  if (block.index === 1 && block.prev_hash !== '' && block.prev_hash !== GENESIS_PREV_HASH) {
    throw new Error(`chain integrity check failed for ${file}: prev_hash mismatch`);
  }
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

  return block as ChainBlock;
}

function stableStringify(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function parseJsonObject(raw: string, file: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    const first = raw.indexOf('{');
    const last = raw.lastIndexOf('}');
    if (first >= 0 && last > first) {
      return JSON.parse(raw.slice(first, last + 1));
    }
    throw new Error(`chain integrity check failed for ${file}: invalid json`);
  }
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sortValue(item));
  }

  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
    return Object.fromEntries(entries.map(([key, nested]) => [key, sortValue(nested)]));
  }

  return value;
}
