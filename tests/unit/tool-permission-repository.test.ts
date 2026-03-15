import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type Database from 'better-sqlite3';
import { describe, expect, it, beforeEach } from 'vitest';

import { createSqliteClient, runMigrations } from '../../src/infra/storage/sqlite/client.js';
import {
  SqliteToolPermissionRepository,
  type ToolPolicy,
} from '../../src/infra/storage/sqlite/repositories/tool-permission-repository.js';


function createTestRepo(): { repo: SqliteToolPermissionRepository; db: Database.Database } {
  const dir = mkdtempSync(join(tmpdir(), 'memphis-toolperm-'));
  const db = createSqliteClient(`file:${join(dir, 'test.db')}`);
  runMigrations(db);
  return { repo: new SqliteToolPermissionRepository(db), db };
}

describe('tool permission repository', () => {
  let repo: SqliteToolPermissionRepository;
  let db: Database.Database;

  beforeEach(() => {
    ({ repo, db } = createTestRepo());
    return () => db.close();
  });

  it('returns empty list when no permissions configured', () => {
    expect(repo.list()).toEqual([]);
  });

  it('sets and retrieves a tool permission', () => {
    const result = repo.set('memphis_journal', 'deny');
    expect(result.tool_name).toBe('memphis_journal');
    expect(result.policy).toBe('deny');
    expect(result.updated_at).toBeTruthy();

    const got = repo.get('memphis_journal');
    expect(got).not.toBeNull();
    expect(got!.policy).toBe('deny');
  });

  it('upserts on conflict — updates policy', () => {
    repo.set('memphis_recall', 'deny');
    repo.set('memphis_recall', 'allow');
    const got = repo.get('memphis_recall');
    expect(got!.policy).toBe('allow');
  });

  it('lists all permissions sorted by name', () => {
    repo.set('z_tool', 'deny');
    repo.set('a_tool', 'allow');
    repo.set('m_tool', 'require-approval');
    const list = repo.list();
    expect(list.map((p) => p.tool_name)).toEqual(['a_tool', 'm_tool', 'z_tool']);
  });

  it('deletes a permission', () => {
    repo.set('memphis_journal', 'deny');
    expect(repo.delete('memphis_journal')).toBe(true);
    expect(repo.get('memphis_journal')).toBeNull();
    expect(repo.delete('memphis_journal')).toBe(false);
  });

  it('resets all permissions and returns count', () => {
    repo.set('tool_a', 'deny');
    repo.set('tool_b', 'deny');
    repo.set('tool_c', 'allow');
    const count = repo.reset();
    expect(count).toBe(3);
    expect(repo.list()).toEqual([]);
  });

  it('defaults unknown tools to allowed', () => {
    const result = repo.isAllowed('nonexistent_tool');
    expect(result.allowed).toBe(true);
    expect(result.policy).toBe('allow');
  });

  it('isAllowed returns correct result for each policy', () => {
    repo.set('allowed_tool', 'allow');
    repo.set('denied_tool', 'deny');
    repo.set('approval_tool', 'require-approval');

    const allowed = repo.isAllowed('allowed_tool');
    expect(allowed.allowed).toBe(true);
    expect(allowed.policy).toBe('allow');

    const denied = repo.isAllowed('denied_tool');
    expect(denied.allowed).toBe(false);
    expect(denied.policy).toBe('deny');
    expect(denied.reason).toContain('denied_tool');

    const approval = repo.isAllowed('approval_tool');
    expect(approval.allowed).toBe(false);
    expect(approval.policy).toBe('require-approval');
    expect(approval.reason).toContain('requires approval');
  });

  it('filterAllowed returns only allowed tools', () => {
    repo.set('denied_tool', 'deny');
    repo.set('approval_tool', 'require-approval');
    // 'allowed_tool' has no entry → defaults to allow
    const result = repo.filterAllowed(['allowed_tool', 'denied_tool', 'approval_tool']);
    expect(result).toEqual(['allowed_tool']);
  });

  it('rejects invalid policy via CHECK constraint', () => {
    expect(() => {
      repo.set('bad_tool', 'invalid' as ToolPolicy);
    }).toThrow();
  });
});
