import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, it, vi } from 'vitest';

vi.mock('node:os', async (original) => {
  const actual = await original<typeof import('node:os')>();
  return { ...actual, tmpdir: vi.fn(actual.tmpdir) };
});

import {
  assertChainWriteAllowed,
  isUnderTempDir,
} from '../../src/infra/storage/chain-write-guard.js';

it('accepts temporary-directory aliases and refuses symlinks escaping the root', () => {
  const root = mkdtempSync(join(tmpdir(), 'memphis-guard-alias-'));
  const temp = join(root, 'temporary');
  const outside = join(root, 'outside');
  const alias = join(root, 'alias');
  mkdirSync(temp);
  mkdirSync(outside);
  symlinkSync(temp, alias, 'dir');
  symlinkSync(outside, join(temp, 'escape'), 'dir');
  vi.mocked(tmpdir).mockReturnValue(alias);
  try {
    expect(isUnderTempDir(join(temp, 'new', 'chains'))).toBe(true);
    expect(isUnderTempDir(join(alias, 'new', 'chains'))).toBe(true);
    expect(isUnderTempDir(join(alias, 'escape', 'new', 'chains'))).toBe(false);
    expect(() =>
      assertChainWriteAllowed(join(alias, 'escape', 'chains'), { VITEST: 'true' }),
    ).toThrow(/chain-write-guard/);
    expect(isUnderTempDir(`${temp}-sibling/chains`)).toBe(false);
  } finally {
    vi.mocked(tmpdir).mockReset();
    rmSync(root, { recursive: true, force: true });
  }
});
