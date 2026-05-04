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

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  loadPlatformAwareBridge,
  resolveBridgeContract,
  type BridgeAliasMap,
  type BridgeResolution,
} from './napi-contract.js';
import { resolveRustBridgePath } from '../runtime/install-root.js';

type PathsBridgeKey =
  | 'paths_resolve_data_dir'
  | 'paths_resolve_chains_dir'
  | 'paths_resolve_chain_path'
  | 'paths_normalize_chain_name';

const PATHS_BRIDGE_ALIASES = {
  paths_resolve_data_dir: ['paths_resolve_data_dir', 'pathsResolveDataDir'],
  paths_resolve_chains_dir: ['paths_resolve_chains_dir', 'pathsResolveChainsDir'],
  paths_resolve_chain_path: ['paths_resolve_chain_path', 'pathsResolveChainPath'],
  paths_normalize_chain_name: ['paths_normalize_chain_name', 'pathsNormalizeChainName'],
} as const satisfies BridgeAliasMap<PathsBridgeKey>;

interface NapiResult<T> {
  ok: boolean;
  data?: T;
  error?: string;
}

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

const MEMPHIS_PACKAGE_NAME = '@memphis-chains/memphis';

function packageNameAt(dir: string): string | null {
  const pkgPath = resolve(dir, 'package.json');
  if (!existsSync(pkgPath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(pkgPath, 'utf8')) as { name?: string };
    return typeof parsed.name === 'string' ? parsed.name : null;
  } catch {
    return null;
  }
}

function walkUpToInstallRoot(startDir: string): string | null {
  let current = resolve(startDir);
  let last = '';
  while (current !== last) {
    if (packageNameAt(current) === MEMPHIS_PACKAGE_NAME) return current;
    last = current;
    current = dirname(current);
  }
  return null;
}

/**
 * Resolve the bridge binary path from this module's filesystem
 * location rather than `process.cwd()` or `MEMPHIS_RUNTIME_ROOT`.
 *
 * Tests (`tests/unit/cli.vault-migrate.test.ts`,
 * `tests/unit/vault-paths.test.ts`) override `MEMPHIS_RUNTIME_ROOT` to
 * a tmpdir to isolate runtime data, and `process.chdir` into sandboxes
 * the same way. Both inputs feed `resolveInstallRoot`, which would
 * point us at `<tmpdir>/crates/memphis-napi` — a path with no `.node`.
 *
 * The bridge binary lives next to the JS files we're shipping, so
 * walking up from `import.meta.url` until we find the
 * `@memphis-chains/memphis` `package.json` always lands in the right
 * tree regardless of operator runtime overrides.
 *
 * `RUST_CHAIN_BRIDGE_PATH` is still honored — that's the explicit
 * "I'm pointing the bridge somewhere else" knob and must override
 * everything else.
 */
function bridgeBinaryPath(): string {
  const override = process.env.RUST_CHAIN_BRIDGE_PATH?.trim();
  if (override) return resolveRustBridgePath();
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const root = walkUpToInstallRoot(here);
    if (root) return resolve(root, 'crates', 'memphis-napi');
  } catch {
    // fileURLToPath can throw on bundlers that rewrite import.meta.url;
    // fall through to the legacy resolver in that case.
  }
  return resolveRustBridgePath();
}

function getBridge(): BridgeResolution<PathsBridgeKey> {
  const inTreePath = bridgeBinaryPath();
  const cached = bridgeCache.get(inTreePath);
  if (cached !== undefined) return cached;
  const bridge = loadPlatformAwareBridge(inTreePath);
  const resolution = resolveBridgeContract(bridge, PATHS_BRIDGE_ALIASES);
  bridgeCache.set(inTreePath, resolution);
  return resolution;
}

