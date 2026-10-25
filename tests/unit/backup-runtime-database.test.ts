import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  assertRuntimeDatabaseSnapshotted,
  type DatabaseSnapshotResult,
} from '../../src/infra/cli/commands/backup.js';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

function snapshot(overrides: Partial<DatabaseSnapshotResult> = {}): DatabaseSnapshotResult {
  return {
    ok: true,
    snapshotDir: '/tmp/memphis-db-snapshot-fixture',
    snapshotted: [],
    excludedPaths: [],
    errors: [],
    ...overrides,
  };
}

function runtimeDatabase(): string {
  const root = mkdtempSync(join(tmpdir(), 'memphis-runtime-db-'));
  roots.push(root);
  const path = join(root, 'memphis.db');
  writeFileSync(path, 'sqlite fixture');
  return path;
}

describe('backup must not silently omit the runtime database', () => {
  it('rejects an archive whose snapshot missed the runtime database', () => {
    // The measured shape of the incident: the database exists on disk, the
    // snapshot came back empty, and the backup published anyway — seven
    // archives in a row, every one of them reporting drill=pass.
    const databasePath = runtimeDatabase();
    expect(() =>
      assertRuntimeDatabaseSnapshotted(snapshot(), databasePath),
    ).toThrow(/omit the runtime database/i);
  });

  it('accepts a snapshot that captured the runtime database', () => {
    const databasePath = runtimeDatabase();
    expect(() =>
      assertRuntimeDatabaseSnapshotted(
        snapshot({
          snapshotted: [
            {
              file: 'memphis.db',
              archivePath: 'memphis.db',
              stagedPath: '.memphis-db-snapshot-memphis.db',
              source: databasePath,
              bytes: 1024,
            },
          ],
        }),
        databasePath,
      ),
    ).not.toThrow();
  });

  it('rejects when only some other database was captured', () => {
    const databasePath = runtimeDatabase();
    const other = join(tmpdir(), 'dashboard.db');
    expect(() =>
      assertRuntimeDatabaseSnapshotted(
        snapshot({
          snapshotted: [
            {
              file: 'dashboard.db',
              archivePath: 'dashboard.db',
              stagedPath: '.memphis-db-snapshot-dashboard.db',
              source: other,
              bytes: 512,
            },
          ],
        }),
        databasePath,
      ),
    ).toThrow(/omit the runtime database/i);
  });

  it('does not fail a fresh install that has no database yet', () => {
    const missing = join(tmpdir(), 'memphis-not-created-yet.db');
    expect(() => assertRuntimeDatabaseSnapshotted(snapshot(), missing)).not.toThrow();
  });

  it('does not fail when no runtime database is configured at all', () => {
    expect(() => assertRuntimeDatabaseSnapshotted(snapshot(), undefined)).not.toThrow();
  });
});
