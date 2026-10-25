import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as snapshotModule from '../../scripts/backup-db-snapshot.mjs';
import {
  DATABASE_PLACEMENT_MANIFEST,
  RUNTIME_DB_PREFIX,
  STAGED_PREFIX,
  tarSubstitutionFlags,
  tarSupportsWarningOpt,
  tarWarningFlags,
} from '../../scripts/backup-db-snapshot.mjs';
import * as snapshotBridge from '../../src/infra/cli/commands/backup-db-snapshot.js';
import {
  cleanupDatabaseSnapshots,
  snapshotDatabases,
  verifyDatabaseSnapshotEntries,
  type DatabaseSnapshotResult,
} from '../../src/infra/cli/commands/backup-db-snapshot.js';
import {
  createBackup,
  listArchiveContents,
  restoreBackup,
} from '../../src/infra/cli/commands/backup.js';

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execFileSync: vi.fn(actual.execFileSync) };
});
vi.mock('../../src/infra/auth/operator-gate.js', () => ({
  requireOperatorAuth: vi.fn(async () => true),
}));

const actualChildProcess =
  await vi.importActual<typeof import('node:child_process')>('node:child_process');
const runner = join(process.cwd(), 'scripts/scheduled-backup-runner.mjs');
let root: string;
let state: string;
let repo: string;
const databases: Database.Database[] = [];
const snapshots: DatabaseSnapshotResult[] = [];

function openWalDatabase(path: string): Database.Database {
  mkdirSync(join(path, '..'), { recursive: true });
  const db = new Database(path);
  databases.push(db);
  db.pragma('journal_mode = WAL');
  db.pragma('wal_autocheckpoint = 0');
  db.exec('CREATE TABLE messages (body TEXT NOT NULL)');
  db.pragma('wal_checkpoint(TRUNCATE)');
  db.prepare('INSERT INTO messages VALUES (?)').run('committed only in WAL');
  expect(statSync(`${path}-wal`).size).toBeGreaterThan(0);
  return db;
}

function runRunner(extra: string[] = []) {
  return spawnSync(process.execPath, [runner, '--data-dir', state, '--repo-root', repo, ...extra], {
    encoding: 'utf8',
    env: { ...process.env, DATABASE_URL: '' },
  });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'memphis-dbsnap-test-'));
  state = join(root, 'state');
  repo = join(root, 'repo');
  mkdirSync(join(state, 'chains'), { recursive: true });
  mkdirSync(join(repo, 'data'), { recursive: true });
  writeFileSync(join(state, 'chains/journal-000001.json'), '{"fixture":"chain-data"}');
  vi.stubEnv('MEMPHIS_ENV_FILE', join(root, 'absent.env'));
  vi.mocked(execFileSync).mockImplementation(actualChildProcess.execFileSync);
});

