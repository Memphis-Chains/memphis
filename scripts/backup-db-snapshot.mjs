import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import Database from 'better-sqlite3';

// Kept in the exclusion policy for staging directories left by older versions.
export const SNAPSHOT_DIR_NAME = 'db-snapshot';
// Staged databases are stored under this prefix so no --exclude pattern in
// backup-exclude-policy.json can reach them on a tar that applies exclusions
// to every branch. Restore maps them back to their recorded archive path.
export const STAGED_PREFIX = '.memphis-db-snapshot-';
// Carried inside the archive; restore deletes it after placing the databases,
// so it never becomes part of the restored data directory.
export const DATABASE_PLACEMENT_MANIFEST = '.memphis-db-placement.json';
/**
 * Archive-path namespace for the runtime database (the one `DATABASE_URL`
 * points at). It lives outside the data directory, so it must not share an
 * archive path with a data-tree database of the same name.
 */
export const RUNTIME_DB_PREFIX = 'runtime/';
const DATABASES = ['memphis.db', 'dashboard.db'];

function pathWithin(root, source) {
  const path = relative(root, source);
  return path && !isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`)
    ? path.split(sep).join('/')
    : null;
}

/** Each invocation owns a private staging directory, including concurrent runs. */
export async function snapshotDatabases({ memphisRoot, dataDir, databasePath }) {
  const root = resolve(memphisRoot);
  const snapshotDir = mkdtempSync(join(tmpdir(), 'memphis-db-snapshot-'));
  chmodSync(snapshotDir, 0o700);
  const result = { ok: true, snapshotDir, snapshotted: [], excludedPaths: [], errors: [] };
  const sources = new Map();
  const add = (source, file) => {
    const absolute = resolve(source);
    if (existsSync(absolute)) sources.set(absolute, file);
  };
  for (const dir of new Set([root, join(root, 'data'), ...(dataDir ? [resolve(dataDir)] : [])])) {
    for (const file of DATABASES) {
      const source = join(dir, file);
      // A configured operational DB replaces the external default. A stale
      // repo/data/memphis.db must not shadow DATABASE_URL or cause a collision.
      if (
        databasePath &&
        file === 'memphis.db' &&
        !pathWithin(root, source) &&
        resolve(source) !== resolve(databasePath)
      )
        continue;
      add(source, file);
    }
  }
  if (databasePath) {
    if (!existsSync(databasePath)) {
      result.errors.push(`Configured database does not exist: ${databasePath}`);
    } else {
      // The REAL file name, not a fixed 'memphis.db'. The configured
      // database can be called anything (`operations.sqlite` in the
      // contract test), and a fixed name made the archive claim to hold a
      // file that was never there — the restore then wrote it under a name
      // the source never used.
      add(databasePath, basename(databasePath));
    }
  }

  // The runtime database is the one `DATABASE_URL` points at. It usually
  // lives OUTSIDE the data directory (`<install root>/data/memphis.db`), so
  // it is restored to the path the runtime reads, not into the data tree.
  //
  // Giving it its own archive path and staging name is what keeps two
  // databases with the same basename apart. Measured on this host: a restore
  // left `memphis.db` in the data directory, and the next backup then found
  // two databases claiming the archive entry `memphis.db` and refused to
  // publish — the operator's recovery procedure broke their backups.
  const runtimeSource = databasePath ? resolve(databasePath) : undefined;

  const destinations = new Set();
  for (const [source, file] of sources) {
    const localPath = pathWithin(root, source);
    const isRuntimeDatabase = runtimeSource !== undefined && resolve(source) === runtimeSource;
    const archivePath = isRuntimeDatabase ? `${RUNTIME_DB_PREFIX}${file}` : (localPath ?? file);
    if (destinations.has(archivePath)) {
      result.errors.push(`Multiple databases would overwrite archive entry: ${archivePath}`);
      continue;
    }
    destinations.add(archivePath);
    if (localPath) {
      result.excludedPaths.push(localPath, `${localPath}-wal`, `${localPath}-shm`);
    }
    // Written under the staging name, not the final path — see
    // databaseSnapshotTarArgs() for the measurement behind that. The runtime
    // database gets its own staging name so it cannot overwrite a data-tree
    // database that happens to share its basename.
    const stagedPath = isRuntimeDatabase
      ? `${STAGED_PREFIX}runtime-${file}`
      : `${STAGED_PREFIX}${basename(archivePath)}`;
    const target = join(snapshotDir, stagedPath);
    try {
      mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
      const sourceDb = new Database(source, { readonly: true, fileMustExist: true });
      try {
        const deadline = Date.now() + 30_000;
        await sourceDb.backup(target, {
          progress() {
            if (Date.now() > deadline) throw new Error('Database snapshot timed out');
          },
        });
      } finally {
        sourceDb.close();
      }
      // Only the private copy is modified. Closing this connection leaves a
      // self-contained file; the source keeps its active WAL and writer.
      const snapshotDb = new Database(target, { fileMustExist: true });
      try {
        snapshotDb.pragma('journal_mode = DELETE');
        if (snapshotDb.pragma('quick_check', { simple: true }) !== 'ok') {
          throw new Error('Database snapshot failed quick_check');
        }
      } finally {
        snapshotDb.close();
      }
      chmodSync(target, 0o600);
      result.snapshotted.push({
        file,
        archivePath,
        stagedPath,
        source,
        bytes: statSync(target).size,
        role: isRuntimeDatabase ? 'runtime' : 'data-dir',
      });
    } catch (error) {
      rmSync(target, { force: true });
      result.errors.push(`${source}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (result.snapshotted.length > 0) {
    // The manifest is what lets restore place a snapshot stored under a
    // staging name. It is written last, and only on success, so a failed
    // snapshot never leaves a manifest pointing at files that do not exist.
    const { manifestName, content } = databasePlacementManifest(result);
    writeFileSync(join(snapshotDir, manifestName), content, { mode: 0o600 });
  }

  result.ok = result.errors.length === 0;
  return result;
}

