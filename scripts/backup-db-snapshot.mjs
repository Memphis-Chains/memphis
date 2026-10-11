import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

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

export function cleanupDatabaseSnapshots(snapshot) {
  rmSync(snapshot.snapshotDir, { recursive: true, force: true });
}

/** Exclude live files, then add the snapshots under their restoration paths. */
export function databaseSnapshotTarArgs(snapshot, memphisRoot, gnuTar = true) {
  if (snapshot.snapshotted.length === 0) return ['-C', memphisRoot, '.'];
  const stageName = basename(snapshot.snapshotDir);
  const substitution = `s|^${stageName}/|./|`;
  return [
    ...snapshot.excludedPaths.map((path) => `--exclude=./${path.replace(/[?*[]/g, '[$&]')}`),
    ...(gnuTar ? [`--transform=${substitution}`] : ['-s', substitution]),
    '-C',
    memphisRoot,
    '.',
    '-C',
    dirname(snapshot.snapshotDir),
    ...snapshot.snapshotted.map(({ archivePath }) => `${stageName}/${archivePath}`),
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
