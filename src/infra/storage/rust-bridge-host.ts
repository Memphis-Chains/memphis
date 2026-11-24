/* eslint-disable no-restricted-syntax */
//
// rawEnv-threading default parameter or single-call config-source
// pattern. File-level disable per Sprint ι policy — accessor would
// add registry weight without consumer benefit.
//
/**
 * Where the Rust bridge lives, and how its environment is handed over.
 *
 * WHY THIS MODULE EXISTS
 * ----------------------
 * Three rules decide how a TypeScript caller talks to the native core:
 *
 *   1. WHICH binary — the `.node` module that is loaded;
 *   2. WHAT environment — the string→string map the Rust side reads, and
 *      the `HOME` handling that map needs to resolve `~`;
 *   3. AGAINST WHAT ROOT — the directory relative paths resolve against.
 *
 * They used to live inside `rust-paths-bridge.ts`, which is the PATHS
 * adapter. When the embed-profile adapter needed the same three answers,
 * the two choices were to copy them (a second copy of a rule that decides
 * where the binary comes from — the exact bug class this repo keeps
 * fighting) or to move them somewhere both can reach.
 *
 * They live here now. The paths adapter imports them; so does the
 * embed-profile adapter. One owner, two callers.
 *
 * The rules themselves did not change — the code moved verbatim, comments
 * and all.
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveRustBridgePath } from '../runtime/install-root.js';

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
  let dir = resolve(startDir);
  let last = '';
  while (dir !== last) {
    if (packageNameAt(dir) === MEMPHIS_PACKAGE_NAME) return dir;
    last = dir;
    dir = dirname(dir);
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
export function bridgeBinaryPath(): string {
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

/**
 * The environment, as the Rust side receives it.
 *
 * The Rust bridge expects a string→string map. `process.env` values
 * are typed `string | undefined`; the NAPI side ignores absent keys
 * already, but we strip undefined here so the JSON payload doesn't
 * carry `null`s the Rust deserializer would reject.
 *
 * Pre-Sprint B, `getDataDir({})` would resolve `~/.memphis` against
 * `os.homedir()` because the TS impl read homedir from the OS. The
 * Rust crate reads HOME from the env map for determinism. Fill HOME
 * from `os.homedir()` when the caller didn't supply it so the new
 * bridge call preserves the prior semantics — passing a partial env
 * (e.g. `{ MEMPHIS_DATA_DIR: ... }`) shouldn't suddenly start
 * resolving `~` to `.`.
 *
 * `os.homedir()` can throw on Linux service users without a passwd
 * entry. Codex R2 #436 caught that earlier "leave HOME unset" path:
 * Rust then resolved `~/.memphis` against `cwd`, silently writing
 * runtime state into the working dir instead of failing loudly.
 * That's data drift, not graceful degradation.
 *
 * Resolution: only ATTEMPT the home lookup; if it fails AND the
 * caller is relying on the `~/.memphis` default (no MEMPHIS_DATA_DIR
 * override, or one that's not absolute), throw a clear error here.
 * Absolute MEMPHIS_DATA_DIR doesn't need home expansion — that path
 * continues to work on passwd-less users.
 * Codex R3 #436: only the `~`-prefixed path actually needs HOME
 * for tilde expansion. The Rust resolver handles relative paths
 * (`./data`, `data`) via the cwd argument, and absolute paths
 * need no expansion at all. Reject only the configurations that
 * would otherwise silently fall through to "expand `~` against
 * missing HOME" → resolve to `.` → write under cwd.
 * R5: trim MEMPHIS_DATA_DIR first to match the Rust resolver's
 * own trim — `"   ~/.memphis"` would otherwise bypass the
 * startsWith check here.
 */
export function envToJson(rawEnv: NodeJS.ProcessEnv): string {
  const map: Record<string, string> = {};
  for (const [key, value] of Object.entries(rawEnv)) {
    if (typeof value === 'string') map[key] = value;
  }
  const trimmedHome = typeof map.HOME === 'string' ? map.HOME.trim() : '';
  if (!trimmedHome) {
    delete map.HOME;
    let home: string | undefined;
    let lookupError: unknown;
    try {
      const probed = homedir();
      if (probed && probed.trim()) home = probed.trim();
    } catch (err) {
      lookupError = err;
    }
    if (home) {
      map.HOME = home;
    } else {
      const rawDataDir = map.MEMPHIS_DATA_DIR;
      const trimmedDataDir = typeof rawDataDir === 'string' ? rawDataDir.trim() : '';
      const needsHomeExpansion = trimmedDataDir === '' || trimmedDataDir.startsWith('~');
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

/** Explicit runtime roots anchor relative storage paths independently of launch cwd. */
export function pathResolutionBase(rawEnv: NodeJS.ProcessEnv): string {
  const runtimeRoot = rawEnv.MEMPHIS_RUNTIME_ROOT?.trim();
  return runtimeRoot ? resolve(runtimeRoot) : process.cwd();
}
