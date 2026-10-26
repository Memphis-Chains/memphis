import { mkdirSync, rmSync } from 'node:fs';

import { TEST_TMP_ROOT, TEST_TMP_ROOT_OWNED } from './helpers/test-tmp-root.js';

/**
 * The whole test run gets one temporary directory, and it is removed when
 * the run ends.
 *
 * WHY
 * ---
 * 258 test files create their own fixtures with
 * `mkdtempSync(join(tmpdir(), 'memphis-…'))` and roughly 140 of them never
 * remove them. Measured on the operator's host: a two-file run left 19
 * directories behind, and the directory had grown to 2 145 — 212 MB on a
 * tmpfs, which is RAM. The leak was not a single bug but a class of them,
 * and fixing it file by file would be 140 diffs that every new test
 * would undo.
 *
 * `os.tmpdir()` honours TMPDIR, so pointing it at a per-run directory
 * moves every fixture into one place that can be deleted wholesale. The
 * directory is named after the run, so two concurrent runs never share
 * one and neither can delete the other's fixtures.
 *
 * A sweeper inside the test process would be a race: vitest runs test
 * files in parallel workers, and a worker finishing would remove
 * directories another worker had just created. Removing the whole
 * per-run directory at the end, by the process that owns it, cannot race
 * with itself.
 */
export function setup(): void {
  mkdirSync(TEST_TMP_ROOT, { recursive: true });
}

export function teardown(): void {
  // Only the run that created the directory removes it. A nested run
  // inherits the parent's root and must leave it alone — the parent is
  // still using it, and its own teardown removes it when it finishes.
  if (!TEST_TMP_ROOT_OWNED) return;
  rmSync(TEST_TMP_ROOT, { recursive: true, force: true });
}
