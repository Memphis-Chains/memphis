/**
 * TypeScript wrappers for the `paths_*` NAPI exports added by the
 * `memphis-paths` crate (PR7). Single source of truth for the runtime
 * data layout (data dir / vault state / vault entries / chains dir /
 * embed index / case index / database) shared with the Rust operator.
 *
 * Background: Memphis used to resolve these paths independently in TS
 * (`src/config/paths.ts` + `src/infra/storage/vault-paths.ts`) and Rust
 * (`crates/memphis-operator/src/config.rs` + the band-aid auto-resolver
 * in `runtime.rs:1075-1103`). Operator's 2026-04-29 vault-path-split
 * incident traced to that divergence: `MEMPHIS_VAULT_ENTRIES_PATH`
 * overridden but `MEMPHIS_VAULT_STATE_PATH` left at default, TS saw
 * entries the Rust runtime couldn't decrypt.
 *
 * Contract: every wrapper takes the env map + `process.cwd()`, posts
 * them through the NAPI bridge to the Rust crate, and parses the
 * standard `ApiResult<string>` envelope into either an absolute path
 * string or a thrown Error. Bridge unavailability throws a clear
 * "build the Rust bridge first" message rather than silently falling
 * back to a TS implementation that might disagree with Rust.
 */
import {
  loadPlatformAwareBridge,
  resolveBridgeContract,
  type BridgeAliasMap,
  type BridgeResolution,
} from './napi-contract.js';
import { resolveRustBridgePath } from '../runtime/install-root.js';

const PATHS_BRIDGE_ALIASES = {
  paths_resolve_data_dir: ['paths_resolve_data_dir', 'pathsResolveDataDir'],
  paths_resolve_vault_state: ['paths_resolve_vault_state', 'pathsResolveVaultState'],
  paths_resolve_vault_entries: ['paths_resolve_vault_entries', 'pathsResolveVaultEntries'],
  paths_resolve_chains_dir: ['paths_resolve_chains_dir', 'pathsResolveChainsDir'],
  paths_resolve_chain_path: ['paths_resolve_chain_path', 'pathsResolveChainPath'],
  paths_resolve_embed_index: ['paths_resolve_embed_index', 'pathsResolveEmbedIndex'],
  paths_resolve_case_index: ['paths_resolve_case_index', 'pathsResolveCaseIndex'],
  paths_resolve_database_path: ['paths_resolve_database_path', 'pathsResolveDatabasePath'],
  paths_normalize_chain_name: ['paths_normalize_chain_name', 'pathsNormalizeChainName'],
} satisfies BridgeAliasMap<
  | 'paths_resolve_data_dir'
  | 'paths_resolve_vault_state'
  | 'paths_resolve_vault_entries'
  | 'paths_resolve_chains_dir'
  | 'paths_resolve_chain_path'
  | 'paths_resolve_embed_index'
  | 'paths_resolve_case_index'
  | 'paths_resolve_database_path'
  | 'paths_normalize_chain_name'
>;

type PathsBridgeKey = keyof typeof PATHS_BRIDGE_ALIASES;

interface ResolvedPathsBridge {
  paths_resolve_data_dir?: (envJson: string, cwd: string) => string;
  paths_resolve_vault_state?: (envJson: string, cwd: string) => string;
  paths_resolve_vault_entries?: (envJson: string, cwd: string) => string;
  paths_resolve_chains_dir?: (envJson: string, cwd: string) => string;
  paths_resolve_chain_path?: (envJson: string, cwd: string, chainName: string) => string;
  paths_resolve_embed_index?: (envJson: string, cwd: string) => string;
  paths_resolve_case_index?: (envJson: string, cwd: string) => string;
  paths_resolve_database_path?: (envJson: string, cwd: string) => string;
  paths_normalize_chain_name?: (input: string) => string;
}

let cachedBridge: ResolvedPathsBridge | null = null;
let cachedBridgePath: string | null = null;

function resolvePathsBridge(rawEnv: NodeJS.ProcessEnv): ResolvedPathsBridge {
  const bridgePath = resolveRustBridgePath(rawEnv);
  if (cachedBridge && cachedBridgePath === bridgePath) {
    return cachedBridge;
  }
  const resolution: BridgeResolution<PathsBridgeKey> = resolveBridgeContract(
    loadPlatformAwareBridge(bridgePath),
    PATHS_BRIDGE_ALIASES,
  );
  if (!resolution.bridgeLoaded) {
    throw new Error(
      'memphis-paths bridge not loaded — run `npm run build:rust` to build crates/memphis-napi/index.node ' +
        '(operator runtime ALWAYS has the bridge; this error only fires in tests / dev environments).',
    );
  }
  if (resolution.missing.length > 0) {
    throw new Error(
      `memphis-paths bridge is missing exports: ${resolution.missing.join(', ')}. ` +
        'Rebuild crates/memphis-napi (`npm run build:rust`) — the .node binary is stale.',
    );
  }
  cachedBridge = resolution.resolved as ResolvedPathsBridge;
  cachedBridgePath = bridgePath;
  return cachedBridge;
}

interface ApiResultEnvelope<T> {
  ok: boolean;
  data?: T;
  error?: string;
}

