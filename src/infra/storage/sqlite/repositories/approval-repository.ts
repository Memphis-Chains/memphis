import type Database from 'better-sqlite3';

import { normalizeIdentity } from '../../../auth/identity.js';

export interface ApprovalRecord {
  approvalRequestId: string;
  initiatorId: string;
  approverId: string;
  stateVersion: number;
  createdAt: string;
}

function mapRow(row: {
  approval_request_id: string;
  initiator_id: string;
  approver_id: string;
  state_version: number;
  created_at: string;
}): ApprovalRecord {
  return {
    approvalRequestId: row.approval_request_id,
    initiatorId: row.initiator_id,
    approverId: row.approver_id,
    stateVersion: row.state_version,
    createdAt: row.created_at,
  };
}

export class SqliteApprovalRepository {
  constructor(private readonly db: Database.Database) {}

  public create(
    approvalRequestId: string,
    initiatorId: string,
    approverId: string,
  ): ApprovalRecord {
    const now = new Date().toISOString();
    const normalizedInitiator = normalizeIdentity(initiatorId);
    const normalizedApprover = normalizeIdentity(approverId);

    this.db
      .prepare(
        `INSERT INTO approvals(approval_request_id, initiator_id, approver_id, state_version, created_at)
         VALUES (?, ?, ?, 0, ?)`,
      )
      .run(approvalRequestId, normalizedInitiator, normalizedApprover, now);

    const row = this.db
      .prepare(
        `SELECT approval_request_id, initiator_id, approver_id, state_version, created_at
         FROM approvals
         WHERE approval_request_id = ?`,
      )
      .get(approvalRequestId) as
      | {
          approval_request_id: string;
          initiator_id: string;
          approver_id: string;
          state_version: number;
          created_at: string;
        }
      | undefined;
    if (!row) {
      throw new Error(`approval not found after insert: ${approvalRequestId}`);
    }

    return mapRow(row);
  }
}
