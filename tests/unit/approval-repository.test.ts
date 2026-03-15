import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createSqliteClient, runMigrations } from '../../src/infra/storage/sqlite/client.js';
import { SqliteApprovalRepository } from '../../src/infra/storage/sqlite/repositories/approval-repository.js';

describe('approval repository constraints', () => {
  it('rejects same initiator/approver after normalization', () => {
    const dir = mkdtempSync(join(tmpdir(), 'memphis-approval-'));
    const db = createSqliteClient(`file:${join(dir, 'test.db')}`);
    runMigrations(db);

    const repo = new SqliteApprovalRepository(db);

    expect(() => repo.create('req-1', 'A', 'a')).toThrow();
    db.close();
  });

  it('stores normalized identities for valid approvals', () => {
    const dir = mkdtempSync(join(tmpdir(), 'memphis-approval-ok-'));
    const db = createSqliteClient(`file:${join(dir, 'test.db')}`);
    runMigrations(db);

    const repo = new SqliteApprovalRepository(db);
    const row = repo.create('req-2', 'Admin-One', 'Admin-Two');

    expect(row.approvalRequestId).toBe('req-2');
    expect(row.initiatorId).toMatch(/^[0-9a-f]{64}$/);
    expect(row.approverId).toMatch(/^[0-9a-f]{64}$/);
    expect(row.initiatorId).not.toBe(row.approverId);
    db.close();
  });
});
