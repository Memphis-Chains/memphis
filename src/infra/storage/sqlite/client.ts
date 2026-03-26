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

    CREATE TABLE IF NOT EXISTS tool_permissions (
      tool_name TEXT PRIMARY KEY,
      policy TEXT NOT NULL CHECK (policy IN ('allow', 'deny', 'require-approval')),
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS tool_call_approvals (
      request_id TEXT PRIMARY KEY,
      tool_name TEXT NOT NULL,
      arguments_json TEXT NOT NULL,
      caller_id TEXT NOT NULL DEFAULT 'agent',
      state TEXT NOT NULL CHECK (state IN ('pending', 'approved', 'denied', 'expired', 'used')),
      expires_at_ms INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_tool_call_approvals_state
      ON tool_call_approvals(state, expires_at_ms);

    CREATE INDEX IF NOT EXISTS idx_tool_call_approvals_tool
      ON tool_call_approvals(tool_name, state);

    CREATE TABLE IF NOT EXISTS evolve_sessions (
      id TEXT PRIMARY KEY,
      authorized_at TEXT NOT NULL,
      expires_at_ms INTEGER NOT NULL,
      intent TEXT NOT NULL,
      snapshot_id TEXT,
      branch TEXT,
      files_allowed_json TEXT,
      status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'active', 'committed', 'rolled-back', 'expired')),
      committed_hash TEXT,
      error_message TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_evolve_sessions_status
      ON evolve_sessions(status);

    CREATE INDEX IF NOT EXISTS idx_evolve_sessions_branch
      ON evolve_sessions(branch);
  `);

  // Migration: add original_branch column (idempotent for existing DBs)
  try {
    db.exec(`ALTER TABLE evolve_sessions ADD COLUMN original_branch TEXT`);
  } catch {
    // Column already exists
  }

  // Migration v6: replay protection — persist seen proposal IDs across restarts
  db.exec(`
    CREATE TABLE IF NOT EXISTS seen_proposals (
      proposal_id TEXT PRIMARY KEY,
      received_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_seen_proposals_received_at
      ON seen_proposals(received_at);
  `);

  // Migration v7: scheduled jobs — persistent job queue for memphis_schedule
  db.exec(`
    CREATE TABLE IF NOT EXISTS scheduled_jobs (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      payload TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'completed', 'failed', 'canceled')),
      scheduled_at_ms INTEGER NOT NULL,
      interval_ms INTEGER,
      last_run_at TEXT,
      retry_count INTEGER NOT NULL DEFAULT 0,
      max_retries INTEGER NOT NULL DEFAULT 3,
      error_message TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_scheduled_jobs_status_scheduled
      ON scheduled_jobs(status, scheduled_at_ms);
  `);

  // Migration v8: federation — webhook events staging + agent peer discovery
  db.exec(`
    CREATE TABLE IF NOT EXISTS webhook_events (
      event_id TEXT PRIMARY KEY,
      source TEXT NOT NULL,
      event_type TEXT NOT NULL,
      payload TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
      retry_count INTEGER NOT NULL DEFAULT 0,
      max_retries INTEGER NOT NULL DEFAULT 3,
      error_message TEXT,
      received_at INTEGER NOT NULL,
      processed_at INTEGER,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_webhook_events_status
      ON webhook_events(status, received_at);

    CREATE TABLE IF NOT EXISTS agent_peers (
      did TEXT PRIMARY KEY,
      name TEXT,
      endpoint TEXT NOT NULL,
      capabilities TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'unknown' CHECK (status IN ('online', 'offline', 'unknown')),
      last_seen_at TEXT,
      registered_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_agent_peers_status
      ON agent_peers(status);
  `);

  // Migration v9: exact memory search — derived FTS5 index for exact phrase lookup
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_search_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_key TEXT NOT NULL UNIQUE,
      chain_name TEXT NOT NULL,
      block_index INTEGER NOT NULL,
      block_hash TEXT NOT NULL,
      block_type TEXT NOT NULL,
      content TEXT NOT NULL,
      summary TEXT NOT NULL,
      tags_json TEXT NOT NULL DEFAULT '[]',
      tags_text TEXT NOT NULL DEFAULT '',
      metadata_json TEXT NOT NULL DEFAULT '{}',
      indexed_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_memory_search_entries_chain_block
      ON memory_search_entries(chain_name, block_index DESC);

    CREATE VIRTUAL TABLE IF NOT EXISTS memory_search_fts USING fts5(
      content,
      tags_text,
      summary,
      content='memory_search_entries',
      content_rowid='id',
      tokenize='unicode61'
    );

    CREATE TRIGGER IF NOT EXISTS memory_search_entries_ai AFTER INSERT ON memory_search_entries BEGIN
      INSERT INTO memory_search_fts(rowid, content, tags_text, summary)
      VALUES (new.id, new.content, new.tags_text, new.summary);
    END;

    CREATE TRIGGER IF NOT EXISTS memory_search_entries_ad AFTER DELETE ON memory_search_entries BEGIN
      INSERT INTO memory_search_fts(memory_search_fts, rowid, content, tags_text, summary)
      VALUES('delete', old.id, old.content, old.tags_text, old.summary);
    END;

    CREATE TRIGGER IF NOT EXISTS memory_search_entries_au AFTER UPDATE ON memory_search_entries BEGIN
      INSERT INTO memory_search_fts(memory_search_fts, rowid, content, tags_text, summary)
      VALUES('delete', old.id, old.content, old.tags_text, old.summary);
      INSERT INTO memory_search_fts(rowid, content, tags_text, summary)
      VALUES (new.id, new.content, new.tags_text, new.summary);
    END;
  `);

  db.prepare(
    `INSERT INTO _meta(key, value) VALUES ('schema_version', '9')
     ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
  ).run();
}
