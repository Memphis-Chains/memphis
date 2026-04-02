import { randomUUID } from 'node:crypto';

import type Database from 'better-sqlite3';

export type WorkerSessionRecord = {
  sessionId: string;
  workerId: string;
  capabilityScope: string[];
  tokenEpoch: number;
  expiresAtMs: number;
  revokedAt?: string;
  lastSeenAt?: string;
  createdAt: string;
  updatedAt: string;
};

type WorkerSessionRow = {
  session_id: string;
  worker_id: string;
  capability_scope_json: string;
  token_epoch: number;
  expires_at_ms: number;
  revoked_at?: string;
  last_seen_at?: string;
  created_at: string;
  updated_at: string;
};

function parseScope(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown[];
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
      : [];
  } catch {
    return [];
  }
}

function mapRow(row: WorkerSessionRow): WorkerSessionRecord {
  return {
    sessionId: row.session_id,
    workerId: row.worker_id,
    capabilityScope: parseScope(row.capability_scope_json),
    tokenEpoch: Number(row.token_epoch),
    expiresAtMs: Number(row.expires_at_ms),
    revokedAt: row.revoked_at,
    lastSeenAt: row.last_seen_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class SqliteWorkerSessionRepository {
  constructor(private readonly db: Database.Database) {}

  public create(input: {
    workerId: string;
    capabilityScope: string[];
    expiresAtMs: number;
  }): WorkerSessionRecord {
    const now = new Date().toISOString();
    const sessionId = randomUUID();
    this.db
      .prepare(
        `INSERT INTO worker_sessions (
           session_id, worker_id, capability_scope_json, token_epoch, expires_at_ms,
           revoked_at, last_seen_at, created_at, updated_at
         ) VALUES (?, ?, ?, 1, ?, NULL, ?, ?, ?)`,
      )
      .run(
        sessionId,
        input.workerId,
        JSON.stringify(input.capabilityScope),
        input.expiresAtMs,
        now,
        now,
        now,
      );

    return {
      sessionId,
      workerId: input.workerId,
      capabilityScope: [...input.capabilityScope],
      tokenEpoch: 1,
      expiresAtMs: input.expiresAtMs,
      lastSeenAt: now,
      createdAt: now,
      updatedAt: now,
    };
  }

  public get(sessionId: string): WorkerSessionRecord | null {
    const row = this.db
      .prepare(
        `SELECT session_id, worker_id, capability_scope_json, token_epoch, expires_at_ms,
                revoked_at, last_seen_at, created_at, updated_at
         FROM worker_sessions
         WHERE session_id = ?
         LIMIT 1`,
      )
      .get(sessionId) as WorkerSessionRow | undefined;
    return row ? mapRow(row) : null;
  }

  public touch(sessionId: string, expiresAtMs?: number): WorkerSessionRecord | null {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE worker_sessions
         SET last_seen_at = ?, updated_at = ?, expires_at_ms = COALESCE(?, expires_at_ms)
         WHERE session_id = ?`,
      )
      .run(now, now, expiresAtMs ?? null, sessionId);
    return this.get(sessionId);
  }

  public revoke(sessionId: string): WorkerSessionRecord | null {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE worker_sessions
         SET revoked_at = ?, token_epoch = token_epoch + 1, updated_at = ?
         WHERE session_id = ?`,
      )
      .run(now, now, sessionId);
    return this.get(sessionId);
  }

  public snapshot(nowMs = Date.now()): {
    total: number;
    active: number;
    revoked: number;
    expired: number;
  } {
    const row = this.db
      .prepare(
        `SELECT
           COUNT(*) AS total,
           SUM(CASE WHEN revoked_at IS NULL AND expires_at_ms >= ? THEN 1 ELSE 0 END) AS active,
           SUM(CASE WHEN revoked_at IS NOT NULL THEN 1 ELSE 0 END) AS revoked,
           SUM(CASE WHEN revoked_at IS NULL AND expires_at_ms < ? THEN 1 ELSE 0 END) AS expired
         FROM worker_sessions`,
      )
      .get(nowMs, nowMs) as
      | {
          total: number;
          active: number | null;
          revoked: number | null;
          expired: number | null;
        }
      | undefined;

    return {
      total: Number(row?.total ?? 0),
      active: Number(row?.active ?? 0),
      revoked: Number(row?.revoked ?? 0),
      expired: Number(row?.expired ?? 0),
    };
  }
}
