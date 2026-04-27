/**
 * Discover the Memphis install root regardless of the operator's current
 * working directory.
 *
 * Previously the CLI resolved runtime root via `resolveRuntimeRoot(cwd)`,
 * which anchored on `process.cwd()`. Running `memphis self-update` or
 * `memphis tui` from `$HOME` (not the checkout) silently fell back to
 * "no package.json here" → release mode or missing `.env` → defaults.
 * The user observed both: "up to date (1.4.0)" from the home dir while
 * the source checkout had 13 commits ahead, and a TUI that loaded
 * different config based on the invoking shell's cwd.
 *
 * This module resolves install root from four sources, in order:
 *
 * 1. `MEMPHIS_RUNTIME_ROOT` env var (explicit override, highest priority)
 * 2. Walk up from `options.importUrl` when the caller passes its own
 *    `import.meta.url` (most specific intent)
 * 3. Walk up from `process.cwd()` — preserves the old behaviour for
 *    operators who were already running inside the checkout and keeps
 *    unit tests that patch cwd deterministic
 * 4. Walk up from `realpath(process.argv[1])` — resolves the npm-linked
 *    `memphis` binary back to the real source tree, which is what lets
 *    `memphis self-update` / `memphis tui` find the checkout when run
 *    from `$HOME`
 *
 * Exposes `resolveInstallRoot()` as the single source of truth; other
 * helpers in this package should use it rather than reimplementing cwd
 * walks.
 */

import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const MEMPHIS_PACKAGE_NAME = '@memphis-chains/memphis';

