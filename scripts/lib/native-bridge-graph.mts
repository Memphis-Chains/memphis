/**
 * The dependency closure of the native bridge.
 *
 * ## Why this module exists
 *
 * The native bridge gate has to answer one question: *is the shipped
 * `.node` binary still the code in this tree?* To answer it, the gate
 * needs to know which Rust sources can change the binary.
 *
 * The first version of the gate answered "all of them" — it compared the
 * artifact against the newest `.rs` file under `crates/`. That is wrong,
 * and wrong in the way that destroys a gate.
 *
 * `crates/memphis-napi` is the only crate compiled into
 * `crates/memphis-napi/index.node`. Its closure is seven crates:
 * memphis-napi, memphis-core, memphis-vault, memphis-embed,
 * memphis-case-index, memphis-paths, memphis-export.
 *
 * `memphis-operator` and `memphis-tui` are **not** in that closure. They
 * are separate binaries — the operator console and the TUI — and their
 * code never reaches the bridge. Editing them does not make the shipped
 * binary stale.
 *
 * Measured on this host, the broad version failed for the wrong reason
 * on the very first real edit: `crates/memphis-operator/src/chat_session.rs`
 * was touched, the gate reported the bridge was stale, and `npm run
 * build:rust:release` could not possibly have fixed it because the
 * release build does not depend on that crate at all. A gate that
 * reports a problem no action can fix is a gate people learn to ignore.
 *
 * So the closure is computed from the manifests instead of assumed.
 *
 * ## How the closure is computed
 *
 * Every local dependency in this workspace is declared with an explicit
 * `path =` — there is no registry dependency between workspace crates.
 * That makes the closure derivable from `Cargo.toml` alone: read the
 * dependency sections, follow the `path =` values, recurse.
 *
 * `dev-dependencies` are excluded on purpose: they are compiled into
 * test binaries, never into the shipped cdylib.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

/** The crate that compiles into the shipped N-API binary. */
export const BRIDGE_CRATE_DIR = 'crates/memphis-napi';

/**
 * Parse a `Cargo.toml` into its sections.
 *
 * This is deliberately not a TOML parser. The script has to run in an
 * ops context where the dependency tree may not be installed, and the
 * only thing needed here is the section layout. `smol-toml` is not a
 * direct dependency of this package — it only appears in `overrides` as
 * a pin on knip's copy — so importing it would be a phantom dependency.
 */
function parseSections(text: string): Map<string, string[]> {
  const sections = new Map<string, string[]>();
  let current = '';
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (line.startsWith('[') && line.endsWith(']')) {
      current = line.slice(1, -1);
      if (!sections.has(current)) sections.set(current, []);
      continue;
    }
    if (current === '') continue;
    sections.get(current)?.push(line);
  }
  return sections;
}

/**
 * Is this a section that contributes to the compiled library?
 *
 * `dev-dependencies` is excluded: it never reaches the cdylib. The
 * sub-table forms (`[dependencies.foo]`) and the platform-specific
 * forms (`[target.'cfg(unix)'.dependencies]`) are included.
 */
export function isDependencySection(name: string): boolean {
  if (name.includes('dev-dependencies')) return false;
  if (name === 'dependencies' || name === 'build-dependencies') return true;
  if (name.startsWith('dependencies.')) return true;
  if (name.endsWith('.dependencies')) return true;
  return false;
}

/** The local path dependencies of one crate, as declared in its manifest. */
export function pathDependencies(crateDir: string): string[] {
  const manifest = join(crateDir, 'Cargo.toml');
  if (!existsSync(manifest)) return [];
  const sections = parseSections(readFileSync(manifest, 'utf8'));
  const deps: string[] = [];
  for (const [name, lines] of sections) {
    if (!isDependencySection(name)) continue;
    for (const line of lines) {
      const match = /\bpath\s*=\s*"([^"]+)"/.exec(line);
      if (match?.[1]) deps.push(match[1]);
    }
  }
  return deps;
}

/**
 * Every crate whose source can change the shipped bridge, transitively.
 *
 * The bridge crate itself is included.
 */
export function bridgeDependencyClosure(repoRoot: string): string[] {
  const seen = new Set<string>();
  const queue = [join(repoRoot, BRIDGE_CRATE_DIR)];
  while (queue.length > 0) {
    const dir = queue.pop();
    if (!dir || seen.has(dir)) continue;
    seen.add(dir);
    for (const dep of pathDependencies(dir)) {
      const resolved = resolve(dir, dep);
      if (existsSync(join(resolved, 'Cargo.toml'))) queue.push(resolved);
    }
  }
  return [...seen].sort();
}

/** Newest `.rs` file under a directory, and where it is. */
function newestRustMtime(dir: string): { mtime: number; path: string } {
  if (!existsSync(dir)) return { mtime: 0, path: '' };
  let newest = 0;
  let path = '';
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      const nested = newestRustMtime(full);
      if (nested.mtime > newest) {
        newest = nested.mtime;
        path = nested.path;
      }
      continue;
    }
    if (!entry.name.endsWith('.rs')) continue;
    const mtime = statSync(full).mtimeMs;
    if (mtime > newest) {
      newest = mtime;
      path = full;
    }
  }
  return { mtime: newest, path };
}

/**
 * The newest source that can change the bridge, and where it is.
 *
 * The closure's crates contribute their `.rs` files and their manifests.
 * The workspace manifest and the lockfile contribute too: a change to
 * either moves the dependency graph the bridge was compiled against.
 * The lockfile is deliberately not narrowed to the closure's own entries
 * — a dependency bump anywhere in the workspace is cheap to rebuild the
 * bridge for, and cheap to notice the first time.
 */
export function newestBridgeSource(repoRoot: string): { mtime: number; path: string } {
  let newest = 0;
  let path = '';
  const consider = (mtime: number, candidate: string): void => {
    if (mtime > newest) {
      newest = mtime;
      path = candidate;
    }
  };

  for (const crateDir of bridgeDependencyClosure(repoRoot)) {
    const newest = newestRustMtime(join(crateDir, 'src'));
    if (newest.path) consider(newest.mtime, relative(repoRoot, newest.path));
    const manifest = join(crateDir, 'Cargo.toml');
    if (existsSync(manifest)) {
      consider(statSync(manifest).mtimeMs, relative(repoRoot, manifest));
    }
  }

  for (const manifest of ['Cargo.toml', 'Cargo.lock']) {
    const full = join(repoRoot, manifest);
    if (!existsSync(full)) continue;
    consider(statSync(full).mtimeMs, manifest);
  }

  return { mtime: newest, path };
}
