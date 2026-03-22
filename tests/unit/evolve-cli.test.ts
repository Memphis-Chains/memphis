/**
 * Unit tests for the evolve CLI handler.
 */
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runMigrations } from '../../src/infra/storage/sqlite/client.js';
import { SqliteEvolveSessionRepository } from '../../src/infra/storage/sqlite/repositories/evolve-session-repository.js';

describe('evolve CLI', () => {
  let db: Database.Database;
  let repo: SqliteEvolveSessionRepository;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
    repo = new SqliteEvolveSessionRepository(db);
  });

  afterEach(() => {
    db.close();
  });

  it('lists empty sessions', () => {
    const sessions = repo.listRecent();
    expect(sessions).toHaveLength(0);
  });

  it('lists sessions after creation', () => {
    repo.create({ intent: 'test feature', filesAllowed: ['src/a.ts'] });
    repo.create({ intent: 'another feature', filesAllowed: ['src/b.ts'] });

    const sessions = repo.listRecent();
    expect(sessions).toHaveLength(2);
  });

  it('supports rollback lookup by partial id', () => {
    const session = repo.create({ intent: 'test', filesAllowed: [] });
    repo.updateStatus(session.id, 'approved');
    repo.updateStatus(session.id, 'active', { snapshotId: 'snap-1' });

    const prefix = session.id.slice(0, 8);
    const all = repo.listRecent(100);
    const match = all.find((s) => s.id.startsWith(prefix));

    expect(match).toBeDefined();
    expect(match!.id).toBe(session.id);
  });

  it('log shows committed session with hash', () => {
    const s = repo.create({ intent: 'evolve feature', filesAllowed: [] });
    repo.updateStatus(s.id, 'approved');
    repo.updateStatus(s.id, 'active');
    repo.updateStatus(s.id, 'committed', { committedHash: 'abc123' });

    const sessions = repo.listRecent();
    const committed = sessions.find((x) => x.status === 'committed');
    expect(committed).toBeDefined();
    expect(committed!.committedHash).toBe('abc123');
    expect(committed!.intent).toBe('evolve feature');
  });
});
