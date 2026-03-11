import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSqliteClient, runMigrations } from '../../src/infra/storage/sqlite/client.js';
import { SqliteSessionRepository } from '../../src/infra/storage/sqlite/repositories/session-repository.js';

describe('SqliteSessionRepository', () => {
  it('creates and fetches a session', () => {
    const dir = mkdtempSync(join(tmpdir(), 'memphis-v5-session-repo-'));
    const db = createSqliteClient(`file:${join(dir, 'test.db')}`);
    runMigrations(db);

    const repo = new SqliteSessionRepository(db);
    const created = repo.ensureSession('sess_1');
    const fetched = repo.getSessionById('sess_1');

    expect(created.id).toBe('sess_1');
    expect(fetched?.id).toBe('sess_1');
    expect(fetched?.createdAt).toBeTruthy();
    expect(fetched?.updatedAt).toBeTruthy();

    db.close();
  });
});
