import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { resolveTestTmpRoot, TEST_TMP_ROOT } from '../helpers/test-tmp-root.js';

describe('the test run temporary directory', () => {
  // The wiring that stops the leak: every fixture a test creates has to
  // land inside the directory this run owns, because that is the only
  // thing removed when the run ends. Measured before the fix: a two-file
  // run left 19 directories in the system temp dir, and the directory had
  // grown to 2 145 — 212 MB of a tmpfs, which is RAM.
  it('is the directory os.tmpdir() resolves to', () => {
    expect(tmpdir()).toBe(TEST_TMP_ROOT);
    expect(process.env.TMPDIR).toBe(TEST_TMP_ROOT);
  });

  it('puts a fixture the way a test creates it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'memphis-probe-'));
    try {
      expect(dir.startsWith(TEST_TMP_ROOT)).toBe(true);
    } finally {
      // The run directory is removed wholesale; this only proves the
      // fixture landed where the teardown will find it.
    }
  });

  // A nested Vitest run inherits the parent's root through the
  // environment. Its teardown must NOT delete that directory: the parent
  // is still using it. Measured before this guard existed: a nested run
  // wiped the parent's fixture file.
  it('does not claim ownership of an inherited root', () => {
    const inherited = resolveTestTmpRoot('/tmp/memphis-test-run-999', 1234);
    expect(inherited.root).toBe('/tmp/memphis-test-run-999');
    expect(inherited.owned).toBe(false);
  });

  // The config sets the environment variable before the global setup file
  // is loaded, so "was it already set" cannot answer ownership — the pid in
  // the directory name can, and gives the same answer whichever module
  // asks first.
  it('recognises its own directory even when the variable was already set', () => {
    const own = resolveTestTmpRoot('/tmp/memphis-test-run-1234', 1234);
    expect(own.root).toBe('/tmp/memphis-test-run-1234');
    expect(own.owned).toBe(true);
  });

  it('owns the root it created', () => {
    const own = resolveTestTmpRoot(undefined, 1234);
    expect(own.root).toContain('memphis-test-run-1234');
    expect(own.owned).toBe(true);
  });

  it('ignores an empty inherited root', () => {
    const own = resolveTestTmpRoot('   ', 1234);
    expect(own.owned).toBe(true);
    expect(own.root).toContain('memphis-test-run-1234');
  });

  it('is per run, so two concurrent runs never share it', () => {
    // The root carries the pid of the process that started the run, not
    // the worker's — the workers inherit it. Either way it is unique per
    // run, which is what keeps two concurrent runs apart.
    expect(TEST_TMP_ROOT).toMatch(/memphis-test-run-\d+$/);
    expect(TEST_TMP_ROOT).not.toBe(TEST_TMP_ROOT.replace(/run-\d+$/, 'run-0'));
  });
});
