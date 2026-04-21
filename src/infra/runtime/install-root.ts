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
 * This module resolves install root from three sources, in order:
 *
 * 1. `MEMPHIS_RUNTIME_ROOT` env var (explicit override, highest priority)
 * 2. Walk up from `import.meta.url` / the CLI's own file location until
 *    a `package.json` with `name === '@memphis-chains/memphis'` is found
 * 3. Fall back to `process.cwd()` so unit tests that patch cwd still work
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
export function resolveInstallRootWithSource(
  options: {
    rawEnv?: NodeJS.ProcessEnv;
    cwd?: string;
    importUrl?: string;
  } = {},
): InstallRootResolution {
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