afterEach(() => {
  for (const db of databases.splice(0)) if (db.open) db.close();
  for (const snapshot of snapshots.splice(0)) cleanupDatabaseSnapshots(snapshot);
  rmSync(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
  vi.mocked(execFileSync).mockReset();
});

describe('the compiled CLI and the systemd runner share one implementation', () => {
  it('re-exports every runtime export of the shared module', () => {
    // A hand-maintained export list is how the two writers silently drift:
    // adding a function to the module left it unreachable from the CLI until
    // tsc failed. Reported as one list, so a missing name is named.
    const runtimeExports = Object.keys(snapshotModule).filter((name) => name !== 'default');
    const bridged = new Set(Object.keys(snapshotBridge));
    expect(runtimeExports.filter((name) => !bridged.has(name))).toEqual([]);
    expect(runtimeExports.length).toBeGreaterThan(0);
  });

  it('reports which substitution flag this tar accepts, and with what syntax', () => {
    // Six rounds of this PR chose tar's dialect from documentation or from the
    // Linux host, and every guess was wrong. This prints what the local tar
    // actually does with each syntax, so a failing run on any platform states
    // the difference instead of only the symptom.
    const probe = mkdtempSync(join(tmpdir(), 'memphis-dialect-'));
    mkdirSync(join(probe, 'in/data'), { recursive: true });
    mkdirSync(join(probe, 'stage/data'), { recursive: true });
    writeFileSync(join(probe, 'in/a.txt'), 'a');
    // The live file the exclude patterns exist to drop. Without it the probe
    // measures a tree that has nothing to exclude, and every shape that
    // excludes nothing reports success for the wrong reason.
    writeFileSync(join(probe, 'in/data/memphis.db'), 'LIVE');
    writeFileSync(join(probe, 'stage/data/memphis.db'), 'db');
    // The distinct-name shape reaches the same file from a second -C.
    writeFileSync(join(probe, 'stage/memphis.db'), 'db');
    const expr = 's|^data/memphis.db|./data/memphis.db|';
    const shapes: Record<string, string[]> = {
      '--transform=EXPR': [`--transform=${expr}`],
      '-s EXPR': ['-s', expr],
      '-s=EXPR': [`-s=${expr}`],
      // bsdtar measured on the macOS runner: `-s EXPR` is rejected there as
      // "Invalid replacement flag .", which is the separator in the expression
      // being read as flag syntax. Its substitution form takes the expression
      // without a leading `s`.
      '-s EXPR-no-s': ['-s', expr.replace(/^s\|/, '')],
      '-s=EXPR-no-s': [`-s=${expr.replace(/^s\|/, '')}`],
      // The shape a platform with no usable substitution actually runs. On
      // macOS the archiver therefore takes this path, and the runner's own
      // report was "Archive must contain exactly one database snapshot" — the
      // archive was written and read back with the database stored twice.
      // This is the only shape bsdtar has not yet been measured on.
      'no-substitution (two -C)': [],
      // Same, but the staged copy is named so the exclude cannot match it: the
      // live file is reachable as `./data/memphis.db` while the staged one is
      // `memphis.db`, a name no exclude pattern in the policy matches. This is
      // the shape that survives --exclude applying to every branch, which is
      // what bsdtar does — measured there as "accepted, NO member" for the
      // shape above.
      'staged under a distinct name': [],
      // Keeps the final path — which the restore step relies on, since it
      // runs `tar -xzf -C target` with no remapping — while excluding the
      // live file by its `./`-prefixed name only. A flat staged name would
      // land at the archive root instead of `data/`, so this shape exists to
      // test whether the exclusion can be confined to the live file instead.
      'no-exclude': [],
      // Excludes the destination DIRECTORY from the live tree and adds the
      // staged copy of that same directory from a second -C. The `./` in the
      // pattern is what separates them: the live branch archives as
      // `./data/...`, the staged one as `data/...`, so the exclusion reaches
      // the live file and not the snapshot. On GNU tar 1.35 this stores one
      // member as "data/memphis.db" — the path restore needs.
      'exclude-dir, add-staged-dir': ['--exclude=./data'],
      // `--no-recursion` plus an explicit member name per branch, so the
      // exclusion never has to match the staged copy: the live directory is
      // walked without recursion and only the files that are not databases
      // are named. bsdtar applies --exclude to every branch, which is what
      // made every shape above lose the snapshot or keep both.
      '--no-recursion, explicit members': ['--no-recursion'],
    };
    const observed: Record<string, string> = {};
    for (const [name, args] of Object.entries(shapes)) {
      const distinct = name === 'staged under a distinct name';
      const excludeLive = name === 'no-exclude';
      try {
        // `execFileSync` is mocked in this file; the dialect is a property of
        // the platform, so it must be measured against the real binary.
        actualChildProcess.execFileSync(
          'tar',
          [
            '-czf',
            join(probe, `${name.replace(/[^a-z0-9]+/gi, '-')}.tar.gz`),
            ...args,
            ...(excludeLive ? [] : ['--exclude=./data/memphis.db']),
            ...(name === 'exclude-dir, add-staged-dir' ? ['--exclude=./data'] : []),
            '-C',
            join(probe, 'in'),
            '.',
            '-C',
            join(probe, 'stage'),
            distinct ? 'memphis.db' : 'data/memphis.db',
          ],
          { stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, LC_ALL: 'C' } },
        );
        const members = actualChildProcess
          .execFileSync(
            'tar',
            ['-tzf', join(probe, `${name.replace(/[^a-z0-9]+/gi, '-')}.tar.gz`)],
            { encoding: 'utf8' },
          )
          .split('\n')
          .filter((line) => /memphis\.db$/.test(line));
        observed[name] =
          members.length === 1
            ? `accepted, one member as ${JSON.stringify(members[0])}`
            : members.length === 0
              ? 'accepted, NO member'
              : `DUPLICATE: ${JSON.stringify(members)}`;
      } catch (error) {
        observed[name] =
          `rejected: ${String((error as { stderr?: Buffer }).stderr ?? '').trim() || (error as Error).message}`;
      }
    }
    // stderr, not console.log: vitest swallows stdout from a passing test,
    // so a console.log here would be invisible in exactly the run that needs
    // it. Writing to stderr puts the measurement in the CI log.
    const version = actualChildProcess
      .execFileSync('tar', ['--version'], { encoding: 'utf8' })
      .split('\n')[0];
    process.stderr.write(`[tar-dialect] ${version}\n`);
    for (const [name, outcome] of Object.entries(observed)) {
      process.stderr.write(`[tar-dialect] ${name}: ${outcome}\n`);
    }
    // The archiver must use a shape this platform accepted. `[]` is also
    // legal — the archive is correct without any substitution — but a shape
    // the local tar rejected is a bug the next run would repeat.
    expect(
      observed[
        tarSubstitutionFlags(expr).length === 0
          ? 'no-substitution (two -C)'
          : tarSubstitutionFlags(expr)[0] === '-s'
            ? '-s EXPR'
            : '--transform=EXPR'
      ],
    ).not.toMatch(/^(rejected|DUPLICATE|NO member)/);
  });

  it('carries the snapshot under a staging name no exclusion can reach', () => {
    // The snapshot is archived as `.memphis-db-snapshot-<name>` and the
    // placement manifest says where it belongs. That indirection is what makes
    // the archive portable: the live file is excluded by its `./`-prefixed
    // name, which on bsdtar matches members in every branch, so a staged copy
    // stored under its final path was excluded along with the live file —
    // measured there as an archive with no database in it.
    const stagedPath = `${STAGED_PREFIX}memphis.db`;
    const snapshot = {
      ok: true,
      snapshotDir: '/stage',
      snapshotted: [
        { file: 'memphis.db', archivePath: 'data/memphis.db', stagedPath, source: 'x', bytes: 1 },
      ],
      excludedPaths: ['data/memphis.db', 'data/memphis.db-wal', 'data/memphis.db-shm'],
      errors: [],
    } as DatabaseSnapshotResult;

    // Both spellings a tar might store the member under are accepted.
    for (const stored of [`./${stagedPath}`, stagedPath]) {
      expect(() =>
        verifyDatabaseSnapshotEntries(snapshot, [
          './',
          './data/',
          stored,
          DATABASE_PLACEMENT_MANIFEST,
        ]),
      ).not.toThrow();
    }
    // A live database at its final path means the exclusion was lost.
    expect(() => verifyDatabaseSnapshotEntries(snapshot, [stagedPath, 'data/memphis.db'])).toThrow(
      /live database/,
    );
    // A WAL or shm alongside it restores as a torn database.
    for (const sidecar of ['./data/memphis.db-wal', './data/memphis.db-shm']) {
      expect(() => verifyDatabaseSnapshotEntries(snapshot, [stagedPath, sidecar])).toThrow(
        /sidecars/,
      );
    }
    // Two staged copies of the same database is still a failure.
    expect(() => verifyDatabaseSnapshotEntries(snapshot, [`./${stagedPath}`, stagedPath])).toThrow(
      /exactly one/,
    );
  });

  it('probes tar for the exact warning flag the archive run emits', () => {
    // The old probe asked tar to accept `--warning=no-file-changed` beside
    // `--version`, which macOS tar accepts while it is only printing its
    // version. The real run then died with
    // `tar: Option --warning=file-changed is not supported`.
    const flags = tarWarningFlags();
    expect(flags).toEqual(snapshotModule.tarWarningFlags());
    expect(tarSupportsWarningOpt()).toBe(snapshotModule.tarSupportsWarningOpt());
    for (const flag of flags) expect(flag).toMatch(/^--warning=file-(changed|removed)$/);
  });
});

