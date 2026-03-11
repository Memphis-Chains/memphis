import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import Database from 'better-sqlite3';

function resolveSqlitePath(databaseUrl: string): string {
  if (!databaseUrl.startsWith('file:')) {
    throw new Error(`Unsupported DATABASE_URL for sqlite client: ${databaseUrl}`);
  }

  return databaseUrl.replace(/^file:/, '');
}

export function createSqliteClient(databaseUrl: string): Database.Database {
  const dbPath = resolveSqlitePath(databaseUrl);
  mkdirSync(dirname(dbPath), { recursive: true });

  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  return db;
}

export function runMigrations(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS _meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS generation_events (
      id TEXT PRIMARY KEY,
      session_id TEXT,
      provider_used TEXT NOT NULL,
      model_used TEXT,
      timing_ms INTEGER NOT NULL,
      request_id TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY(session_id) REFERENCES sessions(id)
    );

    CREATE INDEX IF NOT EXISTS idx_generation_events_session_created
      ON generation_events(session_id, created_at DESC);

    CREATE INDEX IF NOT EXISTS idx_generation_events_created_at
      ON generation_events(created_at DESC);

    CREATE INDEX IF NOT EXISTS idx_generation_events_request_id
      ON generation_events(request_id);

    CREATE INDEX IF NOT EXISTS idx_sessions_updated_at
      ON sessions(updated_at DESC);
  `);

  db.prepare(
    `INSERT INTO _meta(key, value) VALUES ('schema_version', '1')
     ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
  ).run();
}
