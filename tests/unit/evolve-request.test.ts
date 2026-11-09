import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { createSelfModifyRuntimeTools } from '../../src/gateway/tool-executor/domains/self-modify-tools.js';
import { EvolveRequestStore, evolveRequestDigest, validateEvolveRequest } from '../../src/infra/runtime/evolve-request.js';
import { SqliteEvolveSessionRepository } from '../../src/infra/storage/sqlite/repositories/evolve-session-repository.js';

describe('operator-local evolution requests', () => {
  const payload = { intent: 'fixture', files: ['src/a.ts'], changes: { 'src/a.ts': 'export const n = 1;\n' } };
  it('queues without a password or code write and refuses a password in tool input', async () => {
    const db = new Database(':memory:');
    const root = mkdtempSync(join(tmpdir(), 'evolve-queue-'));
    const repo = new SqliteEvolveSessionRepository(db);
    const tool = createSelfModifyRuntimeTools({ evolveSessionRepository: repo, projectRoot: root })[0];
    expect(() => tool.validateInput!({ ...payload, passphrase: 'fixture-secret' })).toThrow('do not send a passphrase');
    const validated = tool.validateInput!(payload);
    const out = await tool.execute(validated, {}) as { status: string; requestId: string; digest: string };
    expect(out.status).toBe('operator-review-required');
    const request = repo.requestStore().get(out.requestId)!;
    expect(request.status).toBe('pending');
    expect(request.digest).toBe(evolveRequestDigest(request.payload));
    expect(request.payload).not.toContain('fixture-secret');
    expect(JSON.parse(request.payload).changes).toEqual(payload.changes);
    db.close();
  });
  it('binds a one-time claim to the exact reviewed bytes and root', () => {
    const db = new Database(':memory:'); const root = mkdtempSync(join(tmpdir(), 'evolve-claim-'));
    const store = new EvolveRequestStore(db); const request = store.create(root, payload);
    expect(() => store.claim(request.id, request.digest, request.payload + ' ', request.root)).toThrow('changed');
    expect(store.get(request.id)?.status).toBe('pending');
    store.claim(request.id, request.digest, request.payload, request.root);
    expect(() => store.claim(request.id, request.digest, request.payload, request.root)).toThrow('claimed');
    store.finish(request.id, request.digest, true, 'synthetic-session');
    expect(store.get(request.id)).toMatchObject({ status: 'prepared', sessionId: 'synthetic-session' });
    db.close();
  });
  it('rejects secrets as a field, unsafe paths, oversized content and mismatched files', () => {
    expect(() => validateEvolveRequest({ ...payload, passphrase: 'no' } as never)).toThrow('fields');
    expect(() => validateEvolveRequest({ intent: 'x', files: ['../secret'], changes: { '../secret': 'x' } })).toThrow('path');
    expect(() => validateEvolveRequest({ intent: 'x', files: ['x'], changes: { x: 'x'.repeat(1_048_577) } })).toThrow('MiB');
    expect(() => validateEvolveRequest({ intent: 'x', files: ['a'], changes: { b: 'x' } })).toThrow('match');
  });
});