function callBridge<T>(
  fnName: PathsBridgeKey,
  args: readonly unknown[],
): T {
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
  const raw = fn(...args) as string;
  const parsed = JSON.parse(raw) as NapiResult<T>;
  if (!parsed.ok || parsed.data === undefined) {
    throw new Error(parsed.error ?? `paths bridge ${fnName} returned !ok with no error`);
  }
  return parsed.data;
}

function envToJson(rawEnv: NodeJS.ProcessEnv): string {
  // The Rust bridge expects a string→string map. `process.env` values
  // are typed `string | undefined`; the NAPI side ignores absent keys
  // already, but we strip undefined here so the JSON payload doesn't
  // carry `null`s the Rust deserializer would reject.
  const map: Record<string, string> = {};
  for (const [key, value] of Object.entries(rawEnv)) {
    if (typeof value === 'string') map[key] = value;
  }
  // Pre-Sprint B, `getDataDir({})` would resolve `~/.memphis` against
  // `os.homedir()` because the TS impl read homedir from the OS. The
  // Rust crate reads HOME from the env map for determinism. Fill HOME
  // from `os.homedir()` when the caller didn't supply it so the new
  // bridge call preserves the prior semantics — passing a partial env
  // (e.g. `{ MEMPHIS_DATA_DIR: ... }`) shouldn't suddenly start
  // resolving `~` to `.`.
  //
  // `os.homedir()` can throw on Linux service users without a passwd
  // entry. Codex R2 #436 caught that earlier "leave HOME unset" path:
  // Rust then resolved `~/.memphis` against `cwd`, silently writing
  // runtime state into the working dir instead of failing loudly.
  // That's data drift, not graceful degradation.
  //
  // Resolution: only ATTEMPT the home lookup; if it fails AND the
  // caller is relying on the `~/.memphis` default (no MEMPHIS_DATA_DIR
  // override, or one that's not absolute), throw a clear error here.
  // Absolute MEMPHIS_DATA_DIR doesn't need home expansion — that path
  // continues to work on passwd-less users.
  if (map.HOME === undefined) {
    let home: string | undefined;
    let lookupError: unknown;
    try {
      const probed = homedir();
      if (probed) home = probed;
    } catch (err) {
      lookupError = err;
    }
    if (home) {
      map.HOME = home;
    } else {
      // Codex R3 #436: only the `~`-prefixed path actually needs HOME
      // for tilde expansion. The Rust resolver handles relative paths
      // (`./data`, `data`) via the cwd argument, and absolute paths
      // need no expansion at all. Reject only the configurations that
      // would otherwise silently fall through to "expand `~` against
      // missing HOME" → resolve to `.` → write under cwd.
      const dataDir = map.MEMPHIS_DATA_DIR;
      const needsHomeExpansion =
        dataDir === undefined || dataDir === '' || dataDir.startsWith('~');
      if (needsHomeExpansion) {
        const reason =
          lookupError instanceof Error
            ? `os.homedir() threw: ${lookupError.message}`
            : 'os.homedir() returned empty';
        throw new Error(
          `paths bridge cannot resolve "~/.memphis" default — ${reason}. ` +
            'Set MEMPHIS_DATA_DIR to an absolute or relative (./data) path to bypass home lookup.',
        );
      }
    }
  }
  return JSON.stringify(map);
}

export function bridgeResolveDataDir(rawEnv: NodeJS.ProcessEnv = process.env): string {
  return callBridge<string>('paths_resolve_data_dir', [envToJson(rawEnv), process.cwd()]);
}

export function bridgeResolveChainsDir(rawEnv: NodeJS.ProcessEnv = process.env): string {
  return callBridge<string>('paths_resolve_chains_dir', [envToJson(rawEnv), process.cwd()]);
}

export function bridgeResolveChainPath(
  chainName: string,
  rawEnv: NodeJS.ProcessEnv = process.env,
): string {
  return callBridge<string>('paths_resolve_chain_path', [
    envToJson(rawEnv),
    process.cwd(),
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
