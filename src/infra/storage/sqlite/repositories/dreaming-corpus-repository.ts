import type Database from 'better-sqlite3';

import type { CorpusRow } from '../../../../cognitive/dreaming/corpus.js';

/**
 * The dreaming corpus, read from the operator chat log.
 *
 * WHY A SEPARATE REPOSITORY
 * -------------------------
 * The operator chat repository (`operator-chat-session-repository.ts`)
 * serves one session at a time and reads forward from a sequence. The
 * dreaming corpus needs the opposite: every session, over a window,
 * ordered for reading. Reusing the session repository would mean a
 * per-session query loop for a scan that the database can do in one.
 *
 * The rows are the raw table shape. The corpus builder turns them into
 * turns; nothing here interprets the content.
 */
export interface CorpusQuery {
  /** Only sessions created at or after this instant. */
  since?: string;
  /** Only sessions created strictly before this instant. */
  until?: string;
  /** Cap on the rows read. The corpus is a view, not a copy. */
  limit?: number;
}

export class SqliteDreamingCorpusRepository {
  constructor(private readonly db: Database.Database) {}

  /**
   * Read the corpus rows.
   *
   * Ordered by session and sequence, so the corpus reads like the
   * conversations did. `created_at` is the commit time of the batch, not
   * the time of the event, so it cannot order anything — the primary key
   * `(session_id, sequence)` can.
   */
  listRows(query: CorpusQuery = {}): CorpusRow[] {
    const clauses: string[] = [];
    const params: unknown[] = [];

    if (query.since) {
      clauses.push('s.created_at >= ?');
      params.push(query.since);
    }
    if (query.until) {
      clauses.push('s.created_at < ?');
      params.push(query.until);
    }

    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const limit = query.limit && query.limit > 0 ? `LIMIT ${Math.floor(query.limit)}` : '';

    return this.db
      .prepare(
        `SELECT m.session_id, m.sequence, m.role, m.content,
                m.tool_call_id, m.tool_name, m.tool_calls_json,
                m.provider, m.model, m.created_at
         FROM operator_chat_messages m
         JOIN sessions s ON s.id = m.session_id
         ${where}
         ORDER BY m.session_id, m.sequence
         ${limit}`,
      )
      .all(...params) as CorpusRow[];
  }

  /** How many messages and sessions the corpus would contain. */
  count(query: CorpusQuery = {}): { messages: number; sessions: number } {
    const rows = this.listRows({ ...query, limit: 1_000_000 });
    const sessions = new Set(rows.map((row) => row.session_id));
    return { messages: rows.length, sessions: sessions.size };
  }
}
