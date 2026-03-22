/**
 * Unit tests for the evolve session repository.
 */
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runMigrations } from '../../src/infra/storage/sqlite/client.js';
import { SqliteEvolveSessionRepository } from '../../src/infra/storage/sqlite/repositories/evolve-session-repository.js';

describe('SqliteEvolveSessionRepository', () => {
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

  it('creates a session with pending status', () => {
    const session = repo.create({
      intent: 'add new feature',
      filesAllowed: ['src/foo.ts', 'src/bar.ts'],
    });

    expect(session.id).toBeTruthy();
    expect(session.status).toBe('pending');
    expect(session.intent).toBe('add new feature');
    expect(session.filesAllowed).toEqual(['src/foo.ts', 'src/bar.ts']);
    expect(session.snapshotId).toBeNull();
    expect(session.branch).toBeNull();
    expect(session.committedHash).toBeNull();
    expect(session.errorMessage).toBeNull();
  });

  it('retrieves session by id', () => {
    const created = repo.create({ intent: 'test', filesAllowed: [] });
    const found = repo.getById(created.id);

    expect(found).not.toBeNull();
    expect(found!.id).toBe(created.id);
  });

  it('returns null for unknown id', () => {
    expect(repo.getById('nonexistent')).toBeNull();
  });

  it('updates session status with extra fields', () => {
    const session = repo.create({ intent: 'test', filesAllowed: ['src/a.ts'] });

    repo.updateStatus(session.id, 'active', {
      snapshotId: 'snapshot-123',
      branch: 'evolve/test',
    });

    const updated = repo.getById(session.id)!;
    expect(updated.status).toBe('active');
    expect(updated.snapshotId).toBe('snapshot-123');
    expect(updated.branch).toBe('evolve/test');
  });

  it('transitions to committed with hash', () => {
    const session = repo.create({ intent: 'test', filesAllowed: [] });
    repo.updateStatus(session.id, 'active');
    repo.updateStatus(session.id, 'committed', { committedHash: 'abc123def' });

    const committed = repo.getById(session.id)!;
    expect(committed.status).toBe('committed');
    expect(committed.committedHash).toBe('abc123def');
  });

  it('transitions to rolled-back with error message', () => {
    const session = repo.create({ intent: 'test', filesAllowed: [] });
    repo.updateStatus(session.id, 'active');
    repo.updateStatus(session.id, 'rolled-back', {
      errorMessage: 'test gate failed at typecheck',
    });

    const rolledBack = repo.getById(session.id)!;
    expect(rolledBack.status).toBe('rolled-back');
    expect(rolledBack.errorMessage).toBe('test gate failed at typecheck');
  });

  it('lists sessions by status', () => {
    repo.create({ intent: 'a', filesAllowed: [] });
    const b = repo.create({ intent: 'b', filesAllowed: [] });
    repo.updateStatus(b.id, 'active');

    const pending = repo.listByStatus('pending');
    const active = repo.listByStatus('active');

    expect(pending).toHaveLength(1);
    expect(active).toHaveLength(1);
    expect(active[0].intent).toBe('b');
  });

  it('lists recent sessions with limit', () => {
    for (let i = 0; i < 5; i++) {
      repo.create({ intent: `session ${i}`, filesAllowed: [] });
    }

    const recent = repo.listRecent(3);
    expect(recent).toHaveLength(3);
  });

  it('expires timed-out sessions', () => {
    const session = repo.create({
      intent: 'will expire',
      filesAllowed: [],
      ttlMs: 1, // 1ms TTL — will expire immediately
    });

    // Small delay to ensure expiry
    const expired = repo.expireSessions(Date.now() + 100);
    expect(expired).toBe(1);

    const updated = repo.getById(session.id)!;
    expect(updated.status).toBe('expired');
  });

  it('finds active session', () => {
    const session = repo.create({ intent: 'active one', filesAllowed: [] });
    repo.updateStatus(session.id, 'active');

    const found = repo.findActiveSession();
    expect(found).not.toBeNull();
    expect(found!.id).toBe(session.id);
  });

  it('returns null when no active session', () => {
    repo.create({ intent: 'pending', filesAllowed: [] });
    expect(repo.findActiveSession()).toBeNull();
  });

  it('returns null when updating nonexistent session', () => {
    const result = repo.updateStatus('nonexistent', 'active');
    expect(result).toBeNull();
  });
});
