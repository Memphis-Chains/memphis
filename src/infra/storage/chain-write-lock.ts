import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, realpathSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

import Database from 'better-sqlite3';

/** Shared with native chain_write_lock.rs. SQLite releases locks on process
 * death; no wall-clock lease can steal a slow writer's allocation sequence. */
export async function withChainWriteLock<T>(
  chainDirectory: string,
  write: () => Promise<T>,
): Promise<T> {
  mkdirSync(chainDirectory, { recursive: true });
  const canonical = realpathSync(chainDirectory);
  const parent = dirname(canonical);
  const root = basename(parent) === 'chains' ? dirname(parent) : parent;
  const directory = join(root, 'state', 'chain-locks');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, `${createHash('sha256').update(canonical).digest('hex')}.sqlite`);
  const db = new Database(path, { timeout: 0 });
  let acquired = false;
  try {
    chmodSync(path, 0o600);
    const deadline = Date.now() + 10_000;
    async function executeWhenAvailable(sql: string): Promise<void> {
      while (true) {
        try {
          db.exec(sql);
          return;
        } catch (error) {
          if ((error as { code?: string }).code !== 'SQLITE_BUSY' || Date.now() >= deadline)
            throw new Error('Chain writer lock unavailable');
          await new Promise((done) => setTimeout(done, 10));
        }
      }
    }
    await executeWhenAvailable('BEGIN IMMEDIATE');
    acquired = true;
    db.pragma('user_version = 1');
    const result = await write();
    // SQLite can still have transient readers when upgrading to the exclusive
    // commit lock. Retry that transition without rerunning the write callback.
    await executeWhenAvailable('COMMIT');
    acquired = false;
    return result;
  } finally {
    try {
      if (acquired) db.exec('ROLLBACK');
    } finally {
      db.close();
    }
  }
}
