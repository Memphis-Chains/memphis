import { createRequire } from 'node:module';

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

export async function appendBlock(
  chainName: string,
  data: Record<string, unknown>,
  rawEnv: NodeJS.ProcessEnv = process.env,
): Promise<AppendBlockResult> {
  const status = getChainAdapterStatus(rawEnv);

  if (status.backend === 'ts-legacy') {
    // Legacy fallback: write directly to ~/.memphis/chains/{chain}/
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const os = await import('node:os');
    const crypto = await import('node:crypto');

    const chainsDir = path.join(os.homedir(), '.memphis', 'chains', chainName);
    await fs.mkdir(chainsDir, { recursive: true });

    // Find next index
    const files = await fs.readdir(chainsDir);
    const indices = files
      .filter(f => f.endsWith('.json'))
      .map(f => parseInt(f.replace('.json', ''), 10))
      .filter(n => !Number.isNaN(n));
    const nextIndex = indices.length > 0 ? Math.max(...indices) + 1 : 1;

    const timestamp = new Date().toISOString();
    const block = {
      index: nextIndex,
      timestamp,
      chain: chainName,
      data,
      prev_hash: '', // TODO: read previous block hash
      hash: crypto.createHash('sha256').update(JSON.stringify(data)).digest('hex'),
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

  // Rust NAPI bridge
  const bridge = tryLoadRustBridge(status.rustBridgePath!);
  if (!bridge || !bridge.chain_append) {
    throw new Error('Rust bridge not available');
  }

  const result = JSON.parse(bridge.chain_append(JSON.stringify({ chain: chainName }), JSON.stringify(data)));
  return {
    index: result.index,
    hash: result.hash,
    chain: chainName,
    timestamp: result.timestamp,
  };
}
