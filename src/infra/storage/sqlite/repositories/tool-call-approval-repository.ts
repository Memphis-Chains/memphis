import { randomUUID } from 'node:crypto';

import type Database from 'better-sqlite3';

export type ToolCallApprovalState = 'pending' | 'approved' | 'denied' | 'expired' | 'used';

export interface ToolCallApproval {
  requestId: string;
  toolName: string;
  argumentsJson: string;
  callerId: string;
  state: ToolCallApprovalState;
  expiresAtMs: number;
  createdAt: string;
  updatedAt: string;
}

interface ToolCallApprovalRow {
  request_id: string;
  tool_name: string;
  arguments_json: string;
  caller_id: string;
  state: ToolCallApprovalState;
  expires_at_ms: number;
  created_at: string;
  updated_at: string;
}

function mapRow(row: ToolCallApprovalRow): ToolCallApproval {
  return {
    requestId: row.request_id,
    toolName: row.tool_name,
    argumentsJson: row.arguments_json,
    callerId: row.caller_id,
    state: row.state,
    expiresAtMs: row.expires_at_ms,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Default TTL for approval requests: 5 minutes. */
const DEFAULT_TTL_MS = 5 * 60 * 1000;

export class SqliteToolCallApprovalRepository {
  constructor(private readonly db: Database.Database) {}

  /**
   * Create a pending approval request for a tool call.
   */
  createRequest(input: {
    toolName: string;
    arguments: Record<string, unknown>;
    callerId?: string;
    ttlMs?: number;
    nowMs?: number;
  }): ToolCallApproval {
    const nowMs = input.nowMs ?? Date.now();
    const ttlMs = input.ttlMs ?? DEFAULT_TTL_MS;
    const expiresAtMs = nowMs + Math.max(1, ttlMs);
    const requestId = randomUUID();
    const nowIso = new Date(nowMs).toISOString();

    this.db
      .prepare(
        `INSERT INTO tool_call_approvals(
          request_id, tool_name, arguments_json, caller_id, state,
          expires_at_ms, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'pending', ?, ?, ?)`,
      )
      .run(
        requestId,
        input.toolName,
        JSON.stringify(input.arguments),
        input.callerId ?? 'agent',
        expiresAtMs,
        nowIso,
        nowIso,
      );

    return this.getOrThrow(requestId);
  }

  /**
   * Approve a pending request. Returns the updated record.
   */
  approve(requestId: string, nowMs?: number): ToolCallApproval {
    const now = nowMs ?? Date.now();
    const nowIso = new Date(now).toISOString();
    const current = this.getOrThrow(requestId);

    if (current.state !== 'pending') {
      throw new Error(`cannot approve: request ${requestId} is ${current.state}`);
    }
    if (now > current.expiresAtMs) {
      this.transition(requestId, 'expired', nowIso);
      throw new Error(`cannot approve: request ${requestId} has expired`);
    }

    this.transition(requestId, 'approved', nowIso);
    return this.getOrThrow(requestId);
  }

  /**
   * Deny a pending request.
   */
  deny(requestId: string, nowMs?: number): ToolCallApproval {
    const nowIso = new Date(nowMs ?? Date.now()).toISOString();
    const current = this.getOrThrow(requestId);

    if (current.state !== 'pending') {
      throw new Error(`cannot deny: request ${requestId} is ${current.state}`);
    }

    this.transition(requestId, 'denied', nowIso);
    return this.getOrThrow(requestId);
  }

  /**
   * Mark an approved request as used (tool was executed).
   */
  markUsed(requestId: string, nowMs?: number): void {
    const nowIso = new Date(nowMs ?? Date.now()).toISOString();
    this.transition(requestId, 'used', nowIso);
  }

  /**
   * Check if a tool call has been approved and return the request if so.
   * Also checks for an explicit requestId passed by the caller.
   */
  findApproved(requestId: string, nowMs?: number): ToolCallApproval | null {
    const now = nowMs ?? Date.now();
    const row = this.db
      .prepare(
        `SELECT request_id, tool_name, arguments_json, caller_id, state,
                expires_at_ms, created_at, updated_at
         FROM tool_call_approvals
         WHERE request_id = ? AND state = 'approved' AND expires_at_ms > ?`,
      )
      .get(requestId, now) as ToolCallApprovalRow | undefined;

    return row ? mapRow(row) : null;
  }

  /**
   * List pending requests, optionally filtered by tool name.
   */
  listPending(toolName?: string): ToolCallApproval[] {
    const now = Date.now();
    if (toolName) {
      return (
        this.db
          .prepare(
            `SELECT request_id, tool_name, arguments_json, caller_id, state,
                    expires_at_ms, created_at, updated_at
             FROM tool_call_approvals
             WHERE state = 'pending' AND expires_at_ms > ? AND tool_name = ?
             ORDER BY created_at DESC`,
          )
          .all(now, toolName) as ToolCallApprovalRow[]
      ).map(mapRow);
    }
    return (
      this.db
        .prepare(
          `SELECT request_id, tool_name, arguments_json, caller_id, state,
                  expires_at_ms, created_at, updated_at
           FROM tool_call_approvals
           WHERE state = 'pending' AND expires_at_ms > ?
           ORDER BY created_at DESC`,
        )
        .all(now) as ToolCallApprovalRow[]
    ).map(mapRow);
  }

  /**
   * Expire all pending requests past their TTL.
   */
  expirePending(nowMs = Date.now()): number {
    const nowIso = new Date(nowMs).toISOString();
    return this.db
      .prepare(
        `UPDATE tool_call_approvals
         SET state = 'expired', updated_at = ?
         WHERE state = 'pending' AND expires_at_ms < ?`,
      )
      .run(nowIso, nowMs).changes;
  }

  get(requestId: string): ToolCallApproval | null {
    const row = this.db
      .prepare(
        `SELECT request_id, tool_name, arguments_json, caller_id, state,
                expires_at_ms, created_at, updated_at
         FROM tool_call_approvals
         WHERE request_id = ?`,
      )
      .get(requestId) as ToolCallApprovalRow | undefined;
    return row ? mapRow(row) : null;
  }

  private getOrThrow(requestId: string): ToolCallApproval {
    const row = this.get(requestId);
    if (!row) throw new Error(`tool call approval not found: ${requestId}`);
    return row;
  }

  private transition(requestId: string, state: ToolCallApprovalState, updatedAt: string): void {
    this.db
      .prepare(
        `UPDATE tool_call_approvals SET state = ?, updated_at = ? WHERE request_id = ?`,
      )
      .run(state, updatedAt, requestId);
  }
}
