/**
 * Loading the dreaming corpus from the runtime's own database.
 *
 * This is the seam between the pure corpus builder
 * (`src/cognitive/dreaming/corpus.ts`) and the database. It opens the
 * database the way the rest of the runtime does, reads the rows, and
 * hands them to the builder.
 *
 * The corpus is a VIEW. It is read on demand and never written back —
 * the conversations are the source of truth, and a copy of them would
 * be a second thing that can go stale.
 */

import { existsSync } from 'node:fs';

import Database from 'better-sqlite3';

import { buildCorpus, corpusStats, type CorpusStats, type DreamingTurn } from './corpus.js';
import { SqliteDreamingCorpusRepository } from '../../infra/storage/sqlite/repositories/dreaming-corpus-repository.js';

const DEFAULT_DATABASE_URL = 'file:./data/memphis.db';

function getDatabaseUrl(rawEnv: NodeJS.ProcessEnv = process.env): string {
  return rawEnv.DATABASE_URL?.trim() || DEFAULT_DATABASE_URL;
}

export interface DreamingCorpus {
  status: 'ok' | 'missing';
  turns: DreamingTurn[];
  stats: CorpusStats;
}

export interface LoadDreamingCorpusOptions {
  rawEnv?: NodeJS.ProcessEnv;
  /** Only sessions created at or after this instant. */
  since?: string;
  /** Only sessions created strictly before this instant. */
  until?: string;
  /** Cap on the rows read. */
  limit?: number;
}

/**
 * Read the corpus.
 *
 * Returns an empty corpus when the database is not there — a runtime
 * without a chat log has nothing to dream about, and that is not an
 * error.
 */
export function loadDreamingCorpus(options: LoadDreamingCorpusOptions = {}): DreamingCorpus {
  const databaseUrl = getDatabaseUrl(options.rawEnv ?? process.env);
  if (!databaseUrl.startsWith('file:') || !databaseUrl.slice(5)) {
    throw new Error('Unsupported or empty SQLite database URL');
  }
  const databasePath = databaseUrl.slice(5);
  if (!existsSync(databasePath)) {
    return { status: 'missing', turns: [], stats: corpusStats([], []) };
  }
  const db = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    // One deferred, read-only transaction gives every query a consistent
    // SQLite snapshot while preserving visibility of a live WAL.
    return db.transaction(() => {
      const repository = new SqliteDreamingCorpusRepository(db);
      const rows = repository.listRows({
        since: options.since,
        until: options.until,
        limit: options.limit,
      });
      const turns = buildCorpus(rows);
      return { status: 'ok' as const, turns, stats: corpusStats(turns, rows) };
    })();
  } finally {
    db.close();
  }
}
