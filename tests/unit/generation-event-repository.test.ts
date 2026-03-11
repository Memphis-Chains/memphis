import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSqliteClient, runMigrations } from '../../src/infra/storage/sqlite/client.js';
import { SqliteGenerationEventRepository } from '../../src/infra/storage/sqlite/repositories/generation-event-repository.js';
import { SqliteSessionRepository } from '../../src/infra/storage/sqlite/repositories/session-repository.js';

describe('SqliteGenerationEventRepository', () => {
  it('creates and lists generation events by session', () => {
    const dir = mkdtempSync(join(tmpdir(), 'memphis-v5-gen-repo-'));
    const db = createSqliteClient(`file:${join(dir, 'test.db')}`);
    runMigrations(db);

    const sessionRepo = new SqliteSessionRepository(db);
    sessionRepo.ensureSession('sess_1');

    const repo = new SqliteGenerationEventRepository(db);

    const created = repo.create({
      id: 'gen_1',
      sessionId: 'sess_1',
      providerUsed: 'local-fallback',
      modelUsed: 'local-fallback-v0',
      timingMs: 12,
      requestId: 'req_1',
    });

    const list = repo.listBySession('sess_1');
    expect(created.id).toBe('gen_1');
    expect(list.length).toBe(1);
    expect(list[0]?.providerUsed).toBe('local-fallback');

    db.close();
  });
});
