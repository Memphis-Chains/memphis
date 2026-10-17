import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
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

/** First base owns new intent; all bases participate in locking and recovery. */
export type ConfigurationJournals = string | readonly string[];

function journalBases(journals: ConfigurationJournals): readonly string[] {
  const bases = typeof journals === 'string' ? [journals] : journals;
  if (!bases.length || bases.some((base) => !base.trim()))
    throw new Error('Configuration journal paths must not be empty');
  return bases;
}

function journalFile(base: string): string {
  return join(`${resolve(base)}.transactions`, 'journal.sqlite');
}

function journalIdentity(base: string): string {
  const path = journalFile(base);
  try {
    return realpathSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return path;
    throw error;
  }
}

function heldJournalCount(bases: readonly string[]): number {
  return bases.filter((base) => activeWriteLocks.has(journalIdentity(base))).length;
}

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
  try {
    chmodSync(path, 0o600);
    db.pragma('busy_timeout = 5000');
    db.pragma('synchronous = FULL');
    db.exec(
      'CREATE TABLE IF NOT EXISTS transactions (id INTEGER PRIMARY KEY, status TEXT NOT NULL, updates TEXT NOT NULL, previous TEXT NOT NULL, created_at TEXT NOT NULL)',
    );
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
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

interface JournalConnection {
  path: string;
  db: Database.Database;
}

function withJournals<T>(
  bases: readonly string[],
  use: (all: JournalConnection[], primary: Database.Database) => T,
): T {
  const opened = new Map<string, Database.Database>();
  try {
    // Create/open before locking, then canonicalize and deduplicate aliases.
    // Rust uses the same canonical-path byte order for its snapshot locks.
    for (const base of bases) {
      const identity = journalIdentity(base);
      if (opened.has(identity)) continue;
      const db = openJournal(base);
      const canonical = journalIdentity(base);
      if (opened.has(canonical)) db.close();
      else opened.set(canonical, db);
    }
    const primary = opened.get(journalIdentity(bases[0]))!;
    const all = [...opened]
      .map(([path, db]) => ({ path, db }))
      .sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
    return use(all, primary);
  } finally {
    for (const db of opened.values()) db.close();
  }
}

function lockedTransaction<T>(all: JournalConnection[], work: () => T): T {
  try {
    for (const { db } of all) db.exec('BEGIN IMMEDIATE');
    const result = work();
    for (const { db } of [...all].reverse()) db.exec('COMMIT');
    return result;
  } finally {
    for (const { db } of [...all].reverse()) {
      if (db.inTransaction) db.exec('ROLLBACK');
    }
  }
}

function completeAll(all: JournalConnection[], afterWrite?: (index: number) => void): boolean {
  const pending = all.filter(({ db }) =>
    db.prepare("SELECT 1 FROM transactions WHERE status = 'prepared' LIMIT 1").get(),
  );
  // Old independent writers may have prepared incompatible generations. There
  // is no cross-journal sequence number: never guess an order and publish one.
  if (pending.length > 1)
    throw new Error(
      'Pending transactions in multiple configuration journals; recovery requires inspection',
    );
  return pending.length === 1 ? completePending(pending[0].db, afterWrite) : false;
}

export function recoverConfigurationTransaction(journals: ConfigurationJournals): boolean {
  const bases = journalBases(journals);
  const held = heldJournalCount(bases);
  if (held === bases.length) return false;
  if (held) throw new Error('Cannot expand configuration locks inside a write callback');
  if (!bases.some((base) => existsSync(journalFile(base)))) return false;
  return withJournals(bases, (all) => lockedTransaction(all, () => completeAll(all)));
}

/** Private recovery history contains configuration material: never expose it in
 * diagnostics or include it in ordinary archives. Fault seam is test-only.
 */
export function commitConfigurationTransaction(
  journals: ConfigurationJournals,
  updates: ConfigFileUpdate[],
  afterWrite?: (index: number) => void,
): void {
  const bases = journalBases(journals);
  if (heldJournalCount(bases)) {
    throw new Error('Cannot prepare a configuration transaction inside a write callback');
  }
  validateUpdates(updates);
  withJournals(bases, (all, primary) => {
    for (;;) {
      const recovered = lockedTransaction(all, () => {
        if (completeAll(all)) return true;
        for (const update of updates) {
          if (configurationFileHash(update.path) !== update.expectedHash)
            throw new Error('Configuration changed during preparation; retry rotation');
        }
        const previous = updates.map((update) => ({
          path: update.path,
          content: existsSync(update.path) ? readFileSync(update.path, 'utf8') : null,
        }));
        primary
          .prepare(
            "INSERT INTO transactions(status, updates, previous, created_at) VALUES ('prepared', ?, ?, ?)",
          )
          .run(JSON.stringify(updates), JSON.stringify(previous), new Date().toISOString());
        return false;
      });
      if (!recovered) break;
    }
    // Release every lock after durable intent, then reacquire in the same order.
    // Keeping a later lock while reacquiring an earlier one can deadlock native.
    lockedTransaction(all, () => completeAll(all, afterWrite));
  });
}

/** Keep synchronous reads (including cache updates) on one recovered snapshot.
 * Reads inside a writer may reuse its locks, but cannot expand the lock set.
 */
export function withConfigurationSnapshot<T>(journals: ConfigurationJournals, read: () => T): T {
  const bases = journalBases(journals);
  const held = heldJournalCount(bases);
  if (held === bases.length) return read();
  if (held) throw new Error('Cannot expand configuration locks inside a snapshot callback');
  return withConfigurationWriteLock(bases, read);
}

/** Serialize mutations with every compatible journal and recover intent first. */
export function withConfigurationWriteLock<T>(journals: ConfigurationJournals, write: () => T): T {
  const bases = journalBases(journals);
  if (heldJournalCount(bases)) {
    throw new Error('Nested configuration write callbacks are not supported');
  }
  return withJournals(bases, (all) => {
    for (;;) {
      let result: T | undefined;
      const recovered = lockedTransaction(all, () => {
        if (completeAll(all)) return true;
        for (const { path } of all) activeWriteLocks.add(path);
        try {
          result = write();
        } finally {
          for (const { path } of all) activeWriteLocks.delete(path);
        }
        return false;
      });
      if (!recovered) return result as T;
    }
  });
}
