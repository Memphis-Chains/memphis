import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { withAppendLock } from '../../src/infra/storage/chain-adapter.js';

describe('withAppendLock', () => {
  const testDir = path.join(os.tmpdir(), `memphis-test-lock-${Date.now()}`);

  beforeAll(async () => {
    await fs.mkdir(testDir, { recursive: true });
  });

  afterAll(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
  });

  it('executes function and returns result', async () => {
    const result = await withAppendLock(testDir, fs, path, async () => {
      return 42;
    });

    expect(result).toBe(42);
  });

  it('releases lock after function completes', async () => {
    const lockPath = path.join(testDir, '.append-lock');

    await withAppendLock(testDir, fs, path, async () => {});

    // Lock should be released — file should not exist
    await expect(fs.access(lockPath)).rejects.toThrow();
  });

  it('removes lock file even when function throws', async () => {
    const lockPath = path.join(testDir, '.append-lock');

    await expect(
      withAppendLock(testDir, fs, path, async () => {
        throw new Error('intentional failure');
      }),
    ).rejects.toThrow('intentional failure');

    // Lock should still be released
    await expect(fs.access(lockPath)).rejects.toThrow();
  });

  it('allows sequential calls to succeed', async () => {
    const results: number[] = [];

    await withAppendLock(testDir, fs, path, async () => {
      await new Promise((r) => setTimeout(r, 10));
      results.push(1);
      return 1;
    });

    await withAppendLock(testDir, fs, path, async () => {
      results.push(2);
      return 2;
    });

    expect(results).toEqual([1, 2]);
  });
});
