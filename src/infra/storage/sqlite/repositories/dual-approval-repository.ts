import { randomUUID } from 'node:crypto';

import type Database from 'better-sqlite3';

import { AppError } from '../../../../core/errors.js';
import { normalizeIdentity } from '../../../auth/identity.js';

export type DualApprovalAction = 'freeze' | 'unfreeze';
export type DualApprovalState = 'pending' | 'approved' | 'expired' | 'canceled';
type DualApprovalTransitionAction = 'approve' | 'cancel';

export interface DualApprovalRequest {
  requestId: string;
  action: DualApprovalAction;
  state: DualApprovalState;
  initiatorId: string;
  approverId: string | null;
  reason: string | null;
  signature: string | null;
  expiresAtMs: number;
  stateVersion: number;
  createdAt: string;
  updatedAt: string;
}

interface DualApprovalRow {
  request_id: string;
  action: DualApprovalAction;
  state: DualApprovalState;
  initiator_id: string;
  approver_id: string | null;
  reason: string | null;
  signature: string | null;
  expires_at_ms: number;
  state_version: number;
  created_at: string;
  updated_at: string;
}

interface DualApprovalIdempotencyRow {
  approval_request_id: string;
  request_id: string;
  action: DualApprovalTransitionAction;
  actor_id: string;
  created_at: string;
}

