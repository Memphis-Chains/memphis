/**
 * The systemd units this runtime ships, and the ones the gate covers.
 *
 * ## Why this module exists
 *
 * There are two unit files named `memphis.service` in this repository:
 * one in `scripts/systemd/` and one in `ops/`. They are different units
 * for the same runtime, and they were reviewed separately for a long
 * time.
 *
 * That separation had a cost. The systemd gate read
 * `scripts/systemd/` only, so `ops/memphis.service` — a long-running
 * service with no `MemoryMax=` — was never checked. The kernel OOM
 * killer is what stopped it, not the supervisor, and the operator saw
 * the runtime die with no visible cause.
 *
 * The coverage check that was supposed to catch this could not see it
 * either. It compared the name of a file in `ops/` against the path of
 * a directory (`scripts/systemd`), so the two could never be equal and
 * the check reported the same hole forever — including after the hole
 * was closed.
 *
 * ## The rule
 *
 * One list, two readers:
 *
 * - the gate (`scripts/check-systemd-units.mts`) checks every unit in
 *   the roots below;
 * - the audit (`src/infra/audit/runtime-audit.ts`) compares that list
 *   against the units actually present in those roots.
 *
 * A unit in a root that the gate does not read is a hole the audit can
 * now see, because both sides use this module instead of guessing from
 * each other's source text.
 */

import { existsSync, readdirSync, type Dirent } from 'node:fs';
import { join, relative, resolve } from 'node:path';

/**
 * The directories this runtime ships systemd units in.
 *
 * `scripts/live/` holds a unit too — a camera publisher installed with
 * `WantedBy=default.target`. It was outside the gate, and the inventory
 * below is what makes that visible instead of permanent.
 */
export const UNIT_ROOTS = ['scripts/systemd', 'ops', 'scripts/live'] as const;

/** Directories that never hold a unit this repository ships. */
const SKIPPED_DIRS = new Set([
  'node_modules',
  'target',
  'dist',
  'coverage',
  'models',
  'training-data',
  'work',
  'tmp',
]);

/** A unit the gate reads. */
export interface UnitUnderTest {
  /**
   * The unit's path relative to the repository root.
   *
   * The full relative path, not the bare name: two roots both contain a
   * `memphis.service`, and a finding that names only the file cannot
   * say which one is wrong.
   */
  file: string;
  /** The absolute path the unit is read from. */
  path: string;
  /** The unit's file name, e.g. `memphis.service`. */
  name: string;
}

/** Is this file name a systemd unit? */
export function isUnitFile(name: string): boolean {
  return name.endsWith('.service') || name.endsWith('.timer');
}

/**
 * Every unit in the roots, as the gate sees them.
 *
 * A root that does not exist is skipped rather than fatal: a checkout
 * without `ops/` still has units to check.
 */
export function listUnitsUnderTest(repoRoot: string): UnitUnderTest[] {
  const units: UnitUnderTest[] = [];
  for (const root of UNIT_ROOTS) {
    const dir = resolve(repoRoot, root);
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir).sort()) {
      if (!isUnitFile(name)) continue;
      units.push({
        file: `${root}/${name}`,
        path: join(dir, name),
        name,
      });
    }
  }
  return units;
}

/**
 * Every unit present in the repository, as repo-relative paths.
 *
 * This is the inventory — what exists, anywhere. `listUnitsUnderTest` is
 * the coverage — what the gate reads. A unit in the inventory that is not
 * in the coverage is a hole.
 *
 * The inventory deliberately scans the WHOLE repository, not just the
 * declared roots. If it scanned only the roots, the two lists would be
 * identical by construction and the comparison could never fail — a check
 * that cannot fail is not a check. Scanning everything is what lets a unit
 * that lands in a NEW directory be reported instead of quietly escaping.
 */
export function inventoryUnitFiles(repoRoot: string): string[] {
  const files: string[] = [];
  const walk = (dir: string): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIPPED_DIRS.has(entry.name)) continue;
        walk(full);
        continue;
      }
      if (!isUnitFile(entry.name)) continue;
      files.push(relative(repoRoot, full).split('\\').join('/'));
    }
  };
  walk(repoRoot);
  return files.sort();
}
