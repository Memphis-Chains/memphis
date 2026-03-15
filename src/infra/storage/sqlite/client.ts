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

    CREATE TABLE IF NOT EXISTS approvals (
      approval_request_id TEXT PRIMARY KEY,
      initiator_id TEXT NOT NULL,
      approver_id TEXT NOT NULL,
      state_version INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      CHECK (initiator_id <> approver_id)
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_approvals_request
      ON approvals(approval_request_id);

    CREATE TABLE IF NOT EXISTS dual_approval_requests (
      request_id TEXT PRIMARY KEY,
      action TEXT NOT NULL CHECK (action IN ('freeze', 'unfreeze')),
      state TEXT NOT NULL CHECK (state IN ('pending', 'approved', 'expired', 'canceled')),
      initiator_id TEXT NOT NULL,
      approver_id TEXT,
      reason TEXT,
      signature TEXT,
      expires_at_ms INTEGER NOT NULL,
      state_version INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      CHECK (approver_id IS NULL OR initiator_id <> approver_id)
    );

    CREATE INDEX IF NOT EXISTS idx_dual_approval_state
      ON dual_approval_requests(state, expires_at_ms);

    CREATE TABLE IF NOT EXISTS dual_approval_events (
      event_id TEXT PRIMARY KEY,
      request_id TEXT NOT NULL,
      from_state TEXT,
      to_state TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      signature TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY(request_id) REFERENCES dual_approval_requests(request_id)
    );

    CREATE INDEX IF NOT EXISTS idx_dual_approval_events_request_created
      ON dual_approval_events(request_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS dual_approval_idempotency (
      approval_request_id TEXT PRIMARY KEY,
      request_id TEXT NOT NULL,
      action TEXT NOT NULL CHECK (action IN ('approve', 'cancel')),
      actor_id TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_dual_approval_idempotency_request
      ON dual_approval_idempotency(request_id, created_at DESC);
  `);

  db.prepare(
    `INSERT INTO _meta(key, value) VALUES ('schema_version', '1')
     ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
  ).run();
}
