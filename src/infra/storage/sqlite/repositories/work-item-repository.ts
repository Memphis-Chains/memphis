import { randomUUID } from 'node:crypto';

import type Database from 'better-sqlite3';

export type WorkItemStatus = 'pending' | 'leased' | 'completed' | 'failed' | 'canceled';

export type WorkItemRecord = {
  workId: string;
  type: string;
  actorId?: string;
  conversationId?: string;
  capabilityScope: string[];
  payload: Record<string, unknown>;
  status: WorkItemStatus;
  leaseSessionId?: string;
  leaseExpiresAtMs?: number;
  heartbeatAtMs?: number;
  attempts: number;
  result?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

type WorkItemRow = {
  work_id: string;
  type: string;
  actor_id?: string;
  conversation_id?: string;
  capability_scope_json: string;
  payload_json: string;
  status: WorkItemStatus;
  lease_session_id?: string;
  lease_expires_at_ms?: number;
  heartbeat_at_ms?: number;
  attempts: number;
  result_json?: string;
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

function parseRecord(raw: string | undefined): Record<string, unknown> | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function mapRow(row: WorkItemRow): WorkItemRecord {
  return {
    workId: row.work_id,
    type: row.type,
    actorId: row.actor_id,
    conversationId: row.conversation_id,
    capabilityScope: parseScope(row.capability_scope_json),
    payload: parseRecord(row.payload_json) ?? {},
    status: row.status,
    leaseSessionId: row.lease_session_id,
    leaseExpiresAtMs: row.lease_expires_at_ms,
    heartbeatAtMs: row.heartbeat_at_ms,
    attempts: Number(row.attempts),
    result: parseRecord(row.result_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class SqliteWorkItemRepository {
  constructor(private readonly db: Database.Database) {}

  public enqueue(input: {
    type: string;
    actorId?: string;
    conversationId?: string;
    capabilityScope?: string[];
    payload?: Record<string, unknown>;
  }): WorkItemRecord {
    const now = new Date().toISOString();
    const workId = randomUUID();
    this.db
      .prepare(
        `INSERT INTO work_items (
           work_id, type, actor_id, conversation_id, capability_scope_json, payload_json, status,
           lease_session_id, lease_expires_at_ms, heartbeat_at_ms, attempts, result_json, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, 'pending', NULL, NULL, NULL, 0, NULL, ?, ?)`,
      )
      .run(
        workId,
        input.type,
        input.actorId ?? null,
        input.conversationId ?? null,
        JSON.stringify(input.capabilityScope ?? []),
        JSON.stringify(input.payload ?? {}),
        now,
        now,
      );
    return this.getById(workId)!;
  }

  public getById(workId: string): WorkItemRecord | null {
    const row = this.db
      .prepare(
        `SELECT work_id, type, actor_id, conversation_id, capability_scope_json, payload_json, status,
                lease_session_id, lease_expires_at_ms, heartbeat_at_ms, attempts, result_json, created_at, updated_at
         FROM work_items
         WHERE work_id = ?
         LIMIT 1`,
      )
      .get(workId) as WorkItemRow | undefined;
    return row ? mapRow(row) : null;
  }

  public leaseNext(input: {
    workerSessionId: string;
    capabilityScope: string[];
    leaseExpiresAtMs: number;
    nowMs?: number;
  }): WorkItemRecord | null {
    const nowMs = input.nowMs ?? Date.now();
    const nowIso = new Date(nowMs).toISOString();

    this.db
      .prepare(
        `UPDATE work_items
         SET status = 'pending', lease_session_id = NULL, lease_expires_at_ms = NULL, heartbeat_at_ms = NULL, updated_at = ?
         WHERE status = 'leased' AND lease_expires_at_ms IS NOT NULL AND lease_expires_at_ms < ?`,
      )
      .run(nowIso, nowMs);

    const rows = this.db
      .prepare(
        `SELECT work_id, type, actor_id, conversation_id, capability_scope_json, payload_json, status,
                lease_session_id, lease_expires_at_ms, heartbeat_at_ms, attempts, result_json, created_at, updated_at
         FROM work_items
         WHERE status = 'pending'
         ORDER BY created_at ASC, work_id ASC`,
      )
      .all() as WorkItemRow[];

    const candidate = rows
      .map(mapRow)
      .find((row) =>
        row.capabilityScope.every((capability) => input.capabilityScope.includes(capability)),
      );
    if (!candidate) return null;

    this.db
      .prepare(
        `UPDATE work_items
         SET status = 'leased',
             lease_session_id = ?,
             lease_expires_at_ms = ?,
             heartbeat_at_ms = ?,
             attempts = attempts + 1,
             updated_at = ?
         WHERE work_id = ?`,
      )
      .run(input.workerSessionId, input.leaseExpiresAtMs, nowMs, nowIso, candidate.workId);

    return this.getById(candidate.workId);
  }

  public acknowledgeLease(
    workId: string,
    workerSessionId: string,
    leaseExpiresAtMs: number,
  ): WorkItemRecord | null {
    const nowMs = Date.now();
    const nowIso = new Date(nowMs).toISOString();
    this.db
      .prepare(
        `UPDATE work_items
         SET lease_expires_at_ms = ?, heartbeat_at_ms = ?, updated_at = ?
         WHERE work_id = ? AND status = 'leased' AND lease_session_id = ?`,
      )
      .run(leaseExpiresAtMs, nowMs, nowIso, workId, workerSessionId);
    return this.getById(workId);
  }

  public heartbeat(
    workId: string,
    workerSessionId: string,
    leaseExpiresAtMs: number,
  ): WorkItemRecord | null {
    const nowMs = Date.now();
    const nowIso = new Date(nowMs).toISOString();
    this.db
      .prepare(
        `UPDATE work_items
         SET heartbeat_at_ms = ?, lease_expires_at_ms = ?, updated_at = ?
         WHERE work_id = ? AND status = 'leased' AND lease_session_id = ?`,
      )
      .run(nowMs, leaseExpiresAtMs, nowIso, workId, workerSessionId);
    return this.getById(workId);
  }

  public complete(input: {
    workId: string;
    workerSessionId: string;
    status: Extract<WorkItemStatus, 'completed' | 'failed' | 'canceled'>;
    result?: Record<string, unknown>;
  }): WorkItemRecord | null {
    const nowIso = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE work_items
         SET status = ?, result_json = ?, lease_session_id = NULL, lease_expires_at_ms = NULL,
             heartbeat_at_ms = NULL, updated_at = ?
         WHERE work_id = ? AND lease_session_id = ?`,
      )
      .run(
        input.status,
        JSON.stringify(input.result ?? {}),
        nowIso,
        input.workId,
        input.workerSessionId,
      );
    return this.getById(input.workId);
  }

  public snapshot(nowMs = Date.now()): {
    total: number;
    pending: number;
    leased: number;
    completed: number;
    failed: number;
    canceled: number;
    overdueLeases: number;
  } {
    const row = this.db
      .prepare(
        `SELECT
           COUNT(*) AS total,
           SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
           SUM(CASE WHEN status = 'leased' THEN 1 ELSE 0 END) AS leased,
           SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed,
           SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
           SUM(CASE WHEN status = 'canceled' THEN 1 ELSE 0 END) AS canceled,
           SUM(CASE WHEN status = 'leased' AND lease_expires_at_ms IS NOT NULL AND lease_expires_at_ms < ? THEN 1 ELSE 0 END) AS overdue_leases
         FROM work_items`,
      )
      .get(nowMs) as
      | {
          total: number;
          pending: number | null;
          leased: number | null;
          completed: number | null;
          failed: number | null;
          canceled: number | null;
          overdue_leases: number | null;
        }
      | undefined;

    return {
      total: Number(row?.total ?? 0),
      pending: Number(row?.pending ?? 0),
      leased: Number(row?.leased ?? 0),
      completed: Number(row?.completed ?? 0),
      failed: Number(row?.failed ?? 0),
      canceled: Number(row?.canceled ?? 0),
      overdueLeases: Number(row?.overdue_leases ?? 0),
    };
  }
}
