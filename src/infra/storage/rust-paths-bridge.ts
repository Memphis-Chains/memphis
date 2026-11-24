/**
 * Rust paths bridge — TS-side wrapper for `crates/memphis-paths` (Sprint B).
 *
 * The Rust crate `memphis-paths` is the single source of truth for
 * Memphis runtime path resolution. This module is the TS-side caller
 * that funnels every TS site through the same crate via NAPI, so the
 * "TS sees `~/.memphis`, Rust sees `./data/`" silent-split bug class
 * (operator-incident 2026-04-29) cannot recur.
 *
 * The bridge resolution layer (`napi-contract.ts`) is reused as-is so
 * we get the same alias/missing-export behavior other adapters rely
 * on. The bridge module is loaded lazily on first call and cached, so
 * a tsx-spawned ops script that exits before any path lookup pays
 * zero overhead.
 *
 * Failure mode: if the bridge can't be loaded (operator on a triple
 * we don't ship + build-from-source skipped), the wrappers throw a
 * loud error rather than fall back to the legacy TS computation.
 * Falling back was the source of the silent-split bug — keeping a
 * fallback would defeat the point of the migration.
 */

import { callBridge as callBridgeEnvelope } from './bridge-envelope.js';
import { BRIDGE_EXPORT_ALIASES } from './bridge-exports.generated.js';
import {
  loadPlatformAwareBridge,
  resolveBridgeContract,
  type BridgeAliasMap,
  type BridgeResolution,
} from './napi-contract.js';
import { bridgeBinaryPath, envToJson, pathResolutionBase } from './rust-bridge-host.js';

type PathsBridgeKey =
  | 'paths_resolve_data_dir'
  | 'paths_resolve_chains_dir'
  | 'paths_resolve_chain_path'
  | 'paths_normalize_chain_name';

/**
 * The paths' spellings come from the GENERATED vocabulary.
 *
 * They used to be written out here — a hand-written copy of four entries of
 * the bridge's export map, which is itself generated from the Rust core and
 * checked against the built binary. The copy listed the spelling the binary
 * does NOT have first, so every call recorded a "legacy alias used" that
 * was not legacy at all.
 */
const PATHS_BRIDGE_ALIASES = {
  paths_resolve_data_dir: BRIDGE_EXPORT_ALIASES.paths_resolve_data_dir,
  paths_resolve_chains_dir: BRIDGE_EXPORT_ALIASES.paths_resolve_chains_dir,
  paths_resolve_chain_path: BRIDGE_EXPORT_ALIASES.paths_resolve_chain_path,
  paths_normalize_chain_name: BRIDGE_EXPORT_ALIASES.paths_normalize_chain_name,
} as const satisfies BridgeAliasMap<PathsBridgeKey>;

// Cache the resolved bridge by its computed binary path. Codex R5
// #436 caught that a single global cache locked in the FIRST resolved
// path forever — but `getDataDir()` is called at module-import time
// in `src/config/index.ts:16`, often BEFORE `.env` loads
// `RUST_CHAIN_BRIDGE_PATH`. Once the operator's `.env` is read, the
// override needs to take effect on subsequent calls. Keying by
// computed path lets `require()` (which is itself path-keyed) do the
// real caching: same path → same module, no re-load; different path →
// new resolution.
const bridgeCache = new Map<string, BridgeResolution<PathsBridgeKey>>();

function getBridge(): BridgeResolution<PathsBridgeKey> {
  const inTreePath = bridgeBinaryPath();
  const cached = bridgeCache.get(inTreePath);
  if (cached !== undefined) return cached;
  const bridge = loadPlatformAwareBridge(inTreePath);
  const resolution = resolveBridgeContract(bridge, PATHS_BRIDGE_ALIASES);
  bridgeCache.set(inTreePath, resolution);
  return resolution;
}

function callBridge<T>(fnName: PathsBridgeKey, args: readonly unknown[]): T {
  const resolution = getBridge();
  if (!resolution.bridgeLoaded) {
    throw new Error(
      `paths bridge unavailable — \`crates/memphis-paths\` NAPI module did not load. ` +
        `Rebuild via \`npm run build:rust:release\` or install the platform sub-package.`,
    );
  }
  const fn = resolution.resolved[fnName];
  if (typeof fn !== 'function') {
    throw new Error(
      `paths bridge missing export "${fnName}". ` +
        `Aliases tried: ${PATHS_BRIDGE_ALIASES[fnName].join(', ')}.`,
    );
  }
  // The envelope is parsed by the one module that understands the Rust
  // bridge's JSON contract. A `catch_unwind`-guarded Rust panic arrives
  // here as a thrown error, and it becomes a normal bridge error with
  // the function name attached.
  return callBridgeEnvelope<T>(fnName, () => fn(...args) as string);
}

export function bridgeResolveDataDir(rawEnv: NodeJS.ProcessEnv = process.env): string {
  return callBridge<string>('paths_resolve_data_dir', [
    envToJson(rawEnv),
    pathResolutionBase(rawEnv),
  ]);
}

export function bridgeResolveChainsDir(rawEnv: NodeJS.ProcessEnv = process.env): string {
  return callBridge<string>('paths_resolve_chains_dir', [
    envToJson(rawEnv),
    pathResolutionBase(rawEnv),
  ]);
}

export function bridgeResolveChainPath(
  chainName: string,
  rawEnv: NodeJS.ProcessEnv = process.env,
): string {
  return callBridge<string>('paths_resolve_chain_path', [
    envToJson(rawEnv),
    pathResolutionBase(rawEnv),
    chainName,
  ]);
}

export function bridgeNormalizeChainName(input: string): string {
  return callBridge<string>('paths_normalize_chain_name', [input]);
}

export function pathsBridgeAvailable(): boolean {
  return getBridge().bridgeLoaded;
}

/**
 * Test-only hook: reset the cached bridge resolution so a unit test
 * can mock `loadPlatformAwareBridge` and re-trigger the load. Not
 * exported through any index — callers must import this file directly.
 */
export function __resetPathsBridgeCacheForTests(): void {
  bridgeCache.clear();
}
