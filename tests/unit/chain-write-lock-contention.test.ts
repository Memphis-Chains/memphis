import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { expect, it, vi } from 'vitest';

import { withChainWriteLock } from '../../src/infra/storage/chain-write-lock.js';

it('waits for a reader to release the commit lock without repeating the write', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'memphis-lock-reader-')));
  const chain = join(root, 'chains', 'journal');
  const directory = join(root, 'state', 'chain-locks');
  mkdirSync(chain, { recursive: true });
  mkdirSync(directory, { recursive: true });
  const path = join(directory, createHash('sha256').update(chain).digest('hex') + '.sqlite');
  const reader = new Database(path);
  reader.exec('BEGIN; SELECT * FROM sqlite_master');
  let timer: ReturnType<typeof setTimeout> | undefined;
  const write = vi.fn(async () => {
    timer = setTimeout(() => reader.exec('ROLLBACK'), 50);
    return 'persisted';
  });
  try {
    await expect(withChainWriteLock(chain, write)).resolves.toBe('persisted');
    expect(write).toHaveBeenCalledTimes(1);
    expect(reader.inTransaction).toBe(false);
  } finally {
    clearTimeout(timer);
    reader.close();
    rmSync(root, { recursive: true, force: true });
  }
});