let cachedWarningOpt = null;

/**
 * Whether the local tar understands `--warning=`.
 *
 * The probe must ask about the exact flag the archive run emits. Probing
 * `--warning=no-file-changed` next to `--version` answered yes on the macOS
 * runner while the real run died with
 * `tar: Option --warning=file-changed is not supported`, exit 2 — tar accepts
 * an unknown long option while merely printing its version.
 */
export function tarSupportsWarningOpt() {
  if (cachedWarningOpt !== null) return cachedWarningOpt;
  try {
    execFileSync('tar', ['--warning=file-changed', '--warning=file-removed', '--version'], {
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    cachedWarningOpt = true;
  } catch {
    cachedWarningOpt = false;
  }
  return cachedWarningOpt;
}

/** Warning flags, or none when tar cannot take them. */
export function tarWarningFlags() {
  return tarSupportsWarningOpt() ? ['--warning=file-changed', '--warning=file-removed'] : [];
}

let cachedSubstitution = null;

/**
 * The flag this tar uses to rewrite a member's stored name.
 *
 * GNU: `--transform=<sed>`. BSD (macOS, libarchive): `-s <sed>`. Probing with
 * `--version` cannot decide it — the macOS runner printed no complaint about
 * an unknown `--transform` while it was only printing its version, then
 * answered `tar: Option --transform=... is not supported` on the real archive
 * run, while the previous `-s` fallback there means `--same-order` in GNU.
 *
 * So this performs the smallest real archive run that must succeed, and
 * remembers which flag produced a readable archive. A guess here is what
 * made two consecutive CI runs red on macOS while passing on Linux.
 */
export function tarSubstitutionFlags(substitution) {
  if (cachedSubstitution === null) {
    const probe = mkdtempSync(join(tmpdir(), 'memphis-tar-probe-'));
    try {
      mkdirSync(join(probe, 'in'));
      mkdirSync(join(probe, 'stage'));
      writeFileSync(join(probe, 'in/keep.txt'), 'keep');
      writeFileSync(join(probe, 'stage/staged.txt'), 'staged');
      const attempt = (args) => {
        try {
          execFileSync(
            'tar',
            [
              '-czf',
              join(probe, 'probe.tar.gz'),
              ...args,
              '-C',
              join(probe, 'in'),
              '.',
              '-C',
              join(probe, 'stage'),
              'staged.txt',
            ],
            { stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, LC_ALL: 'C' } },
          );
          return execFileSync('tar', ['-tzf', join(probe, 'probe.tar.gz')], {
            encoding: 'utf8',
          }).includes('staged.txt');
        } catch {
          return false;
        }
      };
      cachedSubstitution = attempt([`--transform=s|^stage/|./|`])
        ? ['--transform']
        : attempt(['-s', 's|^stage/|./|'])
          ? ['-s']
          : [];
    } finally {
      rmSync(probe, { recursive: true, force: true });
    }
  }
  // [] means no substitution flag is available; the caller then relies on names
  // being stored as-is, which it already handles. The two dialects take the
  // expression differently — GNU as `--transform=EXPR`, BSD as two arguments
  // `-s EXPR` — and passing `-s=EXPR` to BSD tar is what produced
  // `archive-not-listable` on the macOS runner.
  if (cachedSubstitution[0] === '-s') return ['-s', substitution];
  return cachedSubstitution.length === 0 ? [] : [`--transform=${substitution}`];
}

/**
 * The placement manifest, as archive content.
 *
 * Written next to the staged databases and carried by the same archive, so an
 * archive is self-describing: restoring it elsewhere, or extracting it by
 * hand, still places each database where it belongs. Its name is recorded in
 * the exclude policy so it never rides along from the live data directory.
 */
export function databasePlacementManifest(snapshot) {
  const placements = {};
  for (const { stagedPath, archivePath, role } of snapshot.snapshotted) {
    // v2 records the role. v1 could only express "a file inside the data
    // directory", which is why a runtime database restored from a v1 archive
    // landed somewhere the runtime never reads.
    placements[stagedPath] = { path: archivePath, role: role ?? 'data-dir' };
  }
  return {
    manifestName: DATABASE_PLACEMENT_MANIFEST,
    content: `${JSON.stringify(
      {
        format: 'memphis-db-placement-v2',
        // Written by the archiver; restore refuses a path it considers unsafe
        // through the same check every other archive entry passes.
        placements,
      },
      null,
      2,
    )}\n`,
  };
}


export function cleanupDatabaseSnapshots(snapshot) {
  rmSync(snapshot.snapshotDir, { recursive: true, force: true });
}

/**
 * Exclude live files, then add the snapshots under their restoration paths.
 *
 * The substitution flag is probed, never assumed: GNU tar has `--transform`,
 * the BSD tar on macOS has `-s`, and each is an unknown-option error on the
 * other. Guessing it redlined two consecutive macOS runs while Linux stayed
 * green — `--version` accepts either flag, so it cannot answer this.
 *
 * `--exclude` is matched against the name BEFORE the substitution is applied,
 * and against names in every branch, so excluding `./data/memphis.db` to drop
 * the live file also drops the staged copy of the same name — the archive
 * comes out with no database at all, which is what `archive-not-listable`
 * reported. The live file is reached through `.`, so its archived name carries
 * the `./` prefix, while the staged copy is named without it and survives.
 * Measured by hand on all three shapes: keeping both yields two members of
 * the same name, dropping both yields none, this yields exactly one.
 */
/**
 * Stage every database under a name no exclude pattern in the policy can
 * match, and let the restore step move it to its final path.
 *
 * Measured on both tars (the probe in db-snapshot-contract.test.ts prints
 * the table on every run):
 *   - GNU tar 1.35 accepts `--transform=EXPR`, so the name could be rewritten
 *     during archiving.
 *   - bsdtar 3.5.3 / libarchive rejects `--transform` outright, and its `-s`
 *     takes no expression we can build. There is no substitution syntax that
 *     works on both.
 *   - With no substitution, `--exclude` is matched against the member name in
 *     EVERY branch, so excluding `./data/memphis.db` to drop the live file also
 *     drops the staged copy: measured as "accepted, NO member".
 *
 * A staged name the exclusions cannot reach is therefore the only shape that
 * carries the database on both. The cost is that the archive stores the
 * snapshot under its staging name, so `restoreBackup` moves it into place —
 * which it can do, because it already extracts into a staging directory and
 * renames each top-level entry afterwards.
 *
 * The mapping is recorded in the archive itself rather than in a side file,
 * so an archive carries enough to be restored on its own.
 */
export function databaseSnapshotTarArgs(snapshot, memphisRoot) {
  if (snapshot.snapshotted.length === 0) return ['-C', memphisRoot, '.'];
  // The staged name is READ from the snapshot, never recomputed here. The
  // runtime database carries its own staging name (it must not collide with
  // a data-tree database of the same basename), and a name recomputed from
  // `archivePath` would silently point at a file that does not exist —
  // measured as `tar: .memphis-db-snapshot-memphis.db: Cannot stat`.
  const staged = snapshot.snapshotted.map(({ archivePath, stagedPath }) => ({
    archivePath,
    stagedPath,
  }));
  return [
    ...snapshot.excludedPaths.map((path) => `--exclude=./${path.replace(/[?*[]/g, '[$&]')}`),
    '-C',
    memphisRoot,
    '.',
    '-C',
    snapshot.snapshotDir,
    ...staged.map(({ stagedPath }) => stagedPath),
    DATABASE_PLACEMENT_MANIFEST,
  ];
}

/**
 * Archive members that place a staged database at its final path.
 *
 * Consumed by restore after extraction. Every entry is checked against the
 * same rules as any other archive path, and a missing staged database is an
 * error rather than a silent partial restore.
 */

export function verifyDatabaseSnapshotEntries(snapshot, entries) {
  const paths = entries.map((entry) => entry.replace(/^\.\//, ''));
  for (const { archivePath, stagedPath } of snapshot.snapshotted) {
    // The staged name is what the archiver must carry; the final path is what
    // restore must produce. Both are checked, so an archive that happens to
    // hold a database under its final name cannot pass by accident.
    if (paths.filter((entry) => entry === stagedPath).length !== 1) {
      throw new Error(`Archive must contain exactly one database snapshot: ${stagedPath}`);
    }
    if (paths.includes(archivePath)) {
      throw new Error(`Archive contains a live database at ${archivePath}, not a snapshot`);
    }
    if (paths.includes(`${archivePath}-wal`) || paths.includes(`${archivePath}-shm`)) {
      throw new Error(`Archive contains live database sidecars: ${archivePath}`);
    }
  }
}