function parseEnvelope(raw: string, exportName: string): string {
  let parsed: ApiResultEnvelope<string>;
  try {
    parsed = JSON.parse(raw) as ApiResultEnvelope<string>;
  } catch (cause) {
    throw new Error(`${exportName}: bridge returned non-JSON envelope: ${String(cause)}`);
  }
  if (!parsed.ok || typeof parsed.data !== 'string') {
    throw new Error(`${exportName}: bridge error — ${parsed.error ?? 'no message'}`);
  }
  return parsed.data;
}

function envJson(rawEnv: NodeJS.ProcessEnv): string {
  // Drop undefined values — the Rust crate expects a `HashMap<String,String>`.
  const filtered: Record<string, string> = {};
  for (const [key, value] of Object.entries(rawEnv)) {
    if (typeof value === 'string') filtered[key] = value;
  }
  return JSON.stringify(filtered);
}

/** Resolves `MEMPHIS_DATA_DIR` (default `~/.memphis`) to an absolute path. */
export function bridgeResolveDataDir(rawEnv: NodeJS.ProcessEnv = process.env): string {
  const bridge = resolvePathsBridge(rawEnv);
  return parseEnvelope(
    bridge.paths_resolve_data_dir!(envJson(rawEnv), process.cwd()),
    'paths_resolve_data_dir',
  );
}

/** Resolves the `vault-state.json` path (`MEMPHIS_VAULT_STATE_PATH` or default). */
export function bridgeResolveVaultState(rawEnv: NodeJS.ProcessEnv = process.env): string {
  const bridge = resolvePathsBridge(rawEnv);
  return parseEnvelope(
    bridge.paths_resolve_vault_state!(envJson(rawEnv), process.cwd()),
    'paths_resolve_vault_state',
  );
}

/** Resolves the `vault-entries.json` path (`MEMPHIS_VAULT_ENTRIES_PATH` or default). */
export function bridgeResolveVaultEntries(rawEnv: NodeJS.ProcessEnv = process.env): string {
  const bridge = resolvePathsBridge(rawEnv);
  return parseEnvelope(
    bridge.paths_resolve_vault_entries!(envJson(rawEnv), process.cwd()),
    'paths_resolve_vault_entries',
  );
}

/** Resolves the canonical chains directory (`<data_dir>/chains`). */
export function bridgeResolveChainsDir(rawEnv: NodeJS.ProcessEnv = process.env): string {
  const bridge = resolvePathsBridge(rawEnv);
  return parseEnvelope(
    bridge.paths_resolve_chains_dir!(envJson(rawEnv), process.cwd()),
    'paths_resolve_chains_dir',
  );
}

/**
 * Resolves a specific chain's directory. Empty / whitespace-only `chainName`
 * collapses to the bare chains dir, matching the Rust crate's contract.
 */
export function bridgeResolveChainPath(
  chainName: string,
  rawEnv: NodeJS.ProcessEnv = process.env,
): string {
  const bridge = resolvePathsBridge(rawEnv);
  return parseEnvelope(
    bridge.paths_resolve_chain_path!(envJson(rawEnv), process.cwd(), chainName),
    'paths_resolve_chain_path',
  );
}

/** Resolves the embed-index path (`RUST_EMBED_PERSIST_PATH` or default). */
export function bridgeResolveEmbedIndex(rawEnv: NodeJS.ProcessEnv = process.env): string {
  const bridge = resolvePathsBridge(rawEnv);
  return parseEnvelope(
    bridge.paths_resolve_embed_index!(envJson(rawEnv), process.cwd()),
    'paths_resolve_embed_index',
  );
}

/** Resolves the case-index SQLite path. */
export function bridgeResolveCaseIndex(rawEnv: NodeJS.ProcessEnv = process.env): string {
  const bridge = resolvePathsBridge(rawEnv);
  return parseEnvelope(
    bridge.paths_resolve_case_index!(envJson(rawEnv), process.cwd()),
    'paths_resolve_case_index',
  );
}

/** Resolves the operator's `DATABASE_URL` to an absolute file path. */
export function bridgeResolveDatabasePath(rawEnv: NodeJS.ProcessEnv = process.env): string {
  const bridge = resolvePathsBridge(rawEnv);
  return parseEnvelope(
    bridge.paths_resolve_database_path!(envJson(rawEnv), process.cwd()),
    'paths_resolve_database_path',
  );
}

/**
 * Normalize a chain name through the Rust alias table. Pure deterministic
 * lookup; cheap to call. Available so TS doesn't drift from Rust by keeping
 * its own table.
 */
export function bridgeNormalizeChainName(input: string): string {
  // Use a minimal env map — this NAPI call doesn't read env at all but the
  // bridge resolver still needs the platform-aware loader to have been hit
  // once. Cached after first call, so cost is ~free thereafter.
  const bridge = resolvePathsBridge(process.env);
  return parseEnvelope(bridge.paths_normalize_chain_name!(input), 'paths_normalize_chain_name');
}

/** Test-only: clear the cached bridge so tests can reload after rebuilds. */
export function __resetPathsBridgeCacheForTests(): void {
  cachedBridge = null;
  cachedBridgePath = null;
}