function mapRow(row: DualApprovalRow): DualApprovalRequest {
  return {
    requestId: row.request_id,
    action: row.action,
    state: row.state,
    initiatorId: row.initiator_id,
    approverId: row.approver_id,
    reason: row.reason,
    signature: row.signature,
    expiresAtMs: row.expires_at_ms,
    stateVersion: row.state_version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class SqliteDualApprovalRepository {
  constructor(private readonly db: Database.Database) {}

  public createRequest(input: {
    action: DualApprovalAction;
    initiatorId: string;
    ttlMs?: number;
    reason?: string;
    signature?: string;
    nowMs?: number;
  }): DualApprovalRequest {
    const nowMs = input.nowMs ?? Date.now();
    const ttlMs = input.ttlMs ?? 5 * 60 * 1000;
    const expiresAtMs = nowMs + Math.max(1, ttlMs);
    const requestId = randomUUID();
    const nowIso = new Date(nowMs).toISOString();
    const normalizedInitiator = normalizeIdentity(input.initiatorId);

    this.db
      .prepare(
        `INSERT INTO dual_approval_requests(
          request_id, action, state, initiator_id, approver_id, reason, signature,
          expires_at_ms, state_version, created_at, updated_at
        ) VALUES (?, ?, 'pending', ?, NULL, ?, ?, ?, 0, ?, ?)`,
      )
      .run(
        requestId,
        input.action,
        normalizedInitiator,
        input.reason ?? null,
        input.signature ?? null,
        expiresAtMs,
        nowIso,
        nowIso,
      );

    this.insertEvent({
      requestId,
      fromState: null,
      toState: 'pending',
      actorId: normalizedInitiator,
      signature: input.signature ?? null,
      createdAt: nowIso,
    });

    return this.getOrThrow(requestId);
  }

  public approve(input: {
    approvalRequestId: string;
    requestId: string;
    approverId: string;
    expectedStateVersion: number;
    signature?: string;
    nowMs?: number;
  }): DualApprovalRequest {
    const nowMs = input.nowMs ?? Date.now();
    const nowIso = new Date(nowMs).toISOString();
    const normalizedApprover = normalizeIdentity(input.approverId);

    const tx = this.db.transaction(() => {
      if (
        this.isIdempotentReplay({
          approvalRequestId: input.approvalRequestId,
          requestId: input.requestId,
          action: 'approve',
          actorId: normalizedApprover,
        })
      ) {
        return this.getOrThrow(input.requestId);
      }

      const current = this.getOrThrow(input.requestId);
      if (current.state !== 'pending') {
        throw new AppError('VALIDATION_ERROR', 'TransitionAlreadyApplied', 409, {
          requestId: input.requestId,
          state: current.state,
          stateVersion: current.stateVersion,
        });
      }

      if (nowMs > current.expiresAtMs) {
        if (
          !this.reserveIdempotency({
            approvalRequestId: input.approvalRequestId,
            requestId: input.requestId,
            action: 'approve',
            actorId: normalizedApprover,
            createdAt: nowIso,
          })
        ) {
          return this.getOrThrow(input.requestId);
        }

        const changed = this.db
          .prepare(
            `UPDATE dual_approval_requests
             SET state='expired', state_version=state_version+1, updated_at=?
             WHERE request_id=? AND state='pending' AND state_version=?`,
          )
          .run(nowIso, input.requestId, current.stateVersion).changes;
        if (changed !== 1) {
          throw new AppError('VALIDATION_ERROR', 'TransitionAlreadyApplied', 409, {
            requestId: input.requestId,
          });
        }
        this.insertEvent({
          requestId: input.requestId,
          fromState: 'pending',
          toState: 'expired',
          actorId: normalizedApprover,
          signature: input.signature ?? null,
          createdAt: nowIso,
        });
        return this.getOrThrow(input.requestId);
      }

      if (current.initiatorId === normalizedApprover) {
        throw new AppError('PERMISSION_DENIED', 'initiator cannot self-approve', 403, {
          requestId: input.requestId,
        });
      }

      if (current.stateVersion !== input.expectedStateVersion) {
        throw new AppError('VALIDATION_ERROR', 'TransitionAlreadyApplied', 409, {
          requestId: input.requestId,
          expectedStateVersion: input.expectedStateVersion,
          actualStateVersion: current.stateVersion,
        });
      }

      if (
        !this.reserveIdempotency({
          approvalRequestId: input.approvalRequestId,
          requestId: input.requestId,
          action: 'approve',
          actorId: normalizedApprover,
          createdAt: nowIso,
        })
      ) {
        return this.getOrThrow(input.requestId);
      }

      const changed = this.db
        .prepare(
          `UPDATE dual_approval_requests
           SET state='approved', approver_id=?, signature=?, state_version=state_version+1, updated_at=?
           WHERE request_id=? AND state='pending' AND state_version=?`,
        )
        .run(
          normalizedApprover,
          input.signature ?? null,
          nowIso,
          input.requestId,
          input.expectedStateVersion,
        ).changes;
      if (changed !== 1) {
        throw new AppError('VALIDATION_ERROR', 'TransitionAlreadyApplied', 409, {
          requestId: input.requestId,
        });
      }

      this.insertEvent({
        requestId: input.requestId,
        fromState: 'pending',
        toState: 'approved',
        actorId: normalizedApprover,
        signature: input.signature ?? null,
        createdAt: nowIso,
      });

      return this.getOrThrow(input.requestId);
    });

    return tx();
  }

  public cancel(input: {
    approvalRequestId: string;
    requestId: string;
    actorId: string;
    expectedStateVersion: number;
    signature?: string;
    nowMs?: number;
  }): DualApprovalRequest {
    const nowMs = input.nowMs ?? Date.now();
    const nowIso = new Date(nowMs).toISOString();
    const normalizedActor = normalizeIdentity(input.actorId);
    const tx = this.db.transaction(() => {
      if (
        this.isIdempotentReplay({
          approvalRequestId: input.approvalRequestId,
          requestId: input.requestId,
          action: 'cancel',
          actorId: normalizedActor,
        })
      ) {
        return this.getOrThrow(input.requestId);
      }

      const current = this.getOrThrow(input.requestId);
      if (current.state !== 'pending') {
        throw new AppError('VALIDATION_ERROR', 'TransitionAlreadyApplied', 409, {
          requestId: input.requestId,
          state: current.state,
          stateVersion: current.stateVersion,
        });
      }

      if (current.stateVersion !== input.expectedStateVersion) {
        throw new AppError('VALIDATION_ERROR', 'TransitionAlreadyApplied', 409, {
          requestId: input.requestId,
          expectedStateVersion: input.expectedStateVersion,
          actualStateVersion: current.stateVersion,
        });
      }

      if (
        !this.reserveIdempotency({
          approvalRequestId: input.approvalRequestId,
          requestId: input.requestId,
          action: 'cancel',
          actorId: normalizedActor,
          createdAt: nowIso,
        })
      ) {
        return this.getOrThrow(input.requestId);
      }

      const changed = this.db
        .prepare(
          `UPDATE dual_approval_requests
           SET state='canceled', signature=?, state_version=state_version+1, updated_at=?
           WHERE request_id=? AND state='pending' AND state_version=?`,
        )
        .run(input.signature ?? null, nowIso, input.requestId, input.expectedStateVersion).changes;
      if (changed !== 1) {
        throw new AppError('VALIDATION_ERROR', 'TransitionAlreadyApplied', 409, {
          requestId: input.requestId,
        });
      }
      this.insertEvent({
        requestId: input.requestId,
        fromState: 'pending',
        toState: 'canceled',
        actorId: normalizedActor,
        signature: input.signature ?? null,
        createdAt: nowIso,
      });

      return this.getOrThrow(input.requestId);
    });
    return tx();
  }

  public expirePending(nowMs = Date.now()): number {
    const nowIso = new Date(nowMs).toISOString();
    const rows = this.db
      .prepare(
        `SELECT request_id, state
         FROM dual_approval_requests
         WHERE state='pending' AND expires_at_ms < ?`,
      )
      .all(nowMs) as Array<{ request_id: string; state: DualApprovalState }>;

    let updated = 0;
    const tx = this.db.transaction(() => {
      for (const row of rows) {
        const changed = this.db
          .prepare(
            `UPDATE dual_approval_requests
             SET state='expired', state_version=state_version+1, updated_at=?
             WHERE request_id=? AND state='pending'`,
          )
          .run(nowIso, row.request_id).changes;
        if (changed !== 1) continue;
        updated += 1;
        this.insertEvent({
          requestId: row.request_id,
          fromState: 'pending',
          toState: 'expired',
          actorId: 'system',
          signature: null,
          createdAt: nowIso,
        });
      }
    });
    tx();
    return updated;
  }

  public get(requestId: string): DualApprovalRequest | null {
    const row = this.db
      .prepare(
        `SELECT request_id, action, state, initiator_id, approver_id, reason, signature,
                expires_at_ms, state_version, created_at, updated_at
         FROM dual_approval_requests
         WHERE request_id = ?`,
      )
      .get(requestId) as DualApprovalRow | undefined;
    if (!row) return null;
    return mapRow(row);
  }

  public listEvents(requestId: string): Array<{
    eventId: string;
    requestId: string;
    fromState: DualApprovalState | null;
    toState: DualApprovalState;
    actorId: string;
    signature: string | null;
    createdAt: string;
  }> {
    return this.db
      .prepare(
        `SELECT event_id, request_id, from_state, to_state, actor_id, signature, created_at
         FROM dual_approval_events
         WHERE request_id = ?
         ORDER BY created_at ASC`,
      )
      .all(requestId)
      .map((row) => ({
        eventId: (row as { event_id: string }).event_id,
        requestId: (row as { request_id: string }).request_id,
        fromState: (row as { from_state: DualApprovalState | null }).from_state,
        toState: (row as { to_state: DualApprovalState }).to_state,
        actorId: (row as { actor_id: string }).actor_id,
        signature: (row as { signature: string | null }).signature,
        createdAt: (row as { created_at: string }).created_at,
      }));
  }

  public countByState(): Record<DualApprovalState, number> {
    const rows = this.db
      .prepare(
        `SELECT state, COUNT(*) as count
         FROM dual_approval_requests
         GROUP BY state`,
      )
      .all() as Array<{ state: DualApprovalState; count: number }>;
    const totals: Record<DualApprovalState, number> = {
      pending: 0,
      approved: 0,
      expired: 0,
      canceled: 0,
    };
    for (const row of rows) {
      totals[row.state] = row.count;
    }
    return totals;
  }

  private getOrThrow(requestId: string): DualApprovalRequest {
    const row = this.get(requestId);
    if (!row) {
      throw new AppError('VALIDATION_ERROR', `approval request not found: ${requestId}`, 404, {
        requestId,
      });
    }
    return row;
  }

  private insertEvent(input: {
    requestId: string;
    fromState: DualApprovalState | null;
    toState: DualApprovalState;
    actorId: string;
    signature: string | null;
    createdAt: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO dual_approval_events(
          event_id, request_id, from_state, to_state, actor_id, signature, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        randomUUID(),
        input.requestId,
        input.fromState,
        input.toState,
        input.actorId,
        input.signature,
        input.createdAt,
      );
  }

  private reserveIdempotency(input: {
    approvalRequestId: string;
    requestId: string;
    action: DualApprovalTransitionAction;
    actorId: string;
    createdAt: string;
  }): boolean {
    const inserted = this.db
      .prepare(
        `INSERT INTO dual_approval_idempotency(
          approval_request_id, request_id, action, actor_id, created_at
        ) VALUES (?, ?, ?, ?, ?) ON CONFLICT(approval_request_id) DO NOTHING`,
      )
      .run(
        input.approvalRequestId,
        input.requestId,
        input.action,
        input.actorId,
        input.createdAt,
      ).changes;

    if (inserted === 1) {
      return true;
    }

    const existing = this.db
      .prepare(
        `SELECT approval_request_id, request_id, action, actor_id, created_at
         FROM dual_approval_idempotency
         WHERE approval_request_id = ?`,
      )
      .get(input.approvalRequestId) as DualApprovalIdempotencyRow | undefined;

    if (
      existing &&
      existing.request_id === input.requestId &&
      existing.action === input.action &&
      existing.actor_id === input.actorId
    ) {
      return false;
    }

    throw new AppError('VALIDATION_ERROR', 'approval_request_id already used', 409, {
      approvalRequestId: input.approvalRequestId,
      requestId: input.requestId,
      action: input.action,
    });
  }

  private isIdempotentReplay(input: {
    approvalRequestId: string;
    requestId: string;
    action: DualApprovalTransitionAction;
    actorId: string;
  }): boolean {
    const existing = this.db
      .prepare(
        `SELECT approval_request_id, request_id, action, actor_id, created_at
         FROM dual_approval_idempotency
         WHERE approval_request_id = ?`,
      )
      .get(input.approvalRequestId) as DualApprovalIdempotencyRow | undefined;

    if (!existing) {
      return false;
    }

    if (
      existing.request_id === input.requestId &&
      existing.action === input.action &&
      existing.actor_id === input.actorId
    ) {
      return true;
    }

    throw new AppError('VALIDATION_ERROR', 'approval_request_id already used', 409, {
      approvalRequestId: input.approvalRequestId,
      requestId: input.requestId,
      action: input.action,
    });
  }
}
