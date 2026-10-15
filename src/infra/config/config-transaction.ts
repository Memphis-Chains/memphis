import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

import Database from 'better-sqlite3';

import { writePrivateAtomicFile } from './private-atomic-file.js';

export interface ConfigFileUpdate {
  path: string;
  content: string;
  expectedHash: string | null;
}
// Synchronous callbacks may read the vault while holding its journal lock.
// A second SQLite connection must not try to reacquire that same writer lock.
const activeWriteLocks = new Set<string>();
export function configurationFileHash(path: string): string | null {
  try {
    return createHash('sha256').update(readFileSync(path)).digest('hex');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function validateUpdates(updates: ConfigFileUpdate[]): void {
  if (
    !Array.isArray(updates) ||
    !updates.length ||
    updates.some(
      (u) =>
        !u ||
        typeof u.path !== 'string' ||
        !isAbsolute(u.path) ||
        typeof u.content !== 'string' ||
        (u.expectedHash !== null &&
          (typeof u.expectedHash !== 'string' || !/^[a-f0-9]{64}$/.test(u.expectedHash))),
    ) ||
    new Set(updates.map((u) => resolve(u.path))).size !== updates.length
  ) {
    throw new Error('Invalid configuration transaction; recovery requires inspection');
  }
}

function openJournal(envPath: string): Database.Database {
  const directory = `${resolve(envPath)}.transactions`;
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  const path = join(directory, 'journal.sqlite');
  const db = new Database(path);
  chmodSync(path, 0o600);
  db.pragma('busy_timeout = 5000');
  db.pragma('synchronous = FULL');
  db.exec(
    'CREATE TABLE IF NOT EXISTS transactions (id INTEGER PRIMARY KEY, status TEXT NOT NULL, updates TEXT NOT NULL, previous TEXT NOT NULL, created_at TEXT NOT NULL)',
  );
  return db;
}

/** Caller holds SQLite's exclusive writer transaction. The durable intent was
 * committed before any target file changed. A crash rolls back only completion,
 * so the next process repeats the same atomic file publications (roll forward).
 */
function completePending(db: Database.Database, afterWrite?: (index: number) => void): boolean {
  const rows = db
    .prepare("SELECT id, updates FROM transactions WHERE status = 'prepared' ORDER BY id")
    .all() as Array<{ id: number; updates: string }>;
  for (const row of rows) {
    const updates = JSON.parse(row.updates) as ConfigFileUpdate[];
    validateUpdates(updates);
    for (const update of updates) {
      // Do not silently overwrite an unrelated edit after an interrupted commit.
      const hash = configurationFileHash(update.path);
      const nextHash = createHash('sha256').update(update.content).digest('hex');
      if (hash !== update.expectedHash && hash !== nextHash) {
        throw new Error('Configuration changed outside pending transaction; recovery stopped');
      }
    }
    // Validate the entire set before publishing any file. A conflict in a later
    // target must not cause additional partial recovery writes.
    for (const [index, update] of updates.entries()) {
      writePrivateAtomicFile(update.path, update.content);
      afterWrite?.(index);
    }
    db.prepare("UPDATE transactions SET status = 'committed' WHERE id = ?").run(row.id);
  }
  return rows.length > 0;
}

export function recoverConfigurationTransaction(envPath: string): boolean {
  if (activeWriteLocks.has(resolve(envPath))) return false;
  if (!existsSync(join(`${resolve(envPath)}.transactions`, 'journal.sqlite'))) return false;
  const db = openJournal(envPath);
  try {
    return db.transaction(() => completePending(db)).immediate();
  } finally {
    db.close();
  }
}

/** Private recovery history contains configuration material: never expose it in
 * diagnostics or include it in ordinary archives. Fault seam is test-only.
 */
export function commitConfigurationTransaction(
  envPath: string,
  updates: ConfigFileUpdate[],
  afterWrite?: (index: number) => void,
): void {
  if (activeWriteLocks.has(resolve(envPath))) {
    throw new Error('Cannot prepare a configuration transaction inside a write callback');
  }
  validateUpdates(updates);
  const db = openJournal(envPath);
  try {
    db.transaction(() => {
      completePending(db);
      for (const update of updates) {
        if (
          !isAbsolute(update.path) ||
          configurationFileHash(update.path) !== update.expectedHash
        ) {
          throw new Error('Configuration changed during preparation; retry rotation');
        }
      }
      const previous = updates.map((update) => ({
        path: update.path,
        content: existsSync(update.path) ? readFileSync(update.path, 'utf8') : null,
      }));
      db.prepare(
        "INSERT INTO transactions(status, updates, previous, created_at) VALUES ('prepared', ?, ?, ?)",
      ).run(JSON.stringify(updates), JSON.stringify(previous), new Date().toISOString());
    }).immediate();
    db.transaction(() => completePending(db, afterWrite)).immediate();
  } finally {
    db.close();
  }
}

/** Serialize generic env mutations with rotation and recover pending intent first. */
export function withConfigurationWriteLock<T>(envPath: string, write: () => T): T {
  const lockPath = resolve(envPath);
  if (activeWriteLocks.has(lockPath)) {
    throw new Error('Nested configuration write callbacks are not supported');
  }
  const db = openJournal(envPath);
  try {
    // Commit recovered intent before invoking a generic mutation. If that
    // callback fails, its rollback must not resurrect a completed rotation.
    // Recheck under the lock because another process can prepare a rotation
    // between transactions.
    for (;;) {
      let result: T | undefined;
      const recovered = db
        .transaction(() => {
          if (completePending(db)) return true;
          activeWriteLocks.add(lockPath);
          try {
            result = write();
          } finally {
            activeWriteLocks.delete(lockPath);
          }
          return false;
        })
        .immediate();
      if (!recovered) return result as T;
    }
  } finally {
    db.close();
  }
}
