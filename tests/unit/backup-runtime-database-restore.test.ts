import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createBackup,
  listArchiveContents,
  resolveRuntimeDatabasePath,
  restoreBackup,
} from '../../src/infra/cli/commands/backup.js';

vi.mock('../../src/infra/auth/operator-gate.js', () => ({
  requireOperatorAuth: vi.fn(async () => true),
}));

const roots: string[] = [];
afterEach(() => {
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
  vi.unstubAllEnvs();
});

function tempDir(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

/**
 * The measured incident, reproduced end to end.
 *
 * The runtime database lives OUTSIDE the data directory — `DATABASE_URL`
 * points at `<install root>/data/memphis.db`, while the data directory is
 * `~/.memphis`. The v1 placement manifest could only say "a file inside the
 * data directory", so a restore put the database at
 * `<data dir>/memphis.db`, where the runtime never reads it: the restore
 * reported success while the operator's chat history and search index
 * stayed on the old file.
 *
 * Worse, the stray `<data dir>/memphis.db` then collided with the runtime
 * database on the next backup — "Multiple databases would overwrite archive
 * entry: memphis.db" — and that backup refused to publish. The operator's
 * recovery procedure broke their backups.
 */
describe('the runtime database survives a backup/restore round trip', () => {
  it('restores the database where the runtime reads it, not into the data tree', async () => {
    const dataDir = tempDir('memphis-runtime-db-data-');
    const installRoot = tempDir('memphis-runtime-db-root-');
    const runtimeDbPath = join(installRoot, 'data', 'memphis.db');
    mkdirSync(join(installRoot, 'data'), { recursive: true });

    // A database with content the operator would recognise.
    const db = new Database(runtimeDbPath);
    db.exec('CREATE TABLE messages (body TEXT)');
    db.prepare('INSERT INTO messages VALUES (?)').run('operator history');
    db.close();

    vi.stubEnv('DATABASE_URL', `file:${runtimeDbPath}`);

    const created = await createBackup({
      memphisRoot: dataDir,
      dataDir: join(installRoot, 'data'),
      databasePath: runtimeDbPath,
      backupRoot: join(dataDir, 'backups'),
      showProgress: false,
    });

    // The archive carries the runtime database under its own name.
    const entries = listArchiveContents(created.backupPath);
    expect(entries.some((entry) => entry.includes('runtime-memphis.db'))).toBe(true);

    // Restore into a fresh data directory, as a recovery would.
    const restoredRoot = tempDir('memphis-runtime-db-restored-');
    await restoreBackup({
      file: created.backupPath,
      memphisRoot: restoredRoot,
      backupRoot: join(restoredRoot, 'backups'),
      confirm: true,
      showProgress: false,
    });

    // The database is where the runtime reads it — so the restored data is
    // actually the data the runtime will use.
    expect(resolveRuntimeDatabasePath()).toBe(runtimeDbPath);
    const restored = new Database(runtimeDbPath, { readonly: true });
    try {
      expect(restored.prepare('SELECT body FROM messages').all()).toEqual([
        { body: 'operator history' },
      ]);
      expect(restored.pragma('integrity_check', { simple: true })).toBe('ok');
    } finally {
      restored.close();
    }

    // And NOT in the data directory, where the runtime never looks.
    expect(existsSync(join(restoredRoot, 'memphis.db'))).toBe(false);
  });

  it('a restore does not break the next backup', async () => {
    // The second half of the incident: the stray database in the data
    // directory made the next snapshot find two databases claiming the same
    // archive entry, and refuse to publish.
    const dataDir = tempDir('memphis-runtime-db-cycle-data-');
    const installRoot = tempDir('memphis-runtime-db-cycle-root-');
    const runtimeDbPath = join(installRoot, 'data', 'memphis.db');
    mkdirSync(join(installRoot, 'data'), { recursive: true });
    const db = new Database(runtimeDbPath);
    db.exec('CREATE TABLE messages (body TEXT)');
    db.close();

    vi.stubEnv('DATABASE_URL', `file:${runtimeDbPath}`);

    const first = await createBackup({
      memphisRoot: dataDir,
      dataDir: join(installRoot, 'data'),
      databasePath: runtimeDbPath,
      backupRoot: join(dataDir, 'backups'),
      showProgress: false,
    });

    const restoredRoot = tempDir('memphis-runtime-db-cycle-restored-');
    await restoreBackup({
      file: first.backupPath,
      memphisRoot: restoredRoot,
      backupRoot: join(restoredRoot, 'backups'),
      confirm: true,
      showProgress: false,
    });

    // The second backup runs against the restored tree. Before the fix it
    // failed with "Multiple databases would overwrite archive entry".
    const second = await createBackup({
      memphisRoot: restoredRoot,
      dataDir: join(installRoot, 'data'),
      databasePath: runtimeDbPath,
      backupRoot: join(restoredRoot, 'backups'),
      showProgress: false,
    });
    expect(second.dbSnapshot.ok).toBe(true);
    expect(second.dbSnapshot.errors).toEqual([]);
    expect(second.dbSnapshot.snapshotted).toHaveLength(1);
  });

  it('a v1 archive still restores its data-directory databases', async () => {
    // Archives written before the role existed carry a bare path per
    // staged file. They must keep restoring — the manifest format is a
    // contract with archives already on disk.
    const dataDir = tempDir('memphis-v1-archive-');
    mkdirSync(join(dataDir, 'chains'), { recursive: true });
    writeFileSync(join(dataDir, 'chains', 'journal-000001.json'), '{"fixture":true}');
    const db = new Database(join(dataDir, 'case-index.sqlite'));
    db.exec('CREATE TABLE entries (id INTEGER)');
    db.close();
    // The staged copy the manifest names. A real v1 archive carries the
    // database under its staging name and the manifest that maps it back.
    copyFileSync(
      join(dataDir, 'case-index.sqlite'),
      join(dataDir, '.memphis-db-snapshot-case-index.sqlite'),
    );

    // The archive lives OUTSIDE the tree it archives: writing it into the
    // directory tar is reading makes tar exit 1 with "file changed as we
    // read it", which is a property of the fixture, not of the code.
    const archive = join(tempDir('memphis-v1-archive-out-'), 'v1.tar.gz');
    // A v1 manifest: bare paths, no role.
    writeFileSync(
      join(dataDir, '.memphis-db-placement.json'),
      JSON.stringify({
        format: 'memphis-db-placement-v1',
        placements: { '.memphis-db-snapshot-case-index.sqlite': 'case-index.sqlite' },
      }),
    );
    execFileSync('tar', ['-czf', archive, '-C', dataDir, '.']);
    // Restore verifies the checksum sidecar before it touches anything.
    writeFileSync(
      `${archive}.sha256`,
      `${createHash('sha256').update(readFileSync(archive)).digest('hex')}  v1.tar.gz\n`,
    );

    const restoredRoot = tempDir('memphis-v1-restored-');
    await restoreBackup({
      file: archive,
      memphisRoot: restoredRoot,
      backupRoot: join(restoredRoot, 'backups'),
      confirm: true,
      showProgress: false,
    });
    // The data-directory database landed inside the data directory.
    expect(existsSync(join(restoredRoot, 'case-index.sqlite'))).toBe(true);
  });
});

describe('the runtime database path is resolved the way the runtime resolves it', () => {
  it('reads DATABASE_URL and strips the file: prefix', () => {
    expect(resolveRuntimeDatabasePath({ DATABASE_URL: 'file:/srv/data/memphis.db' })).toBe(
      '/srv/data/memphis.db',
    );
  });

  it('has no answer when DATABASE_URL is absent or not a file URL', () => {
    expect(resolveRuntimeDatabasePath({})).toBeNull();
    expect(resolveRuntimeDatabasePath({ DATABASE_URL: 'postgres://host/db' })).toBeNull();
    expect(resolveRuntimeDatabasePath({ DATABASE_URL: 'file:' })).toBeNull();
  });
});
