import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { AppError } from '../../src/core/errors.js';
import { createSqliteClient, runMigrations } from '../../src/infra/storage/sqlite/client.js';
import { SqliteDualApprovalRepository } from '../../src/infra/storage/sqlite/repositories/dual-approval-repository.js';

function createRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'mv5-dual-approval-'));
  const db = createSqliteClient(`file:${join(dir, 'dual-approval.db')}`);
  runMigrations(db);
  return new SqliteDualApprovalRepository(db);
}

describe('dual approval repository', () => {
  it('creates pending request and approves with distinct approver', () => {
    const repo = createRepo();
    const request = repo.createRequest({
      action: 'freeze',
      initiatorId: 'Admin-A',
      reason: 'security incident',
      signature: 'sig-init',
      nowMs: 1000,
    });
    expect(request.state).toBe('pending');
    expect(request.stateVersion).toBe(0);

    const approved = repo.approve({
      approvalRequestId: '0f5e52f4-9631-423d-ad34-845d446ec316',
      requestId: request.requestId,
      approverId: 'Admin-B',
      expectedStateVersion: 0,
      signature: 'sig-approve',
      nowMs: 1500,
    });
    expect(approved.state).toBe('approved');
    expect(approved.stateVersion).toBe(1);
    expect(approved.approverId).not.toBeNull();

    const events = repo.listEvents(request.requestId);
    expect(events.map((e) => e.toState)).toEqual(['pending', 'approved']);
  });

  it('rejects self-approval after identity normalization', () => {
    const repo = createRepo();
    const request = repo.createRequest({
      action: 'freeze',
      initiatorId: 'User_A',
      nowMs: 1000,
    });

    try {
      repo.approve({
        approvalRequestId: '1edfe6fd-c912-4f4f-b69b-31ce9559214b',
        requestId: request.requestId,
        approverId: 'user_a',
        expectedStateVersion: 0,
        nowMs: 1200,
      });
      expect.fail('expected self-approval to be denied');
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      const appError = error as AppError;
      expect(appError.code).toBe('PERMISSION_DENIED');
      expect(appError.statusCode).toBe(403);
    }
  });

  it('enforces CAS and rejects duplicate approval transitions', () => {
    const repo = createRepo();
    const request = repo.createRequest({
      action: 'unfreeze',
      initiatorId: 'admin-a',
      nowMs: 1000,
    });

    const first = repo.approve({
      approvalRequestId: '26d2ad73-d95f-49c4-8ecf-a6d77b4ecf66',
      requestId: request.requestId,
      approverId: 'admin-b',
      expectedStateVersion: 0,
      nowMs: 1400,
    });
    expect(first.state).toBe('approved');

    try {
      repo.approve({
        approvalRequestId: '31f16b77-31f0-4356-beaf-3ec9dc41a61d',
        requestId: request.requestId,
        approverId: 'admin-c',
        expectedStateVersion: 0,
        nowMs: 1500,
      });
      expect.fail('expected second transition to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      const appError = error as AppError;
      expect(appError.code).toBe('VALIDATION_ERROR');
      expect(appError.statusCode).toBe(409);
      expect(appError.message).toContain('TransitionAlreadyApplied');
    }
  });

  it('marks request as expired when approval arrives after ttl', () => {
    const repo = createRepo();
    const request = repo.createRequest({
      action: 'freeze',
      initiatorId: 'admin-a',
      ttlMs: 10,
      nowMs: 1000,
    });

    const late = repo.approve({
      approvalRequestId: '0d11b8f0-cce8-4a0b-b8dd-7415742adab9',
      requestId: request.requestId,
      approverId: 'admin-b',
      expectedStateVersion: 0,
      nowMs: 2000,
    });
    expect(late.state).toBe('expired');

    const events = repo.listEvents(request.requestId);
    expect(events.map((e) => e.toState)).toEqual(['pending', 'expired']);
  });

  it('treats duplicate approvalRequestId retries as idempotent for same actor', () => {
    const repo = createRepo();
    const request = repo.createRequest({
      action: 'freeze',
      initiatorId: 'admin-a',
      nowMs: 1000,
    });

    const approvalRequestId = '4f9f7dfd-c9df-4e2e-8f05-4bad382ad42f';
    const first = repo.approve({
      approvalRequestId,
      requestId: request.requestId,
      approverId: 'admin-b',
      expectedStateVersion: 0,
      nowMs: 1100,
    });
    expect(first.state).toBe('approved');

    const retry = repo.approve({
      approvalRequestId,
      requestId: request.requestId,
      approverId: 'admin-b',
      expectedStateVersion: 0,
      nowMs: 1200,
    });
    expect(retry.state).toBe('approved');
    expect(retry.stateVersion).toBe(1);
  });
});