describe('consistent database snapshots through every archive writer', () => {
  for (const mode of ['runner', 'cli', 'fallback'] as const) {
    it.each(['external', 'nested'] as const)(
      `${mode} restores committed WAL rows from a %s database`,
      async (location) => {
        const dataDir = location === 'external' ? join(repo, 'data') : join(state, 'data');
        const source = join(dataDir, 'memphis.db');
        const db = openWalDatabase(source);
        const archivePath = location === 'external' ? 'memphis.db' : 'data/memphis.db';
        mkdirSync(join(state, 'db-snapshot'));
        writeFileSync(join(state, 'db-snapshot/stale.db'), 'stale');
        writeFileSync(join(state, 'vault-state.json.bak-diag-fixture'), 'excluded-fixture');
        writeFileSync(join(state, '.env'), 'FIXTURE_TOKEN=must-not-ship');
        writeFileSync(join(state, 'chains/.env.local'), 'FIXTURE_TOKEN=must-not-ship');
        if (mode === 'fallback') {
          vi.mocked(execFileSync).mockImplementation(() => {
            throw Object.assign(new Error('tar unavailable in fixture'), { code: 'EACCES' });
          });
        }

        let archive: string;
        if (mode === 'runner') {
          const result = runRunner();
          expect(result.status, result.stdout + result.stderr).toBe(0);
          const report = JSON.parse(result.stdout);
          expect(report.dbSnapshot.snapshotted).toHaveLength(1);
          expect(existsSync(report.dbSnapshot.snapshotDir)).toBe(false);
          archive = report.path;
        } else {
          const created = await createBackup({ memphisRoot: state, dataDir, showProgress: false });
          expect(created.dbSnapshot.snapshotted).toHaveLength(1);
          expect(existsSync(created.dbSnapshot.snapshotDir)).toBe(false);
          archive = created.backupPath;
        }
        const entries = listArchiveContents(archive).map((entry) => entry.replace(/^\.\//, ''));
        // The archive carries the snapshot under its staging name and the
        // mapping that puts it back; `archivePath` is where restore must leave
        // it, asserted below by opening the restored database at that path.
        const stagedName = `${STAGED_PREFIX}${basename(archivePath)}`;
        expect(entries.filter((entry) => entry.endsWith('.db'))).toEqual([stagedName]);
        expect(entries).toContain(DATABASE_PLACEMENT_MANIFEST);
        expect(
          entries.some((entry) =>
            /-wal$|-shm$|(?:^|\/)db-snapshot\/?$|vault-state|(?:^|\/)\.env(?:\.|$)/.test(entry),
          ),
        ).toBe(false);
        expect(statSync(archive).mode & 0o777).toBe(0o600);
        expect(statSync(`${archive}.sha256`).mode & 0o777).toBe(0o600);
        // The writer stays open, and a later transaction cannot appear in the copy.
        db.prepare('INSERT INTO messages VALUES (?)').run('after backup');
        expect(db.pragma('journal_mode', { simple: true })).toBe('wal');

        const restoredRoot = join(root, 'restored');
        await restoreBackup({
          file: archive,
          memphisRoot: restoredRoot,
          backupRoot: join(state, 'backups'),
          confirm: true,
          showProgress: false,
        });
        const restored = new Database(join(restoredRoot, archivePath), { readonly: true });
        expect(statSync(join(restoredRoot, archivePath)).mode & 0o777).toBe(0o600);
        try {
          expect(restored.prepare('SELECT body FROM messages').all()).toEqual([
            { body: 'committed only in WAL' },
          ]);
          expect(restored.pragma('integrity_check', { simple: true })).toBe('ok');
        } finally {
          restored.close();
        }
        expect(readFileSync(join(restoredRoot, 'chains/journal-000001.json'), 'utf8')).toBe(
          '{"fixture":"chain-data"}',
        );
        expect(existsSync(join(restoredRoot, `${archivePath}-wal`))).toBe(false);
        expect(existsSync(join(restoredRoot, `${archivePath}-shm`))).toBe(false);
      },
    );
  }

  it.each(['runner', 'cli'] as const)(
    '%s refuses publication and retention after snapshot failure',
    async (mode) => {
      writeFileSync(join(repo, 'data/memphis.db'), 'not a SQLite database');
      const backups = join(state, 'backups');
      mkdirSync(backups);
      for (const file of ['scheduled-2000-01-01.tar.gz', 'scheduled-2000-01-02.tar.gz']) {
        writeFileSync(join(backups, file), 'previous archive');
      }
      if (mode === 'runner') {
        const result = runRunner(['--keep', '1']);
        expect(result.status).not.toBe(0);
        const report = JSON.parse(result.stdout);
        expect(report).toMatchObject({
          ok: false,
          published: false,
          reason: 'database-snapshot-failed',
        });
        expect(existsSync(report.dbSnapshot.snapshotDir)).toBe(false);
      } else {
        await expect(
          createBackup({ memphisRoot: state, dataDir: join(repo, 'data'), showProgress: false }),
        ).rejects.toThrow('Database snapshot failed');
      }
      expect(
        readdirSync(backups)
          .filter((file) => file.endsWith('.tar.gz'))
          .sort(),
      ).toEqual(['scheduled-2000-01-01.tar.gz', 'scheduled-2000-01-02.tar.gz']);
      expect(readdirSync(backups).filter((file) => file.endsWith('.sha256'))).toEqual([]);
    },
  );

  it('an explicit missing operational database is an error', async () => {
    const result = await snapshotDatabases({
      memphisRoot: state,
      databasePath: join(repo, 'missing.sqlite'),
    });
    snapshots.push(result);
    expect(result.ok).toBe(false);
    expect(result.errors.join()).toContain('Configured database does not exist');
  });

  it('honors an explicit operational database path with a nonstandard filename', async () => {
    const path = join(repo, 'custom/operations.sqlite');
    openWalDatabase(path);
    // An obsolete default must not be mistaken for the configured database.
    writeFileSync(join(repo, 'data/memphis.db'), 'obsolete default');
    const result = runRunner(['--database-path', path]);
    expect(result.status, result.stdout + result.stderr).toBe(0);
    const report = JSON.parse(result.stdout);
    // The runtime database gets its own archive path and staging name. It
    // lives outside the data directory, and a bare `memphis.db` would
    // collide with a data-tree database of the same name: measured on this
    // host as a restore that left `memphis.db` in the data directory, after
    // which the next backup refused to publish ("Multiple databases would
    // overwrite archive entry: memphis.db") — the operator's recovery
    // procedure broke their backups.
    expect(report.dbSnapshot.snapshotted).toMatchObject([
      { source: path, archivePath: `${RUNTIME_DB_PREFIX}operations.sqlite`, role: 'runtime' },
    ]);
  });

  it('the default CLI/runtime call uses DATABASE_URL outside the memory root', async () => {
    const path = join(repo, 'custom/operations.sqlite');
    openWalDatabase(path);
    writeFileSync(join(repo, 'data/memphis.db'), 'obsolete default');
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('MEMPHIS_DATA_DIR', state);
    vi.stubEnv('MEMPHIS_HOME', state);
    vi.stubEnv('DATABASE_URL', `file:${path}`);
    const created = await createBackup({ dataDir: join(repo, 'data'), showProgress: false });
    expect(created.dbSnapshot.snapshotted).toMatchObject([
      {
        source: path,
        archivePath: `${RUNTIME_DB_PREFIX}operations.sqlite`,
        role: 'runtime',
        stagedPath: `${STAGED_PREFIX}runtime-operations.sqlite`,
      },
    ]);
    expect(listArchiveContents(created.backupPath)).toContain(
      `${STAGED_PREFIX}runtime-operations.sqlite`,
    );
  });

  it('concurrent snapshots have separate staging and never reuse old content', async () => {
    const db = openWalDatabase(join(state, 'memphis.db'));
    const first = await snapshotDatabases({ memphisRoot: state });
    snapshots.push(first);
    db.prepare('INSERT INTO messages VALUES (?)').run('second snapshot');
    const [second, third] = await Promise.all([
      snapshotDatabases({ memphisRoot: state }),
      snapshotDatabases({ memphisRoot: state }),
    ]);
    snapshots.push(second, third);
    expect(new Set(snapshots.map((snapshot) => snapshot.snapshotDir)).size).toBe(3);
    for (const [snapshot, expected] of [
      [first, 1],
      [second, 2],
      [third, 2],
    ] as const) {
      expect(snapshot.ok).toBe(true);
      expect(statSync(snapshot.snapshotDir).mode & 0o777).toBe(0o700);
      // Staging directories hold the snapshot under its staging name; each
      // snapshot records which one it wrote, which is what makes concurrent
      // runs independent rather than sharing a fixed filename.
      const path = join(snapshot.snapshotDir, snapshot.snapshotted[0].stagedPath);
      expect(statSync(path).mode & 0o777).toBe(0o600);
      const restored = new Database(path, { readonly: true });
      try {
        expect(restored.prepare('SELECT count(*) AS n FROM messages').get()).toEqual({
          n: expected,
        });
      } finally {
        restored.close();
      }
    }
  });

  it('refuses two different databases mapped to the same archive path', async () => {
    openWalDatabase(join(state, 'memphis.db'));
    openWalDatabase(join(repo, 'data/memphis.db'));
    const result = await snapshotDatabases({ memphisRoot: state, dataDir: join(repo, 'data') });
    snapshots.push(result);
    expect(result.ok).toBe(false);
    expect(result.errors.join()).toContain('Multiple databases');
  });

  it('the runner dry run makes no directories and never opens an invalid database', () => {
    writeFileSync(join(repo, 'data/memphis.db'), 'not SQLite');
    const before = readdirSync(state);
    const result = runRunner(['--dry-run']);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).dryRun).toBe(true);
    expect(readdirSync(state)).toEqual(before);
  });

  it('CLI creation keeps a failed tar private and unpublished', async () => {
    vi.mocked(execFileSync).mockImplementation((file, args) => {
      const argv = args as string[];
      if (file === 'tar' && argv[0] === '-czf') {
        const partial = argv[1];
        expect(partial.endsWith('.tar.gz.partial')).toBe(true);
        expect(statSync(partial).mode & 0o777).toBe(0o600);
        expect(existsSync(partial.replace(/\.partial$/, ''))).toBe(false);
        throw Object.assign(new Error('fixture tar read error'), { status: 2 });
      }
      return actualChildProcess.execFileSync(file, argv);
    });
    await expect(createBackup({ memphisRoot: state, showProgress: false })).rejects.toThrow(
      'fixture tar read error',
    );
    expect(
      readdirSync(join(state, 'backups')).filter(
        (file) => file.endsWith('.tar.gz') || file.endsWith('.sha256'),
      ),
    ).toEqual([]);
  });

  it.each([true, false])(
    'tar exit 1 requires a file-change diagnostic (%s)',
    async (diagnostic) => {
      vi.mocked(execFileSync).mockImplementation((file, args, options) => {
        const argv = args as string[];
        const result = actualChildProcess.execFileSync(file, argv, options);
        if (file === 'tar' && argv[0] === '-czf') {
          throw Object.assign(new Error('fixture tar exit 1'), {
            status: 1,
            stderr:
              diagnostic && !argv.includes('--warning=no-file-changed')
                ? 'tar: .: file changed as we read it'
                : '',
          });
        }
        return result;
      });
      const creation = createBackup({ memphisRoot: state, showProgress: false });
      if (diagnostic) {
        const created = await creation;
        expect(existsSync(`${created.backupPath}.sha256`)).toBe(true);
      } else {
        await expect(creation).rejects.toThrow('fixture tar exit 1');
        expect(
          readdirSync(join(state, 'backups')).filter((file) => file.endsWith('.tar.gz')),
        ).toEqual([]);
      }
    },
  );
});
