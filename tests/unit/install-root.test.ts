import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

import {
  resolveInstallRoot,
  resolveInstallRootWithSource,
} from '../../src/infra/runtime/install-root.js';
import { realTmpdir as tmpdir } from '../helpers/tmpdir.js';


function makePackage(root: string, name: string): void {
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name }, null, 2));
}

let scratch = '';
let checkout = '';

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'memphis-install-root-'));
  checkout = join(scratch, 'memphis');
  mkdirSync(checkout, { recursive: true });
  makePackage(checkout, '@memphis-chains/memphis');
});

describe('resolveInstallRoot — env override wins', () => {
  it('MEMPHIS_RUNTIME_ROOT pointing at a valid checkout is returned verbatim', () => {
    const result = resolveInstallRootWithSource({
      rawEnv: { MEMPHIS_RUNTIME_ROOT: checkout },
      cwd: '/tmp', // deliberately wrong — override must win
    });
    expect(result.root).toBe(checkout);
    expect(result.source).toBe('env-override');
  });

  it('MEMPHIS_RUNTIME_ROOT pointing at a non-checkout is ignored', () => {
    const unrelated = mkdtempSync(join(tmpdir(), 'unrelated-'));
    const result = resolveInstallRootWithSource({
      rawEnv: { MEMPHIS_RUNTIME_ROOT: unrelated },
      cwd: checkout, // correct cwd as fallback
    });
    expect(result.root).toBe(checkout);
    expect(result.source).toBe('cwd-fallback');
  });
});

describe('resolveInstallRoot — walk-up from import URL', () => {
  it('finds the package root from a nested module path', () => {
    const nestedDir = join(checkout, 'dist/infra/cli');
    mkdirSync(nestedDir, { recursive: true });
    const nestedFile = join(nestedDir, 'index.js');
    writeFileSync(nestedFile, '// cli entry');

    const result = resolveInstallRootWithSource({
      rawEnv: {},
      cwd: '/tmp',
      importUrl: `file://${nestedFile}`,
    });
    expect(result.root).toBe(checkout);
    expect(result.source).toBe('binary-path');
  });
});

describe('resolveInstallRoot — cwd fallback', () => {
  it('walks up from cwd when no env override or import URL is given', () => {
    const inside = join(checkout, 'src/infra/cli');
    mkdirSync(inside, { recursive: true });
    const result = resolveInstallRootWithSource({
      rawEnv: {},
      cwd: inside,
    });
    expect(result.root).toBe(checkout);
    expect(result.source).toBe('cwd-fallback');
  });

  it('throws with actionable guidance when all discovery paths miss', () => {
    // Simulate the pathological case: no env override, no matching cwd,
    // no importUrl, and `process.argv[1]` sits outside any memphis
    // checkout. We stub argv[1] for the duration of the call.
    const nothing = mkdtempSync(join(tmpdir(), 'no-package-'));
    const saved = process.argv[1];
    process.argv[1] = join(nothing, 'fake-bin');
    try {
      expect(() =>
        resolveInstallRoot({
          rawEnv: {},
          cwd: nothing,
          importUrl: `file://${join(nothing, 'virtual')}`,
        }),
      ).toThrow(/MEMPHIS_RUNTIME_ROOT/);
    } finally {
      process.argv[1] = saved;
    }
  });
});
