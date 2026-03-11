import type Database from 'better-sqlite3';

import type { SessionRecord, SessionRepository } from '../../../../core/contracts/repository.js';

function mapRow(row: { id: string; created_at: string; updated_at: string }): SessionRecord {
  return {
    id: row.id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class SqliteSessionRepository implements SessionRepository {
  constructor(private readonly db: Database.Database) {}

  public ensureSession(sessionId: string): SessionRecord {
    const now = new Date().toISOString();

    this.db
      .prepare(
        `INSERT INTO sessions(id, created_at, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET updated_at=excluded.updated_at`,
      )
      .run(sessionId, now, now);

    const row = this.db
      .prepare('SELECT id, created_at, updated_at FROM sessions WHERE id = ?')
      .get(sessionId) as { id: string; created_at: string; updated_at: string } | undefined;

    if (!row) {
      throw new Error(`Session not found after ensureSession: ${sessionId}`);
    }

    return mapRow(row);
  }

  public listSessions(): SessionRecord[] {
    const rows = this.db
      .prepare('SELECT id, created_at, updated_at FROM sessions ORDER BY updated_at DESC')
      .all() as Array<{ id: string; created_at: string; updated_at: string }>;

    return rows.map(mapRow);
  }

  public getSessionById(sessionId: string): SessionRecord | null {
    const row = this.db
      .prepare('SELECT id, created_at, updated_at FROM sessions WHERE id = ?')
      .get(sessionId) as { id: string; created_at: string; updated_at: string } | undefined;

    return row ? mapRow(row) : null;
  }
}
