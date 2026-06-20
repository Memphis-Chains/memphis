import { createRequire } from 'node:module';

import { installNapiShutdownGuard } from '../runtime/napi-shutdown.js';

type BridgeModule = Record<string, unknown>;

/**
 * Platform triples we publish prebuilt NAPI binaries for. Operators on
 * other triples build from source via `npm run build:rust:release`.
 *
 * Format: `<os>-<arch>-<libc>?` matching the napi-rs CLI convention.
 * `gnu` libc is the glibc default on Linux; `musl` is Alpine. Darwin/Windows
 * have no libc suffix.
 */
export type SupportedPlatformTriple =
  | 'linux-x64-gnu'
  | 'linux-arm64-gnu'
  | 'darwin-x64'
  | 'darwin-arm64';

/**
 * Detect the running platform triple. Returns `null` when the platform/arch
 * combination is not in the prebuilt matrix — caller should fall back to the
 * in-tree bridge path. Linux without glibc (e.g. Alpine/musl) returns null
 * by design; we don't ship a musl prebuild yet.
 */
export function detectPlatformTriple(
  rawProcess: typeof process = process,
): SupportedPlatformTriple | null {
  const platform = rawProcess.platform;
  const arch = rawProcess.arch;

  if (platform === 'linux' && arch === 'x64' && isGlibcLinux(rawProcess)) {
    return 'linux-x64-gnu';
  }
  if (platform === 'linux' && arch === 'arm64' && isGlibcLinux(rawProcess)) {
    return 'linux-arm64-gnu';
  }
  if (platform === 'darwin' && arch === 'x64') return 'darwin-x64';
  if (platform === 'darwin' && arch === 'arm64') return 'darwin-arm64';

  return null;
}

/**
 * `process.report.getReport().header.glibcVersionRuntime` is set to a string
 * on glibc Linux, undefined on musl Linux. Mirrors the same probe used in
 * `scripts/postinstall-check-native.mjs` (S9-0) so distribution + load-side
 * checks stay aligned.
 */
function isGlibcLinux(rawProcess: typeof process): boolean {
  if (rawProcess.platform !== 'linux') return false;
  try {
    const report =
      typeof rawProcess.report?.getReport === 'function'
        ? (rawProcess.report.getReport() as { header?: { glibcVersionRuntime?: string } })
        : {};
    return typeof report.header?.glibcVersionRuntime === 'string';
  } catch {
    return false;
  }
}

/**
 * Sub-package name on the npm registry for a given platform triple.
 * Mirrors the per-platform packages published by S9-3 (prebuilds.yml).
 *
 * Naming convention: `@memphis-chains/memphis-<triple>` (e.g.
 * `@memphis-chains/memphis-linux-x64-gnu`). This pairs with
 * `optionalDependencies` in the root package.json so npm picks the right
 * one based on `os`/`cpu`/`libc` keys in each sub-package's package.json.
 */
export function platformPackageName(triple: SupportedPlatformTriple): string {
  return `@memphis-chains/memphis-${triple}`;
}

/**
 * Try the freshly built in-tree bridge first; fall back to the platform
 * sub-package and then the same in-tree path again. Returns the loaded
 * bridge or null if all attempts fail.
 *
 * Source checkouts run `npm ci` before `npm run build`, so the optional
 * platform package in `node_modules` can be older than the just-built
 * `crates/memphis-napi/index.node`. Prefer the in-tree binary to keep CI
 * and local development on the checked-out Rust contract.
 *
 * The platform sub-package path remains as a fallback for installs that
 * do not include or cannot load the in-tree bridge.
 *
 * `inTreePath` is the directory containing the legacy `index.node` (per
 * resolveRustBridgePath in install-root.ts), or an explicit bridge file.
 */
export function loadPlatformAwareBridge(
  inTreePath: string,
  rawProcess: typeof process = process,
): BridgeModule | null {
  const inTreeBridge = loadBridgeModule(inTreePath);
  if (inTreeBridge) return inTreeBridge;

  const triple = detectPlatformTriple(rawProcess);
  if (triple !== null) {
    try {
      const req = createRequire(`${rawProcess.cwd()}/`);
      const platformPkg = req(platformPackageName(triple)) as BridgeModule;
      if (platformPkg) return platformPkg;
    } catch {
      // Platform sub-package not installed or not loadable.
    }
  }

  return loadBridgeModule(inTreePath);
}

export type BridgeAliasMap<T extends string> = Record<T, readonly [string, ...string[]]>;

export type BridgeResolution<T extends string> = {
  bridgeLoaded: boolean;
  missing: T[];
  legacyAliasesUsed: Partial<Record<T, string>>;
  resolved: Partial<Record<T, (...args: unknown[]) => unknown>>;
};

export function hasRequiredBridgeExports<T extends string>(
  resolution: BridgeResolution<T>,
  required: readonly T[],
): boolean {
  if (!resolution.bridgeLoaded) {
    return false;
  }

  return required.every((key) => typeof resolution.resolved[key] === 'function');
}

export function loadBridgeModule(path: string): BridgeModule | null {
  try {
    const req = createRequire(`${process.cwd()}/`);
    const bridge = req(path) as BridgeModule;
    // Issue #270 NEW variant fix (2026-05-03): when ANY caller resolves
    // the napi binary, register the exit guard so process teardown
    // calls embed_shutdown() + flushAllPinoStreamsSync() before V8
    // tears down the napi env. Idempotent — re-loaders are no-ops.
    // Covers tsx-spawned scripts (npm run -s ops:*) that bypass the
    // runtime's performGracefulShutdown and would otherwise SIGSEGV
    // on exit. Production runtime servers also call installShutdownHandlers
    // and run performGracefulShutdown explicitly; the auto guard still
    // installs but is a no-op there because embed_shutdown was already
    // called and pino streams were already flushed.
    installNapiShutdownGuard(bridge);
    return bridge;
  } catch {
    return null;
  }
}

export function resolveBridgeContract<T extends string>(
  bridge: BridgeModule | null,
  aliases: BridgeAliasMap<T>,
): BridgeResolution<T> {
  if (!bridge) {
    return {
      bridgeLoaded: false,
      missing: Object.keys(aliases) as T[],
      legacyAliasesUsed: {},
      resolved: {},
    };
  }

  const resolved: Partial<Record<T, (...args: unknown[]) => unknown>> = {};
  const missing: T[] = [];
  const legacyAliasesUsed: Partial<Record<T, string>> = {};

  for (const key of Object.keys(aliases) as T[]) {
    const candidates = aliases[key];
    const foundAlias = candidates.find((candidate) => typeof bridge[candidate] === 'function');
    if (!foundAlias) {
      missing.push(key);
      continue;
    }

    if (foundAlias !== key) {
      legacyAliasesUsed[key] = foundAlias;
    }

    resolved[key] = bridge[foundAlias] as (...args: unknown[]) => unknown;
  }

  return {
    bridgeLoaded: true,
    missing,
    legacyAliasesUsed,
    resolved,
  };
}