function parsePackageName(root: string): string | null {
  const packageJsonPath = join(root, 'package.json');
  if (!existsSync(packageJsonPath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as { name?: string };
    return typeof parsed.name === 'string' ? parsed.name : null;
  } catch {
    return null;
  }
}

function walkUpToPackage(startDir: string): string | null {
  let current = resolve(startDir);
  let lastParent: string | null = null;
  while (current !== lastParent) {
    if (parsePackageName(current) === MEMPHIS_PACKAGE_NAME) {
      return current;
    }
    lastParent = current;
    current = dirname(current);
  }
  return null;
}

function resolveFromImportUrl(importUrl: string): string | null {
  try {
    const filePath = fileURLToPath(importUrl);
    // When the CLI is npm-linked (`/usr/local/bin/memphis` → symlink),
    // fileURLToPath gives the symlink target inside the source tree.
    // Walk up from that directory to the package.json.
    const realFile = existsSync(filePath) ? realpathSync(filePath) : filePath;
    return walkUpToPackage(dirname(realFile));
  } catch {
    return null;
  }
}

export type InstallRootSource = 'env-override' | 'binary-path' | 'cwd-fallback';

export type InstallRootResolution = {
  root: string;
  source: InstallRootSource;
};

/**
 * Resolve the Memphis install root.
 *
 * `options.importUrl` should be the caller's `import.meta.url` when the
 * caller is itself a module inside the install tree — this lets the
 * function walk up from the calling file's location regardless of cwd.
 * When absent, we try the default CLI entry location via
 * `process.argv[1]`, then fall back to cwd. When the env override is
 * set, it always wins.
 */
// Process-local memoisation. Install root cannot change during a process
// lifetime — every resolver input (env override, importUrl, cwd at time
// of first call, argv[1]) is pinned at process start. The walk-up is
// cheap but `resolveDotEnvPath` runs on every config read, so caching
// the successful resolution keeps the hot paths off the disk.
let memoizedResolution: InstallRootResolution | null = null;

export function resetInstallRootMemoForTests(): void {
  memoizedResolution = null;
}

export function resolveInstallRootWithSource(
  options: {
    rawEnv?: NodeJS.ProcessEnv;
    cwd?: string;
    importUrl?: string;
  } = {},
): InstallRootResolution {
  // Only hit the cache for the default / no-override call — tests that
  // pass explicit options get fresh resolution every time so fixtures
  // don't leak across cases.
  const useCache =
    options.rawEnv === undefined &&
    options.cwd === undefined &&
    options.importUrl === undefined;
  if (useCache && memoizedResolution) return memoizedResolution;
  const env = options.rawEnv ?? process.env;
  const cwd = options.cwd ?? process.cwd();

  const override = env.MEMPHIS_RUNTIME_ROOT?.trim();
  if (override && parsePackageName(resolve(override)) === MEMPHIS_PACKAGE_NAME) {
    return { root: resolve(override), source: 'env-override' };
  }

  if (options.importUrl) {
    const fromUrl = resolveFromImportUrl(options.importUrl);
    if (fromUrl) return { root: fromUrl, source: 'binary-path' };
  }

  // Prefer cwd walk-up over `process.argv[1]` because the operator's
  // explicit shell context (where they ran `memphis`) is usually what
  // they want. argv[1] is used only as a last-resort "the CLI itself
  // lives inside a memphis checkout even if cwd has wandered off".
  const fromCwd = walkUpToPackage(cwd);
  if (fromCwd) return { root: fromCwd, source: 'cwd-fallback' };

  // Fallback for when neither cwd nor import.meta.url helped: resolve
  // the process entry point. `process.argv[1]` is the CLI script path —
  // realpathSync follows `npm link` symlinks back to the real source
  // tree. This is what makes `memphis self-update` from `$HOME` find
  // the checkout.
  const argvEntry = process.argv[1];
  if (argvEntry) {
    try {
      const real = realpathSync(argvEntry);
      const found = walkUpToPackage(dirname(real));
      if (found) return { root: found, source: 'binary-path' };
    } catch {
      /* ignore */
    }
  }

  throw new Error(
    'Could not locate Memphis install root. Set MEMPHIS_RUNTIME_ROOT=<path> or run from the source checkout.',
  );
}

export function resolveInstallRoot(
  options?: Parameters<typeof resolveInstallRootWithSource>[0],
): string {
  return resolveInstallRootWithSource(options).root;
}

/**
 * Resolve the Rust NAPI bridge path with operator override + install-root
 * anchoring. Used by every adapter that loads the bridge module
 * (vault, chain, embed) plus startup probes (doctor, graceful-shutdown).
 *
 * Why this lives here: PR #306 fixed the bug in `rust-vault-adapter.ts`
 * (operator running `memphis` from $HOME hit "Rust vault bridge not
 * found at ./crates/memphis-napi" because `loadBridgeModule` resolved
 * the relative path against `process.cwd()`). Five sibling files had
 * the same `?? './crates/memphis-napi'` fallback. Centralizing here
 * removes the duplicate footgun and ensures consistent behaviour.
 *
 * Behaviour:
 * - `RUST_CHAIN_BRIDGE_PATH` env override:
 *   - **absolute** path → used verbatim (operator override wins fully)
 *   - **relative** path → resolved against installRoot, NOT cwd
 *     (legacy .env files from pre-#306 hosts ship with
 *     `RUST_CHAIN_BRIDGE_PATH=./crates/memphis-napi` — without this
 *     branch, those .env files break vault writes when `memphis` is
 *     run from any dir other than the source checkout)
 * - Default (no override): `<installRoot>/crates/memphis-napi` (absolute)
 * - If install root can't be discovered (rare), falls back to legacy
 *   relative `./crates/memphis-napi` so embedded callers don't break.
 */
export function resolveRustBridgePath(rawEnv: NodeJS.ProcessEnv = process.env): string {
  const override = rawEnv.RUST_CHAIN_BRIDGE_PATH?.trim();
  if (override) {
    // Absolute path → verbatim. Anything else (relative or bare name)
    // anchors on installRoot. Windows paths (`C:\...`) covered by the
    // Win32 drive-letter check.
    if (override.startsWith('/') || /^[A-Za-z]:[\\/]/.test(override)) {
      return override;
    }
    try {
      return resolve(resolveInstallRoot({ rawEnv }), override);
    } catch {
      // Install root unresolvable + relative override — return as-is and
      // let the loader's existing error path surface the cause.
      return override;
    }
  }
  try {
    const root = resolveInstallRoot({ rawEnv });
    return resolve(root, 'crates', 'memphis-napi');
  } catch {
    return './crates/memphis-napi';
  }
}
