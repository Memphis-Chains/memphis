import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createSqliteClient, runMigrations } from '../../src/infra/storage/sqlite/client.js';
import { SqliteToolCallApprovalRepository } from '../../src/infra/storage/sqlite/repositories/tool-call-approval-repository.js';

function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'memphis-approval-'));
  const db = createSqliteClient(`file:${join(dir, 'test.db')}`);
  runMigrations(db);
  return new SqliteToolCallApprovalRepository(db);
}

describe('SqliteToolCallApprovalRepository', () => {
  it('creates a pending request', () => {
    const repo = makeRepo();
    const req = repo.createRequest({ toolName: 'memphis_exec', arguments: { command: 'echo hi' } });

    expect(req.state).toBe('pending');
    expect(req.toolName).toBe('memphis_exec');
    expect(req.callerId).toBe('agent');
    expect(JSON.parse(req.argumentsJson)).toEqual({ command: 'echo hi' });
    expect(req.requestId).toBeTruthy();
  });

  it('approves a pending request', () => {
    const repo = makeRepo();
    const req = repo.createRequest({ toolName: 'memphis_exec', arguments: { command: 'pwd' } });

    const approved = repo.approve(req.requestId);
    expect(approved.state).toBe('approved');
  });

  it('denies a pending request', () => {
    const repo = makeRepo();
    const req = repo.createRequest({ toolName: 'memphis_exec', arguments: { command: 'ls' } });

    const denied = repo.deny(req.requestId);
    expect(denied.state).toBe('denied');
  });

  it('cannot approve an already-denied request', () => {
    const repo = makeRepo();
    const req = repo.createRequest({ toolName: 'test', arguments: {} });
    repo.deny(req.requestId);

    expect(() => repo.approve(req.requestId)).toThrow('cannot approve');
  });

  it('cannot deny an already-approved request', () => {
    const repo = makeRepo();
    const req = repo.createRequest({ toolName: 'test', arguments: {} });
    repo.approve(req.requestId);

    expect(() => repo.deny(req.requestId)).toThrow('cannot deny');
  });

  it('marks approved request as used', () => {
    const repo = makeRepo();
    const req = repo.createRequest({ toolName: 'test', arguments: {} });
    repo.approve(req.requestId);
    repo.markUsed(req.requestId);

    const result = repo.get(req.requestId);
    expect(result?.state).toBe('used');
  });

  it('findApproved returns approved request', () => {
    const repo = makeRepo();
    const req = repo.createRequest({ toolName: 'test', arguments: {} });
    repo.approve(req.requestId);

    const found = repo.findApproved(req.requestId);
    expect(found).not.toBeNull();
    expect(found?.state).toBe('approved');
  });

  it('findApproved returns null for pending request', () => {
    const repo = makeRepo();
    const req = repo.createRequest({ toolName: 'test', arguments: {} });

    expect(repo.findApproved(req.requestId)).toBeNull();
  });

  it('findApproved returns null for expired request', () => {
    const repo = makeRepo();
    const now = Date.now();
    const req = repo.createRequest({ toolName: 'test', arguments: {}, ttlMs: 100, nowMs: now - 200 });
    // Request is already expired
    expect(repo.findApproved(req.requestId)).toBeNull();
  });

  it('lists pending requests', () => {
    const repo = makeRepo();
    repo.createRequest({ toolName: 'tool_a', arguments: {} });
    repo.createRequest({ toolName: 'tool_b', arguments: {} });
    const req3 = repo.createRequest({ toolName: 'tool_c', arguments: {} });
    repo.approve(req3.requestId); // Not pending anymore

    const pending = repo.listPending();
    expect(pending.length).toBe(2);
    expect(pending.map((p) => p.toolName).sort()).toEqual(['tool_a', 'tool_b']);
  });

  it('lists pending filtered by tool name', () => {
    const repo = makeRepo();
    repo.createRequest({ toolName: 'tool_a', arguments: {} });
    repo.createRequest({ toolName: 'tool_b', arguments: {} });

    const filtered = repo.listPending('tool_a');
    expect(filtered.length).toBe(1);
    expect(filtered[0].toolName).toBe('tool_a');
  });

  it('expires pending requests past TTL', () => {
    const repo = makeRepo();
    const now = Date.now();
    repo.createRequest({ toolName: 'test', arguments: {}, ttlMs: 100, nowMs: now - 200 });
    repo.createRequest({ toolName: 'test2', arguments: {}, ttlMs: 100, nowMs: now - 200 });
    repo.createRequest({ toolName: 'test3', arguments: {} }); // Not expired

    const expired = repo.expirePending(now);
    expect(expired).toBe(2);

    const pending = repo.listPending();
    expect(pending.length).toBe(1);
    expect(pending[0].toolName).toBe('test3');
  });

  it('rejects approval of expired request', () => {
    const repo = makeRepo();
    const now = Date.now();
    const req = repo.createRequest({ toolName: 'test', arguments: {}, ttlMs: 100, nowMs: now - 200 });

    expect(() => repo.approve(req.requestId, now)).toThrow('expired');
    const result = repo.get(req.requestId);
    expect(result?.state).toBe('expired');
  });

  it('custom caller_id', () => {
    const repo = makeRepo();
    const req = repo.createRequest({ toolName: 'test', arguments: {}, callerId: 'openclaw-v1' });
    expect(req.callerId).toBe('openclaw-v1');
  });
});
