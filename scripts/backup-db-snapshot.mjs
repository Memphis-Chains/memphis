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
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import Database from 'better-sqlite3';

// Kept in the exclusion policy for staging directories left by older versions.
export const SNAPSHOT_DIR_NAME = 'db-snapshot';
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
      add(databasePath, 'memphis.db');
    }
  }

  const destinations = new Set();
  for (const [source, file] of sources) {
    const localPath = pathWithin(root, source);
    const archivePath = localPath ?? file;
    if (destinations.has(archivePath)) {
      result.errors.push(`Multiple databases would overwrite archive entry: ${archivePath}`);
      continue;
    }
    destinations.add(archivePath);
    if (localPath) {
      result.excludedPaths.push(localPath, `${localPath}-wal`, `${localPath}-shm`);
    }
    const target = join(snapshotDir, archivePath);
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
      result.snapshotted.push({ file, archivePath, source, bytes: statSync(target).size });
    } catch (error) {
      rmSync(target, { force: true });
      result.errors.push(`${source}: ${error instanceof Error ? error.message : String(error)}`);
    }
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
export function databaseSnapshotTarArgs(snapshot, memphisRoot) {
  if (snapshot.snapshotted.length === 0) return ['-C', memphisRoot, '.'];
  const staged = snapshot.snapshotted.map(({ archivePath }) => archivePath);
  const substitution = staged.map((archivePath) => `s|^${archivePath}|./${archivePath}|`).join(',');
  return [
    ...snapshot.excludedPaths.map((path) => `--exclude=./${path.replace(/[?*[]/g, '[$&]')}`),
    ...(substitution ? tarSubstitutionFlags(substitution) : []),
    '-C',
    memphisRoot,
    '.',
    '-C',
    snapshot.snapshotDir,
    ...staged,
  ];
}

export function verifyDatabaseSnapshotEntries(snapshot, entries) {
  const paths = entries.map((entry) => entry.replace(/^\.\//, ''));
  for (const { archivePath } of snapshot.snapshotted) {
    if (paths.filter((entry) => entry === archivePath).length !== 1) {
      throw new Error(`Archive must contain exactly one database snapshot: ${archivePath}`);
    }
    if (paths.includes(`${archivePath}-wal`) || paths.includes(`${archivePath}-shm`)) {
      throw new Error(`Archive contains live database sidecars: ${archivePath}`);
    }
  }
}
