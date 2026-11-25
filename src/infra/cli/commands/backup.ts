import { createHash } from 'node:crypto';
import {
  appendFileSync,
  chmodSync,
  closeSync,
  copyFileSync,
  createReadStream,
  existsSync,
  mkdirSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { gunzip, gzip, gunzipSync, constants } from 'node:zlib';

import chalk from 'chalk';
import cliProgress from 'cli-progress';

import {
  DATABASE_PLACEMENT_MANIFEST,
  cleanupDatabaseSnapshots,
  databaseSnapshotTarArgs,
  snapshotDatabases,
  tarWarningFlags,
  verifyDatabaseSnapshotEntries,
  type DatabaseSnapshotResult,
} from './backup-db-snapshot.js';
// The manifest is one index of the archives on disk, and both writers of
// archives — this CLI and the systemd runner — keep it. The implementation
// lives in `scripts/backup-manifest.mjs` so the two cannot drift apart;
// `backup-manifest-contract.test.ts` holds them to the same list of exports.
import {
  deriveTagFromFileName,
  readManifest,
  removeManifestEntries,
  upsertManifestEntry as upsertManifestEntryShared,
  type BackupManifest,
  type BackupManifestEntry,
} from './backup-manifest.js';
// The rule that invokes tar — ONE owner, TWO runners: this CLI (which the
// runtime calls from inside its own event loop) and the plain-Node systemd
// runner. The calls are asynchronous on purpose: a synchronous `tar` froze
// the runtime's event loop for 22 minutes, and a frozen loop cannot answer a
// stop signal — measured 2026-11-25 on this host, see
// `scripts/backup-tar.mjs` for the whole measurement.
import {
  describeTarFailure,
  isTarExecutionError,
  isTarFileChangedWarning,
  tarCreateArchive,
  tarExtractArchive,
  tarListArchiveContents,
  tarListArchiveVerbose,
} from './backup-tar.js';
import { getDataDir } from '../../../config/paths.js';
// The rule that decides what a directory under `chains/` IS — a chain, a
// rollback copy of one, or neither. The owner is the Rust core; this is its
// mirror, and the mirror is compared against the owner's answers by
// `tests/unit/chain-name-contract.test.ts`. The drill asks it instead of
// guessing, because guessing is what made the drill report three days of
// false failures.
import { classifyChainDirectory } from '../../../memory/chain-catalog.js';
import { requireOperatorAuth } from '../../auth/operator-gate.js';
import { resolveDotEnvPath } from '../../config/dotenv-file.js';
import { classifyField } from '../../config/mutability.js';
import type { CliContext } from '../context.js';
import { print } from '../utils/render.js';

/**
 * Shared backup exclusion policy — ONE source of truth for every archiver.
 *
 * Historically the CLI (`createArchive`) and the systemd runner
 * (`scripts/scheduled-backup-runner.mjs`) each kept their own hand-written
 * exclude list, and they disagreed: the runner excluded nothing secret at
 * all, and BOTH used literal paths (`--exclude=./vault-entries.json`) which
 * do not match suffixed variants. Measured on this host: `*.bak-diag-*`
 * vault copies present in 6/7 archives, `site-secrets/*.htpasswd` in 4/7.
 *
 * The policy lives in `scripts/backup-exclude-policy.json` so the plain-Node
 * runner can read it too (it cannot import TypeScript). Read relative to the
 * compiled module so it works from both `src/` (tsx) and `dist/`.
 */
const BACKUP_EXCLUDE_POLICY_FILE = 'backup-exclude-policy.json';

type BackupExcludePolicy = {
  excludePatterns: string[];
  fallbackExcludeNames: string[];
};

function readBackupExcludePolicy(): BackupExcludePolicy {
  const candidates = [
    resolve(process.cwd(), 'scripts', BACKUP_EXCLUDE_POLICY_FILE),
    resolve(
      dirname(fileURLToPath(import.meta.url)),
      '../../../scripts',
      BACKUP_EXCLUDE_POLICY_FILE,
    ),
    resolve(
      dirname(fileURLToPath(import.meta.url)),
      '../../../../scripts',
      BACKUP_EXCLUDE_POLICY_FILE,
    ),
  ];
  for (const candidate of candidates) {
    try {
      const raw = readFileSync(candidate, 'utf8');
      const parsed = JSON.parse(raw) as Partial<BackupExcludePolicy>;
      if (Array.isArray(parsed.excludePatterns) && Array.isArray(parsed.fallbackExcludeNames)) {
        return {
          excludePatterns: parsed.excludePatterns.filter((p) => typeof p === 'string'),
          fallbackExcludeNames: parsed.fallbackExcludeNames.filter((n) => typeof n === 'string'),
        };
      }
    } catch {
      // try next candidate
    }
  }
  throw new Error(
    `Backup exclude policy not found or malformed: ${BACKUP_EXCLUDE_POLICY_FILE}. ` +
      'Refusing to archive without a known exclusion policy — an unfiltered ' +
      'archive would pack vault material. Checked: ' +
      candidates.join(', '),
  );
}

const BACKUP_EXCLUDE_POLICY = readBackupExcludePolicy();

/** tar argv entries (`--exclude=...`) shared by every archive path. */
export const BACKUP_EXCLUDE_PATTERNS: readonly string[] = BACKUP_EXCLUDE_POLICY.excludePatterns;
/** Top-level directory + file names the JSON fallback archiver must skip. */
export const FALLBACK_EXCLUDE_NAMES: readonly string[] = BACKUP_EXCLUDE_POLICY.fallbackExcludeNames;

/**
 * gzip/gunzip that do not hold the event loop.
 *
 * The JSON fallback archiver compresses and decompresses the WHOLE archive
 * in memory. `gzipSync`/`gunzipSync` do that work on the main thread, which
 * is the runtime's thread — the same freeze the synchronous `tar` caused.
 * Node's zlib has no promise form of its own, so the callback API is
 * promisified here. Measured on this host: `promisify(zlib.gunzip)` resolves
 * with a Buffer, exactly like the synchronous form.
 */
const gunzipAsync = promisify(gunzip);
const gzipAsync = promisify(gzip);

/**
 * Basenames of secret material, WITHOUT the glob prefix and without the
 * trailing `*`. A name matches when it equals the base, or starts with
 * `base.` or `base-`, which covers `.bak-diag-*`, `.tmp`, `.old`.
 */
export const SECRET_BASENAME_PREFIXES: readonly string[] = [
  'vault-entries.json',
  'vault-state.json',
  '.tier2-passphrase',
  '.github-pat',
  'memphis.pid',
  'boot-failures.json',
];

const DERIVED_PATHS = ['case-index.sqlite', 'embeddings'] as const;

export type BackupOptions = {
  backupRoot?: string;
  memphisRoot?: string;
  tag?: string;
  showProgress?: boolean;
  /** Optional directory containing databases outside memphisRoot. */
  dataDir?: string;
  /** Exact operational database path; an explicitly missing database is fatal. */
  databasePath?: string;
};

export type RestoreOptions = {
  file: string;
  backupRoot?: string;
  memphisRoot?: string;
  confirm?: boolean;
  showProgress?: boolean;
  /**
   * Vault pepper used by the source host when the backup was created. When
   * supplied, written into the restored `.env` so the vault stays decryptable
   * after restoring to a host whose `MEMPHIS_VAULT_PEPPER` differs.
   *
   * The pepper is never logged or echoed in any restore output.
   */
  pepperRestore?: string;
};

export type ManifestEntry = BackupManifestEntry;

type Manifest = BackupManifest;

type BackupArchiveEntry = {
  path: string;
  kind: 'dir' | 'file';
  contentBase64?: string;
};

type BackupArchive = {
  format: 'memphis-backup-v1';
  entries: BackupArchiveEntry[];
};

const BACKUP_SUFFIX = '.tar.gz';
/**
 * Suffix for an archive that is still being written. Anything carrying it is
 * in-flight or failed: it must not be listed, verified, retained, copied
 * offsite, or counted in backup health. Mirrors PARTIAL_SUFFIX in
 * scripts/scheduled-backup-runner.mjs — keep the two in sync.
 */
const PARTIAL_SUFFIX = '.partial';
const CHECKSUM_SUFFIX = '.sha256';
const DEFAULT_TAG = 'backup';

function getMemphisRoot(override?: string): string {
  return resolve(override ?? getDataDir());
}

function getBackupsRoot(options?: BackupOptions | RestoreOptions): string {
  return resolve(options?.backupRoot ?? join(getMemphisRoot(options?.memphisRoot), 'backups'));
}

function nowStamp(date = new Date()): string {
  const pad = (v: number) => String(v).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}-${pad(date.getHours())}-${pad(date.getMinutes())}`;
}

function normalizeTag(tag?: string): string {
  return (
    (tag ?? DEFAULT_TAG)
      .trim()
      .replace(/\s+/g, '-')
      .replace(/[^a-zA-Z0-9-_]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '') || DEFAULT_TAG
  );
}

function createUniqueBackupFilename(backupRoot: string, tag?: string): string {
  const safeTag = normalizeTag(tag);
  const base = `${safeTag}-${nowStamp()}`;
  let candidate = `${base}${BACKUP_SUFFIX}`;
  let suffix = 1;

  while (
    [candidate, `${candidate}${PARTIAL_SUFFIX}`, `${candidate}${CHECKSUM_SUFFIX}`].some((file) =>
      existsSync(join(backupRoot, file)),
    )
  ) {
    candidate = `${base}-${suffix}${BACKUP_SUFFIX}`;
    suffix += 1;
  }

  return candidate;
}

/**
 * The archive's digest, read as a STREAM.
 *
 * `readFileSync` on a 182 MB archive pulls the whole file into the heap and
 * holds the event loop for the length of the read — measured on this host:
 * 0.83 s for the digest alone, all of it inside the runtime's loop. The
 * stream reads the same bytes in chunks and yields between them, so the
 * loop keeps turning while the digest is computed.
 */
async function sha256ForFile(path: string): Promise<string> {
  const hash = createHash('sha256');
  const stream = createReadStream(path);
  for await (const chunk of stream) {
    hash.update(chunk as Buffer);
  }
  return hash.digest('hex');
}

function checksumFilePathFor(archivePath: string): string {
  return `${archivePath}${CHECKSUM_SUFFIX}`;
}

function readChecksumHex(archivePath: string): string | undefined {
  const checksumPath = checksumFilePathFor(archivePath);
  if (!existsSync(checksumPath)) return undefined;
  const raw = readFileSync(checksumPath, 'utf8').trim();
  const [hex] = raw.split(/\s+/);
  return hex;
}

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

/**
 * Where the drill extracts to: NEXT TO THE ARCHIVE.
 *
 * The drill needs room for the archive's own contents, and the filesystem
 * that holds the archive is the one that has it. The old rule was
 * `os.tmpdir()`, which on this host is a tmpfs — RAM — so the drill's
 * verdict depended on how much free memory the machine had. MEASURED
 * 2026-11-25: the scheduled archive is 182 MB and extracts to 486 MB, the
 * drill also gunzipped the whole archive into a 486 MB buffer and then
 * into a 486 MB string, and the host's swap was fully consumed (4095 of
 * 4095 MB). The drill's answer was a property of the machine, not of the
 * backup.
 *
 * Next to the archive the scratch is also inside the backups root, and the
 * archiver EXCLUDES that root (`--exclude=./backups`,
 * `scripts/backup-exclude-policy.json`), so a drill in flight can never end
 * up inside the next backup.
 */
function drillScratchRoot(archivePath: string): string {
  return dirname(resolve(archivePath));
}

/**
 * The prefix of a drill's scratch directory.
 *
 * The drill's scratch is named after the process that OWNS it, so that a
 * later drill can tell "this scratch is still in use" from "this scratch is
 * the corpse of a drill that was killed".
 */
const DRILL_SCRATCH_PREFIX = 'memphis-verified-drill-';

/**
 * The shape of a scratch that names its owner: the owner's pid, a dash, and
 * the six random characters `mkdtemp` appends.
 *
 * The dash is what separates this shape from the OLD one — a bare
 * `mkdtemp` suffix such as `Jsb39N`, which carries no owner. The dash
 * matters: a legacy suffix can START with digits (`3sb39N`), so parsing the
 * digits of a legacy name as a pid would name a process that never owned
 * the scratch.
 */
const DRILL_SCRATCH_OWNER = /^(\d+)-/;

/**
 * How long a scratch without a provable owner may sit before it counts as
 * abandoned.
 *
 * The longest drill MEASURED on this host was 22 m 16 s (in the runtime,
 * before E-08's repair); the repaired drill takes 15–19 s. Six hours is
 * ~16× the worst measurement, so a scratch older than that cannot belong to
 * a drill in flight — and a scratch younger than that is left alone.
 */
const ABANDONED_SCRATCH_MS = 6 * 60 * 60 * 1000;

/**
 * Is that process still alive?
 *
 * `process.kill(pid, 0)` asks the kernel without sending anything: it throws
 * ESRCH when the process is gone and EPERM when it exists but belongs to
 * somebody else. EPERM therefore means ALIVE — and it is the safe answer: a
 * scratch we cannot prove is dead is a scratch we do not touch.
 */
function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Remove the scratch of drills that cannot be in flight.
 *
 * WHY: a drill's scratch is ~489 MB and 13 002 files, and the drill removes
 * it in a `finally` — which does not run when the process is killed. MEASURED
 * on this host, 2026-11-25: the live stop-during-drill test left
 * `memphis-verified-drill-Jsb39N` behind with 489 MB and 13 002 files, and
 * nothing in the runtime ever collected it. A drill that is stopped leaves a
 * corpse; somebody has to bury it.
 *
 * THE RULE, in two cases, and both of them are PROOFS rather than guesses:
 *
 * 1. **The scratch names its owner.** The name carries the owner's pid, so
 *    the kernel can be asked whether that process still exists. ESRCH means
 *    it is gone and the scratch is a corpse. EPERM means it exists and
 *    belongs to somebody else — ALIVE, so the scratch is left alone.
 * 2. **The scratch names no owner** (the shape the drill used before the
 *    pid was put in the name — this is the shape of the measured 489 MB
 *    corpse). There is nobody to ask, so the question is answered by the
 *    directory's own **ctime**: the last time an entry was created inside
 *    it, which is the extraction itself. tar RESTORES the mtime, so the
 *    mtime of the scratch points at the ARCHIVE's time and says nothing
 *    about the drill — the ctime cannot be forged by tar, and it is the
 *    only one of the two that means "when was this being filled".
 *
 * The drill's OWN scratch is never touched, and a scratch that belongs to a
 * live process is never touched: a drill running in another process must
 * not be disturbed. `staleMs` is the threshold of case 2; it is a parameter
 * so the gate can hold the rule to a fixed answer instead of waiting hours.
 */
export function reapDeadDrillScratch(root: string, staleMs = ABANDONED_SCRATCH_MS): string[] {
  const removed: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return removed;
  }
  const now = Date.now();
  for (const entry of entries) {
    if (!entry.startsWith(DRILL_SCRATCH_PREFIX)) continue;
    const full = join(root, entry);
    const owner = DRILL_SCRATCH_OWNER.exec(entry.slice(DRILL_SCRATCH_PREFIX.length));
    if (owner) {
      const pid = Number.parseInt(owner[1], 10);
      if (pid <= 0 || pid === process.pid) continue;
      if (processAlive(pid)) continue;
    } else {
      // No owner in the name: the scratch is only a corpse if nothing can be
      // extracting into it any more. The ctime is when the last entry was
      // created inside it — the extraction.
      let ctime: number;
      try {
        // `ctimeMs` carries sub-millisecond digits and `Date.now()` does
        // not, so the two are compared on whole milliseconds — otherwise a
        // scratch created in the same millisecond as the call would look
        // like it came from the future.
        ctime = Math.floor(statSync(full).ctimeMs);
      } catch {
        continue;
      }
      if (now - ctime < staleMs) continue;
    }
    try {
      rmSync(full, { recursive: true, force: true });
      removed.push(entry);
    } catch {
      // Best effort: a scratch we cannot remove is not a reason to fail a
      // drill over somebody else's leftovers.
    }
  }
  return removed;
}

/**
 * Cached result of `tar --warning=no-file-changed --version` probe.
 * GNU tar accepts the flag; BSD tar (macOS default) rejects it with
 * "Option --warning=no-file-changed is not supported" and exit 1,
 * which would unconditionally fail every backup if we passed the
 * flag without checking. Caching avoids re-probing on every backup
 * (tar variant doesn't change mid-runtime).
 */

/**
 * Is this archive the JSON fallback format?
 *
 * The fallback archive is a gzip stream whose content is a JSON document
 * that starts with '{'. A tar archive's content starts with a tar header,
 * whose first bytes are the member's name — never '{'.
 *
 * The check reads the HEAD of the stream, not the whole file. It used to
 * gunzip the entire archive and convert the result to a string, because the
 * question was "does the whole thing parse as JSON" — and on this host
 * that allocated a 486 MB buffer and then a 486 MB string to answer "no,
 * it is a tar". The drill's verdict must not depend on how much memory the
 * machine has.
 */
function looksLikeFallbackArchive(archivePath: string): boolean {
  let handle: number | undefined;
  try {
    handle = openSync(archivePath, 'r');
    const head = Buffer.alloc(FALLBACK_PEEK_BYTES);
    const read = readSync(handle, head, 0, head.length, 0);
    if (read <= 0) return false;
    // Z_SYNC_FLUSH returns the bytes decoded so far instead of failing on
    // the truncated stream — which is exactly what a head is.
    const prefix = gunzipSync(head.subarray(0, read), {
      finishFlush: constants.Z_SYNC_FLUSH,
    }).toString('utf8');
    return prefix.trimStart().startsWith('{');
  } catch {
    return false;
  } finally {
    if (handle !== undefined) closeSync(handle);
  }
}

/**
 * The JSON fallback archive, read without freezing the loop.
 *
 * The probe above (`looksLikeFallbackArchive`) stays synchronous on purpose:
 * it reads 64 KiB and gunzips that, which is bounded and takes microseconds.
 * This function reads the WHOLE archive, so it does the reading and the
 * decompression off the main thread.
 */
async function tryReadFallbackArchive(archivePath: string): Promise<BackupArchive | null> {
  if (!looksLikeFallbackArchive(archivePath)) return null;

  let raw: Buffer;
  try {
    raw = await gunzipAsync(await readFile(archivePath));
  } catch {
    return null;
  }

  const text = raw.toString('utf8');
  if (!text.trimStart().startsWith('{')) {
    return null;
  }

  let parsed: BackupArchive;
  try {
    parsed = JSON.parse(text) as BackupArchive;
  } catch {
    return null;
  }

  if (parsed.format !== 'memphis-backup-v1' || !Array.isArray(parsed.entries)) {
    return null;
  }
  return parsed;
}

async function readFallbackArchive(archivePath: string): Promise<BackupArchive> {
  const archive = await tryReadFallbackArchive(archivePath);
  if (!archive) {
    throw new Error('invalid fallback backup archive format');
  }
  return archive;
}

function fallbackArchiveEntriesToPaths(archive: BackupArchive): string[] {
  return archive.entries.map((entry) => (entry.kind === 'dir' ? `${entry.path}/` : entry.path));
}

type ArchiveListOptions = {
  /**
   * The listing seam. It is ASYNCHRONOUS because the real listing is: the
   * runtime calls this from inside its own event loop, and a synchronous
   * listing froze that loop for minutes.
   */
  tarList?: (archivePath: string) => string[] | Promise<string[]>;
};

/**
 * How many COMPRESSED bytes of an archive the fallback probe reads.
 *
 * 64 KiB of gzip decompresses to far more than enough to see whether the
 * stream is a JSON document or a tar header, and it keeps the probe's own
 * cost off the scale of the archive.
 */
const FALLBACK_PEEK_BYTES = 64 * 1024;

function isSafeArchiveEntryPath(entryPath: string): boolean {
  if (!entryPath || isAbsolute(entryPath)) return false;

  let normalized = entryPath.replace(/\\/g, '/');
  while (normalized.startsWith('./')) {
    normalized = normalized.slice(2);
  }
  if (normalized.startsWith('/')) return false;

  const segments = normalized.split('/').filter(Boolean);
  if (segments.length === 0) return false;

  for (const segment of segments) {
    if (segment === '.' || segment === '..') return false;
  }

  return true;
}

function hasUnsafeArchiveEntries(entries: string[]): boolean {
  for (const raw of entries) {
    const entry = raw.endsWith('/') ? raw.slice(0, -1) : raw;
    if (entry === '.' || entry === '') continue;
    if (!isSafeArchiveEntryPath(entry)) return true;
  }
  return false;
}

function safeTargetPath(root: string, entryPath: string): string {
  if (!isSafeArchiveEntryPath(entryPath)) {
    throw new Error(`Unsafe archive entry path: ${entryPath}`);
  }
  return join(root, entryPath);
}

// Apply the same glob patterns as tar to each path, including nested files.
// Excluded directories are skipped before recursion. The policy currently uses
// only * and ? wildcards; dots and other regexp characters remain literal.
const fallbackExcludeMatchers = BACKUP_EXCLUDE_PATTERNS.map((pattern) => {
  const glob = pattern.replace(/^--exclude=/, '');
  return new RegExp(
    '^' +
      glob
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '.*')
        .replace(/\?/g, '.') +
      '$',
  );
});

async function collectFallbackArchiveEntries(
  root: string,
  relativePath = '.',
  excludedPaths: readonly string[] = [],
): Promise<BackupArchiveEntry[]> {
  const currentRoot = relativePath === '.' ? root : join(root, relativePath);
  const entries: BackupArchiveEntry[] = [];

  for (const entry of readdirSync(currentRoot, { withFileTypes: true })) {
    const entryPath = relativePath === '.' ? entry.name : join(relativePath, entry.name);
    const normalizedPath = `./${entryPath.replace(/\\/g, '/')}`;
    if (fallbackExcludeMatchers.some((matcher) => matcher.test(normalizedPath))) continue;
    if (excludedPaths.includes(entryPath.replace(/\\/g, '/'))) continue;
    if (entry.isDirectory()) {
      entries.push({ path: entryPath, kind: 'dir' });
      entries.push(...(await collectFallbackArchiveEntries(root, entryPath, excludedPaths)));
      continue;
    }

    if (entry.isFile()) {
      entries.push({
        path: entryPath,
        kind: 'file',
        contentBase64: (await readFile(join(root, entryPath))).toString('base64'),
      });
    }
  }

  return entries;
}

async function createFallbackArchive(
  memphisRoot: string,
  backupPath: string,
  snapshot: DatabaseSnapshotResult,
): Promise<void> {
  const archive: BackupArchive = {
    format: 'memphis-backup-v1',
    entries: [
      ...(await collectFallbackArchiveEntries(memphisRoot, '.', snapshot.excludedPaths)),
      // The staged name, not the final path: the snapshot on disk is written
      // under STAGED_PREFIX, and the JSON fallback must carry the same
      // placement manifest the tar archive does, or restore would place the
      // database differently depending on which archiver produced it.
      ...snapshot.snapshotted.map(({ stagedPath }) => ({
        path: stagedPath,
        kind: 'file' as const,
        contentBase64: readFileSync(join(snapshot.snapshotDir, stagedPath)).toString('base64'),
      })),
      // Only when there is a snapshot: with no database the archiver produces
      // no manifest, and requiring one here would make a plain data backup
      // fail for no reason.
      ...(snapshot.snapshotted.length > 0
        ? [
            {
              path: DATABASE_PLACEMENT_MANIFEST,
              kind: 'file' as const,
              contentBase64: readFileSync(
                join(snapshot.snapshotDir, DATABASE_PLACEMENT_MANIFEST),
              ).toString('base64'),
            },
          ]
        : []),
    ],
  };
  await writeFile(backupPath, await gzipAsync(Buffer.from(JSON.stringify(archive), 'utf8')));
}

async function ensureArchiveListableOrFallback(
  memphisRoot: string,
  backupPath: string,
  snapshot: DatabaseSnapshotResult,
): Promise<void> {
  try {
    await tarListArchiveContents(backupPath);
  } catch (error) {
    if (!isTarExecutionError(error)) {
      throw error;
    }
    await createFallbackArchive(memphisRoot, backupPath, snapshot);
  }
}

async function extractFallbackArchive(archivePath: string, targetRoot: string): Promise<void> {
  const archive = await readFallbackArchive(archivePath);
  for (const entry of archive.entries) {
    const targetPath = safeTargetPath(targetRoot, entry.path);
    if (entry.kind === 'dir') {
      mkdirSync(targetPath, { recursive: true });
      continue;
    }

    mkdirSync(dirname(targetPath), { recursive: true });
    await writeFile(targetPath, Buffer.from(entry.contentBase64 ?? '', 'base64'), { mode: 0o600 });
  }
}

/**
 * The names inside an archive, whichever archiver produced it.
 *
 * ASYNCHRONOUS because the listing is: the runtime calls this from inside
 * its own event loop, and a synchronous listing froze that loop for minutes
 * on this host.
 */
export async function listArchiveContents(
  archivePath: string,
  options: ArchiveListOptions = {},
): Promise<string[]> {
  const fallback = await tryReadFallbackArchive(archivePath);
  if (fallback) {
    return fallbackArchiveEntriesToPaths(fallback);
  }

  try {
    return await (options.tarList ?? tarListArchiveContents)(archivePath);
  } catch (error) {
    if (isTarExecutionError(error)) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `tar listing failed and archive is not a Memphis fallback archive: ${message}`,
      );
    }

    throw error;
  }
}

function loadManifest(backupRoot: string): Manifest {
  return readManifest(backupRoot);
}

function upsertManifestEntry(backupRoot: string, entry: ManifestEntry): void {
  upsertManifestEntryShared(backupRoot, entry);
}

function getBackupArchives(
  backupRoot: string,
): Array<ManifestEntry & { path: string; checksumPath?: string; stale: boolean }> {
  mkdirSync(backupRoot, { recursive: true });
  const manifest = loadManifest(backupRoot);
  const now = Date.now();

  return (
    readdirSync(backupRoot)
      .filter((file) => file.endsWith(BACKUP_SUFFIX))
      // Reject the `.partial` marker wherever it sits in the name, not only as
      // a trailing suffix. `endsWith(PARTIAL_SUFFIX)` alone was insufficient:
      // an in-flight archive is filtered out only because the marker happens
      // to come last, so any other placement — `<name>.partial.tar.gz` — was
      // listed as a valid backup. The marker is a contract, not a suffix.
      .filter((file) => !file.includes(PARTIAL_SUFFIX))
      .map((file) => {
        const path = join(backupRoot, file);
        const stat = statSync(path);
        const fromManifest = manifest.backups.find((b) => b.file === file);
        const checksumHex = readChecksumHex(path);
        const timestamp = fromManifest?.timestamp ?? stat.mtime.toISOString();
        return {
          file,
          path,
          // The tag the index records, or the one the name carries when the
          // index has no entry for this archive. The name is what the
          // operator chose, and both writers put a timestamp at the end of
          // it — in two different shapes, which is why the rule lives in
          // one place (`scripts/backup-manifest.mjs`) instead of a field
          // count that only fitted the CLI's shape.
          tag: fromManifest?.tag ?? deriveTagFromFileName(file),
          timestamp,
          size: fromManifest?.size ?? stat.size,
          checksum:
            fromManifest?.checksum ?? (checksumHex ? `sha256:${checksumHex}` : 'sha256:missing'),
          fileCount: fromManifest?.fileCount ?? 0,
          checksumPath: existsSync(checksumFilePathFor(path))
            ? checksumFilePathFor(path)
            : undefined,
          stale: now - new Date(timestamp).getTime() > 7 * 24 * 60 * 60 * 1000,
        };
      })
      .sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1))
  );
}

function resolveBackupFile(input: string, backupRoot: string): string {
  if (existsSync(input)) return resolve(input);
  const archives = getBackupArchives(backupRoot);
  const normalized = basename(input).replace(BACKUP_SUFFIX, '');
  const hit = archives.find(
    (a) =>
      a.file === input ||
      a.file.replace(BACKUP_SUFFIX, '') === normalized ||
      a.file.includes(normalized),
  );
  if (!hit) throw new Error(`Backup not found: ${input}`);
  return hit.path;
}

/**
 * Filename used to capture a redacted snapshot of `installRoot/.env` inside
 * the backup archive. Lives at `memphisRoot/.env-redacted` (a path the
 * daemon never reads) only for the duration of the tar run; deleted
 * post-archive. The double dash + name shape is intentional so it
 * never collides with operator-managed files.
 */
const REDACTED_ENV_FILENAME = '.env-redacted';

/**
 * Read `installRoot/.env`, drop secret lines (per `classifyField`), and
 * return the surviving body. Returns null when no `.env` exists or when
 * resolveDotEnvPath cannot find the install root. The pepper, API tokens,
 * and any other field classified as `secret` are stripped so the backup
 * archive never carries them; provider URLs, vault refs, and runtime knobs
 * stay so restore can re-create the operator's config without manual
 * `vault add` re-runs for each provider.
 */
function buildRedactedDotEnv(): string | null {
  const envPath = resolveDotEnvPath();
  if (!existsSync(envPath)) return null;
  const raw = readFileSync(envPath, 'utf8');
  const out: string[] = [
    '# memphis-backup: redacted .env snapshot — secrets stripped via classifyField',
    `# source: ${envPath}`,
    `# captured: ${new Date().toISOString()}`,
    '',
  ];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      out.push(line);
      continue;
    }
    const eq = line.indexOf('=');
    if (eq <= 0) {
      out.push(line);
      continue;
    }
    const key = line.slice(0, eq).trim();
    if (classifyField(key) === 'secret') {
      out.push(`# ${key}=<REDACTED — secret field, restore from external store>`);
      continue;
    }
    out.push(line);
  }
  return out.join('\n');
}

async function createArchive(
  memphisRoot: string,
  backupPath: string,
  snapshot: DatabaseSnapshotResult,
): Promise<void> {
  // Phase C (2026-04-26): write a redacted .env into memphisRoot for the
  // tar run so backup carries provider URLs + vault refs. Always cleaned
  // up afterwards so the file doesn't linger in the data dir between
  // backups.
  const redactedEnvPath = join(memphisRoot, REDACTED_ENV_FILENAME);
  let redactedEnvWritten = false;
  const cleanupRedactedEnv = (): void => {
    if (!redactedEnvWritten) return;
    try {
      unlinkSync(redactedEnvPath);
    } catch {
      /* best-effort cleanup */
    }
  };
  try {
    const redacted = buildRedactedDotEnv();
    if (redacted !== null) {
      writeFileSync(redactedEnvPath, redacted, 'utf8');
      redactedEnvWritten = true;
    }
  } catch {
    // Best-effort: if .env can't be read, just skip the redacted capture.
    // The rest of the backup still completes.
  }

  const tarArgs = [
    // Keep live-file diagnostics available to the exit-1 classifier.
    ...(await tarWarningFlags()),
    // CRITICAL — never include vault or auth secrets. Culture requires
    // secrets to be vault-managed, not file-committed; backing them up
    // violates that and creates a leak path if an archive is
    // exfiltrated. Vault entries can be re-created from operator memory
    // + vault recovery flow (see docs/runbooks/RESTORE-FROM-BACKUP.md).
    //
    // The patterns come from the shared policy file, not a list kept
    // here: the systemd runner archiver is a second active writer and
    // the two lists silently drifted. Excludes are GLOBS — a literal
    // `--exclude=./vault-entries.json` misses `*.bak-diag-*` variants,
    // which is exactly how they reached 6/7 archives on this host.
    ...BACKUP_EXCLUDE_PATTERNS,
    ...databaseSnapshotTarArgs(snapshot, memphisRoot),
  ];

  try {
    await tarCreateArchive(backupPath, tarArgs);
  } catch (error) {
    // Directory churn can produce exit 1 while leaving a readable archive.
    if (isTarFileChangedWarning(error, backupPath)) {
      await ensureArchiveListableOrFallback(memphisRoot, backupPath, snapshot);
      cleanupRedactedEnv();
      return;
    }
    if (!isTarExecutionError(error)) {
      cleanupRedactedEnv();
      throw error;
    }
    await createFallbackArchive(memphisRoot, backupPath, snapshot);
    cleanupRedactedEnv();
    return;
  }

  await ensureArchiveListableOrFallback(memphisRoot, backupPath, snapshot);
  cleanupRedactedEnv();
}

/**
 * Counterpart to `buildRedactedDotEnv`. After tar extracts the archive,
 * if it contains `.env-redacted`, merge those (non-secret) values into
 * `installRoot/.env` — additive: existing keys are preserved (operator may
 * have edited them post-restore), new keys from the archive get appended.
 * Returns the count of keys applied or 0 when there's nothing to do.
 */
function applyRedactedDotEnv(memphisRoot: string): number {
  const stagedPath = join(memphisRoot, REDACTED_ENV_FILENAME);
  if (!existsSync(stagedPath)) return 0;
  const stagedRaw = readFileSync(stagedPath, 'utf8');
  const installEnvPath = resolveDotEnvPath();
  const existingRaw = existsSync(installEnvPath) ? readFileSync(installEnvPath, 'utf8') : '';
  const existingKeys = new Set<string>();
  for (const line of existingRaw.split(/\r?\n/)) {
    const eq = line.indexOf('=');
    if (eq > 0 && !line.trim().startsWith('#')) {
      existingKeys.add(line.slice(0, eq).trim());
    }
  }

  const additions: string[] = [];
  for (const line of stagedRaw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (existingKeys.has(key)) continue;
    additions.push(line);
  }

  if (additions.length === 0) {
    // Nothing new to add — clean up the staged file and return.
    try {
      unlinkSync(stagedPath);
    } catch {
      /* best-effort */
    }
    return 0;
  }

  const merged =
    existingRaw.endsWith('\n') || existingRaw === ''
      ? `${existingRaw}# memphis-backup: restored .env keys (Phase C, ${new Date().toISOString()})\n${additions.join('\n')}\n`
      : `${existingRaw}\n# memphis-backup: restored .env keys (Phase C, ${new Date().toISOString()})\n${additions.join('\n')}\n`;
  writeFileSync(installEnvPath, merged, 'utf8');

  try {
    unlinkSync(stagedPath);
  } catch {
    /* best-effort */
  }
  return additions.length;
}

async function extractArchive(archivePath: string, targetRoot: string): Promise<void> {
  try {
    await tarExtractArchive(archivePath, targetRoot);
  } catch (error) {
    if (!isTarExecutionError(error)) {
      throw describeTarFailure(error);
    }
    await extractFallbackArchive(archivePath, targetRoot);
  }
}

/**
 * Move each staged database to the path its archive recorded.
 *
 * The archiver stores snapshots under `STAGED_PREFIX` because no --exclude
 * pattern can be written that drops the live file without also dropping the
 * staged copy on a tar that applies exclusions to every branch — measured on
 * bsdtar as the archive coming back with no database at all. GNU tar would
 * allow `--transform` to write the final name directly, but there is no
 * substitution syntax that works on both.
 *
 * The archive carries the mapping itself, so an archive restored on another
 * host, or by hand, still lands the database in the right place. A staged
 * database without a recorded destination is an error: restoring it under its
 * staging name would leave a half-restored data directory that passes a
 * directory listing and fails at the first query.
 */
function placeStagedDatabases(stagedRoot: string): void {
  const manifestPath = join(stagedRoot, DATABASE_PLACEMENT_MANIFEST);
  if (!existsSync(manifestPath)) return;
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
    format?: string;
    placements?: Record<string, string | { path: string; role?: string }>;
  };
  for (const [stagedName, placement] of Object.entries(manifest.placements ?? {})) {
    // v1 recorded a bare path; v2 records `{ path, role }`. Both are read
    // here, because archives written before the role existed must still
    // restore.
    const finalPath = typeof placement === 'string' ? placement : placement.path;
    const role = typeof placement === 'string' ? 'data-dir' : (placement.role ?? 'data-dir');
    const stagedFile = join(stagedRoot, stagedName);
    if (!existsSync(stagedFile)) {
      throw new Error(`Archive recorded a database at ${finalPath} but ${stagedName} is missing`);
    }
    if (role === 'runtime') {
      // The runtime database lives outside the data directory — the path
      // `DATABASE_URL` names. Restoring it "into" the data directory would
      // put it where no runtime ever reads it: the restore would report
      // success while the operator's chat history and search index stayed
      // on the old file. Measured on this host: a restore put the database
      // at `<data dir>/memphis.db`, and the runtime kept using the database
      // it already had.
      placeRuntimeDatabase(stagedFile, finalPath);
      continue;
    }
    const destination = safeTargetPath(stagedRoot, finalPath);
    mkdirSync(dirname(destination), { recursive: true });
    renameSync(stagedFile, destination);
  }
  rmSync(manifestPath, { force: true });
}

/**
 * Place the runtime database at the path the runtime actually reads.
 *
 * The archive records the source path it was taken from. That path is
 * absolute, so restoring it verbatim is wrong on a different host — but the
 * operator's `DATABASE_URL` is the authority for where the runtime looks,
 * and it is what decides the destination here.
 *
 * When `DATABASE_URL` is not configured, the recorded path is used: it is
 * still better than dropping the database into the data directory, where it
 * would be invisible.
 */
function placeRuntimeDatabase(stagedFile: string, recordedPath: string): void {
  const destination = resolveRuntimeDatabasePath() ?? resolve(recordedPath);
  mkdirSync(dirname(destination), { recursive: true });
  // Rename across filesystems fails; copy-then-rename does not, and it keeps
  // the destination a complete database at every instant.
  copyFileSync(stagedFile, destination);
  rmSync(stagedFile, { force: true });
  chmodSync(destination, 0o600);
}

/**
 * The path the runtime reads its database from, resolved the same way the
 * runtime resolves it: `DATABASE_URL` with the `file:` prefix stripped.
 */
export function resolveRuntimeDatabasePath(rawEnv: NodeJS.ProcessEnv = process.env): string | null {
  const databaseUrl = rawEnv.DATABASE_URL?.trim();
  if (!databaseUrl || !databaseUrl.startsWith('file:')) return null;
  const raw = databaseUrl.slice('file:'.length).trim();
  if (!raw) return null;
  return resolve(raw);
}

/**
 * A progress bar around work that may take minutes.
 *
 * ASYNCHRONOUS because the work it wraps is: the archive step runs `tar` as
 * a child process, and awaiting it is what keeps the event loop turning.
 * The bar's own timer now ticks DURING the work instead of being frozen by
 * it — which is the visible difference between a runtime that is busy and a
 * runtime that is stuck.
 */
async function withProgress<T>(
  label: string,
  enabled: boolean,
  fn: () => T | Promise<T>,
): Promise<T> {
  if (!enabled) {
    return await fn();
  }

  const bar = new cliProgress.SingleBar(
    {
      format: `${label} [{bar}] {percentage}%`,
      hideCursor: true,
      clearOnComplete: true,
    },
    cliProgress.Presets.shades_classic,
  );

  bar.start(100, 10);
  // Sprint 3.2: track current value locally so we don't reach into the
  // bar's private state via `(bar as unknown as { value: number }).value`.
  // cli-progress mutates internal state on `update()`; tracking it
  // ourselves keeps the type contract honest and survives lib refactors.
  let progress = 10;
  const timer = setInterval(() => {
    progress = Math.min(90, progress + 10);
    bar.update(progress);
  }, 120);

  try {
    const result = await fn();
    bar.update(100);
    return result;
  } finally {
    clearInterval(timer);
    bar.stop();
  }
}

async function verifyChecksum(archivePath: string): Promise<{
  valid: boolean;
  expected?: string;
  actual: string;
}> {
  const expected = readChecksumHex(archivePath);
  const actual = await sha256ForFile(archivePath);
  if (!expected) return { valid: false, expected: undefined, actual };
  return { valid: expected === actual, expected, actual };
}

/**
 * Write `MEMPHIS_VAULT_PEPPER=<pepper>` into the restored `.env` so the vault
 * (encrypted with the source host's pepper) stays decryptable after a
 * cross-host restore. The pepper itself is never logged or returned.
 *
 * Path bug fix (2026-04-26): originally wrote to `${memphisRoot}/.env`
 * (i.e. `~/.memphis/.env`), but the daemon's dotenv loader anchors on
 * `${installRoot}/.env` (the repo dir, e.g. `~/memphis/.env`). The pepper
 * landed in a file the daemon never reads, so vault decryption failed
 * silently after every cross-host restore. Now uses `resolveDotEnvPath`
 * — the same helper `setDotEnvValues` uses everywhere else in Memphis.
 */
function applyRestoredVaultPepper(_memphisRoot: string, pepper: string): void {
  if (pepper.length < 12) {
    throw new Error('--pepper-restore: pepper must be at least 12 characters');
  }
  const envPath = resolveDotEnvPath();
  const existing = existsSync(envPath) ? readFileSync(envPath, 'utf8').split(/\r?\n/) : [];
  const next: string[] = [];
  let replaced = false;
  for (const line of existing) {
    if (line.startsWith('MEMPHIS_VAULT_PEPPER=')) {
      next.push(`MEMPHIS_VAULT_PEPPER=${pepper}`);
      replaced = true;
      continue;
    }
    next.push(line);
  }
  if (!replaced) {
    next.push(`MEMPHIS_VAULT_PEPPER=${pepper}`);
  }
  const serialized = `${next
    .filter((line, index, lines) => !(index === lines.length - 1 && line === ''))
    .join('\n')}\n`;
  writeFileSync(envPath, serialized, 'utf8');
}

async function askRestoreConfirmation(file: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const ans = await rl.question(
      chalk.yellow(
        `⚠ Restore will replace current ~/.memphis data from ${basename(file)}. Continue? (yes/no): `,
      ),
    );
    return ans.trim().toLowerCase() === 'yes';
  } finally {
    rl.close();
  }
}

/**
 * Refuse to publish a backup that silently omits the runtime database.
 *
 * The restore drill verifies whatever databases ARE in the archive, so an
 * archive without the runtime database still reports "drill=pass" — the
 * operator reads a green line while the chat history and the search index
 * are missing. Measured on this host: seven consecutive archives carried
 * no runtime database (the build that produced them predated the snapshot
 * feature) and every one of them reported drill=pass.
 *
 * A failed backup is loud and recoverable. A silently incomplete one is
 * discovered only when the data is needed.
 */
export function assertRuntimeDatabaseSnapshotted(
  snapshot: DatabaseSnapshotResult,
  runtimeDatabasePath: string | undefined,
): void {
  if (!runtimeDatabasePath) return;
  // No database on disk means nothing to lose — a fresh install has none.
  if (!existsSync(runtimeDatabasePath)) return;
  const target = resolve(runtimeDatabasePath);
  const captured = snapshot.snapshotted.some((entry) => resolve(entry.source) === target);
  if (captured) return;
  throw new Error(
    `Backup would omit the runtime database (${target}); refusing to publish an incomplete backup.`,
  );
}

export async function createBackup(options: BackupOptions = {}): Promise<{
  backupPath: string;
  file: string;
  tag: string;
  size: number;
  fileCount: number;
  checksum: string;
  dbSnapshot: DatabaseSnapshotResult;
}> {
  const memphisRoot = getMemphisRoot(options.memphisRoot);
  const backupRoot = getBackupsRoot(options);
  mkdirSync(backupRoot, { recursive: true });

  const file = createUniqueBackupFilename(backupRoot, options.tag);
  const backupPath = join(backupRoot, file);
  const partialPath = `${backupPath}${PARTIAL_SUFFIX}`;
  // Reserve the name before the first await, and protect in-flight data too.
  writeFileSync(partialPath, '', { flag: 'wx', mode: 0o600 });
  const rawEnv = process.env;
  const useRuntimeDatabase = options.memphisRoot === undefined && rawEnv.NODE_ENV !== 'test';
  const databaseUrl = useRuntimeDatabase ? rawEnv.DATABASE_URL : undefined;
  if (databaseUrl && !databaseUrl.startsWith('file:')) {
    throw new Error('Backup requires a file: SQLite DATABASE_URL');
  }
  const runtimeDatabasePath =
    options.databasePath ?? (databaseUrl ? resolve(databaseUrl.slice(5)) : undefined);
  const snapshot = await snapshotDatabases({
    memphisRoot,
    dataDir: options.dataDir ?? (useRuntimeDatabase ? resolve('data') : undefined),
    databasePath: runtimeDatabasePath,
  });
  try {
    if (!snapshot.ok) {
      throw new Error(`Database snapshot failed: ${snapshot.errors.join('; ')}`);
    }
    // Fail BEFORE the archive is written: an incomplete archive must never
    // reach the backups directory, not even as a partial file.
    assertRuntimeDatabaseSnapshotted(snapshot, runtimeDatabasePath);

    await withProgress('Creating backup', options.showProgress ?? true, () =>
      createArchive(memphisRoot, partialPath, snapshot),
    );

    const size = statSync(partialPath).size;
    const contents = await listArchiveContents(partialPath);
    verifyDatabaseSnapshotEntries(snapshot, contents);
    const fileCount = contents.filter((entry) => !entry.endsWith('/')).length;

    // Validate that database files are included in the archive
    const dbFiles = contents.filter((entry) => entry.endsWith('.sqlite') || entry.endsWith('.db'));
    const memphisDbFiles = readdirSync(memphisRoot).filter(
      (f) =>
        (f.endsWith('.sqlite') || f.endsWith('.db')) && statSync(join(memphisRoot, f)).isFile(),
    );
    if (memphisDbFiles.length > 0 && dbFiles.length === 0) {
      console.warn(
        `warning: backup archive is missing database files (${memphisDbFiles.join(', ')}). ` +
          'These files exist in the data directory but were not included in the archive.',
      );
    }

    // Verify DERIVED_PATHS are included in the archive
    const normalizedContents = contents.map((c) => c.replace(/^\.\//, ''));
    const missingDerived: string[] = [];
    for (const derived of DERIVED_PATHS) {
      const derivedExists = derived.endsWith('/')
        ? normalizedContents.some((c) => c.startsWith(derived))
        : normalizedContents.includes(derived) || normalizedContents.includes(`${derived}/`);
      if (!derivedExists) {
        // Check if it exists at all in the source
        const sourcePath = join(memphisRoot, derived);
        if (existsSync(sourcePath)) {
          missingDerived.push(derived);
        }
      }
    }
    if (missingDerived.length > 0) {
      console.warn(
        `warning: backup archive is missing derived paths (${missingDerived.join(', ')}). ` +
          'These files/directories exist in the data directory but were not included.',
      );
    }

    const checksumHex = await sha256ForFile(partialPath);
    const partialSidecar = checksumFilePathFor(partialPath);
    writeFileSync(partialSidecar, `${checksumHex}  ${file}\n`, { flag: 'wx', mode: 0o600 });
    // An archive is operator data (chains, indexes, redacted env). Under the
    // default umask 002 it was published world-readable at 0664 even though the
    // source files are 0600 — the copy was less protected than its sources.
    // Both halves land together: archive and digest.
    chmodSync(partialPath, 0o600);
    renameSync(partialSidecar, checksumFilePathFor(backupPath));
    renameSync(partialPath, backupPath);

    const entry: ManifestEntry = {
      file,
      tag: normalizeTag(options.tag),
      timestamp: new Date().toISOString(),
      size,
      checksum: `sha256:${checksumHex}`,
      fileCount,
    };
    upsertManifestEntry(backupRoot, entry);

    return {
      backupPath,
      file,
      tag: entry.tag,
      size,
      fileCount,
      checksum: entry.checksum,
      dbSnapshot: snapshot,
    };
  } finally {
    cleanupDatabaseSnapshots(snapshot);
  }
}

export async function listBackups(options: BackupOptions = {}): Promise<{
  backups: Array<ManifestEntry & { path: string; stale: boolean; checksumPath?: string }>;
  totalSize: number;
}> {
  const backups = getBackupArchives(getBackupsRoot(options));
  return {
    backups,
    totalSize: backups.reduce((sum, b) => sum + b.size, 0),
  };
}

/**
 * Verify every archive in the backup directory in one pass.
 *
 * Returns ok=false when ANY archive fails integrity checks (mismatched
 * checksum, unsafe entries, listing failure). Used by `memphis backup list
 * --verify` and as the data source for the doctor-v2 backup-integrity row.
 *
 * Phase 1.2 (P2 hotfix): the 2026-05-08 runtime diagnostic surfaced
 * `restore-drill FAILED — backup may not be restorable` without a way for
 * the operator to identify WHICH archive was corrupt. This sweep makes that
 * trivial.
 */
export async function verifyAllBackups(options: BackupOptions = {}): Promise<{
  ok: boolean;
  total: number;
  validCount: number;
  corruptCount: number;
  results: Array<{
    file: string;
    valid: boolean;
    sizeBytes: number;
    fileCount: number;
    checksum: { expected?: string; actual: string };
  }>;
}> {
  const listed = await listBackups(options);
  const results: Awaited<ReturnType<typeof verifyAllBackups>>['results'] = [];
  for (const entry of listed.backups) {
    const verified = await verifyBackup({
      file: entry.path,
      backupRoot: options.backupRoot,
      memphisRoot: options.memphisRoot,
    });
    results.push({
      file: verified.file,
      valid: verified.valid,
      sizeBytes: verified.size,
      fileCount: verified.fileCount,
      checksum: verified.checksum,
    });
  }
  const validCount = results.filter((r) => r.valid).length;
  const corruptCount = results.length - validCount;
  return {
    ok: corruptCount === 0,
    total: results.length,
    validCount,
    corruptCount,
    results,
  };
}

export async function verifyBackup(options: {
  file: string;
  backupRoot?: string;
  memphisRoot?: string;
}): Promise<{
  file: string;
  path: string;
  valid: boolean;
  checksum: { expected?: string; actual: string };
  fileCount: number;
  size: number;
}> {
  const backupRoot = getBackupsRoot(options);
  const backupPath = resolveBackupFile(options.file, backupRoot);
  const size = statSync(backupPath).size;
  const checksum = await verifyChecksum(backupPath);

  let entries: string[];
  try {
    entries = await withProgress('Verifying archive', true, () => listArchiveContents(backupPath));
  } catch {
    return {
      file: basename(backupPath),
      path: backupPath,
      valid: false,
      checksum: { expected: checksum.expected, actual: checksum.actual },
      fileCount: 0,
      size,
    };
  }

  const fileCount = entries.filter((entry) => !entry.endsWith('/')).length;
  const hasUnsafeEntries = hasUnsafeArchiveEntries(entries);
  return {
    file: basename(backupPath),
    path: backupPath,
    valid: checksum.valid && !hasUnsafeEntries,
    checksum: { expected: checksum.expected, actual: checksum.actual },
    fileCount,
    size,
  };
}

export interface BackupDrillResult {
  verification: 'extracted-chain-sqlite';
  chainsChecked: number;
  blocksChecked: number;
  databasesChecked: number;
  credentialRecovery: 'not-verified';
  /**
   * The directories under `chains/` that are NOT chains and were therefore
   * not verified — the rotation's `.archives` container, a quarantine folder,
   * a sidecar writer's dump.
   *
   * The count is in the result rather than only in a log line, because a
   * drill that says nothing about what it skipped is a drill that cannot be
   * told apart from a drill that verified everything.
   */
  foreignDirectories: string[];
  /**
   * How many of the rotation's ARCHIVES were verified — the `.jsonl.gz`
   * files under `chains/.archives/`, which hold the oldest blocks of the
   * chains.
   *
   * The count is in the result rather than only in a log line, because a
   * drill that says nothing about what it skipped is a drill that cannot be
   * told apart from a drill that verified everything.
   */
  archivesChecked: number;
  /** How many blocks those archives hold. */
  archiveBlocksChecked: number;
}

/** Restore into an isolated scratch directory; never invoke live restore hooks. */
export async function drillBackup(backupPath: string): Promise<BackupDrillResult> {
  const scratchRoot = drillScratchRoot(backupPath);
  // A drill that was killed left its scratch behind — 489 MB and 13 002 files,
  // measured on this host. The drill that comes next is the one that can
  // tell a corpse from a live extraction, so it buries the corpses.
  //
  // This happens FIRST, before the archive is even looked at: burying a
  // corpse is not the drill's verdict, and a drill that rejects its archive
  // must still bury the corpses — otherwise the one drill that fails is the
  // one that leaves the mess.
  const buried = reapDeadDrillScratch(scratchRoot);
  if (buried.length > 0) {
    console.warn(
      `warning: removed ${buried.length} abandoned drill scratch director${
        buried.length === 1 ? 'y' : 'ies'
      } (${buried.join(', ')})`,
    );
  }
  const entries = await listArchiveContents(backupPath);
  if (
    !entries.length ||
    hasUnsafeArchiveEntries(entries) ||
    !(await verifyChecksum(backupPath)).valid
  ) {
    throw new Error('Backup drill rejected empty, unsafe or checksum-invalid archive');
  }
  const fallback = await tryReadFallbackArchive(backupPath);
  if (!fallback) {
    // Refuse links and special files before extraction, including links whose
    // target could escape the scratch directory. GNU tar lists type first.
    const listing = await tarListArchiveVerbose(backupPath);
    if (listing.split('\n').some((line) => line && !['-', 'd'].includes(line[0]))) {
      throw new Error('Backup drill refuses links and special files');
    }
  }
  // The scratch's name carries the pid of the process that OWNS it, so that
  // the next drill can ask the kernel whether this owner is still there. A
  // drill that is killed leaves its scratch behind, and only a name that
  // names its owner can be told apart from a scratch in flight.
  const root = mkdtempSync(join(scratchRoot, `${DRILL_SCRATCH_PREFIX}${process.pid}-`));
  try {
    if (fallback) await extractFallbackArchive(backupPath, root);
    else await extractArchive(backupPath, root);
    const { verifyChainIntegrity } = await import('../../storage/chain-adapter.js');
    const { verifyRotationArchives } = await import('../../storage/chain-archive-verify.js');
    const { ARCHIVES_DIR_NAME } = await import('../../storage/chain-archive-format.js');
    const result: BackupDrillResult = {
      verification: 'extracted-chain-sqlite',
      chainsChecked: 0,
      blocksChecked: 0,
      databasesChecked: 0,
      credentialRecovery: 'not-verified',
      foreignDirectories: [],
      archivesChecked: 0,
      archiveBlocksChecked: 0,
    };
    const chains = join(root, 'chains');
    if (existsSync(chains)) {
      for (const entry of readdirSync(chains, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        // The rotation's `.archives` container is not a chain — it holds the
        // rotation's `.jsonl.gz` files, not blocks — but it IS the chains'
        // history: the rotation moved the oldest blocks aside, and they
        // travel inside every backup.
        //
        // So the drill does not skip it and does not call it foreign
        // either: it VERIFIES what is inside. The rule is the archive
        // verifier's (`chain-archive-verify.ts`) — the same one the restore
        // uses, because it is the same question.
        //
        // Until now the drill skipped the container and said so in its
        // result (`foreignDirectories: [".archives"]`), and a backup could
        // carry a corrupt archived history and still drill clean. The error
        // ledger named that as the ONE residual of the backup round.
        if (entry.name === ARCHIVES_DIR_NAME) {
          const archives = await verifyRotationArchives(join(chains, entry.name));
          result.archivesChecked += archives.archivesChecked;
          result.archiveBlocksChecked += archives.blocksChecked;
          continue;
        }
        // The OWNER decides what a directory under `chains/` is — the same
        // question the runtime, the audit and the verifier ask, with the
        // same answer, because they all ask it (the rule is owned in Rust,
        // `crates/memphis-paths/src/chain_names.rs`, and mirrored here).
        //
        // The drill used to treat EVERY directory as a chain, and the
        // rotation's `.archives` container is not one: it holds the
        // rotation's `.jsonl.gz` files, not blocks. So the drill aborted
        // with "invalid chain name" on archives that were complete, and the
        // scheduled backup reported "restore-drill FAILED — backup may not
        // be restorable" for three consecutive days on this host. The
        // artefact of cases already said it (`tests/fixtures/
        // chain-name-contract.json`: `.archives` is `foreign`); the drill
        // never asked.
        const kind = classifyChainDirectory(entry.name);
        if (kind === 'foreign') {
          result.foreignDirectories.push(entry.name);
          continue;
        }
        const checked = await verifyChainIntegrity(entry.name, { MEMPHIS_DATA_DIR: root });
        result.chainsChecked += checked.chainsChecked;
        result.blocksChecked += checked.blockCount;
      }
    }
    const { default: Database } = await import('better-sqlite3');
    const inspect = (directory: string): void => {
      for (const name of readdirSync(directory)) {
        const path = join(directory, name);
        const stat = lstatSync(path);
        if (stat.isSymbolicLink()) throw new Error('Backup drill refuses symbolic links');
        if (stat.isDirectory()) inspect(path);
        else if (/\.(sqlite|db)$/.test(name)) {
          const database = new Database(path, { readonly: true, fileMustExist: true });
          try {
            const rows = database.pragma('integrity_check') as Array<{ integrity_check: string }>;
            if (rows.length !== 1 || rows[0].integrity_check !== 'ok') {
              throw new Error('Backup drill SQLite integrity failed');
            }
            result.databasesChecked += 1;
          } finally {
            database.close();
          }
        }
      }
    };
    inspect(root);
    return result;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

export async function restoreBackup(options: RestoreOptions): Promise<{
  ok: true;
  restoredAt: string;
  backupPath: string;
  restoredSize: number;
  fileCount: number;
  preRestoreBackup: string;
}> {
  const memphisRoot = getMemphisRoot(options.memphisRoot);
  const backupRoot = getBackupsRoot(options);
  mkdirSync(memphisRoot, { recursive: true });
  mkdirSync(backupRoot, { recursive: true });

  // Codex P1 fix (PR #86): validate --pepper-restore BEFORE any
  // destructive disk operation. Previously the length check happened
  // inside applyRestoredVaultPepper, which only ran after the pre-restore
  // backup, archive extract, and atomic swap had already mutated
  // ~/.memphis. Operators / automation calling restore with a too-short
  // pepper saw a thrown error but the data dir was already replaced —
  // a side-effect-on-failure path that breaks the "thrown restore = no
  // change" expectation.
  if (options.pepperRestore !== undefined && options.pepperRestore.length < 12) {
    throw new Error('--pepper-restore: pepper must be at least 12 characters');
  }

  const backupPath = resolveBackupFile(options.file, backupRoot);
  const check = await verifyBackup({
    file: backupPath,
    backupRoot,
    memphisRoot: options.memphisRoot,
  });
  if (!check.valid) {
    throw new Error(`Checksum verification failed for ${basename(backupPath)}`);
  }

  // The swap below uses renameSync in both directions. A tmpfs /tmp and an
  // on-disk data root make every rename fail with EXDEV. Check before taking
  // a pre-restore backup or moving any live data; otherwise a later failure
  // can leave a partially moved tree and extracted data in temporary storage.
  if (statSync(tmpdir()).dev !== statSync(memphisRoot).dev) {
    throw new Error(
      'Restore refused before changing data: TMPDIR and the Memphis data directory are on different filesystems. Use a private TMPDIR on the data filesystem and follow the restore runbook.',
    );
  }

  const preRestoreBackup = await createBackup({
    backupRoot,
    memphisRoot: options.memphisRoot,
    tag: 'pre-restore',
    showProgress: options.showProgress,
  });

  const extractRoot = mkdtempSync(join(tmpdir(), 'memphis-restore-'));
  const stagedRoot = join(extractRoot, 'data');
  mkdirSync(stagedRoot, { recursive: true });

  await withProgress('Extracting backup', options.showProgress ?? true, () =>
    extractArchive(backupPath, stagedRoot),
  );

  const tempCurrent = mkdtempSync(join(tmpdir(), 'memphis-current-'));
  const memphisItems = readdirSync(memphisRoot);
  for (const item of memphisItems) {
    if (item === 'backups') continue;
    renameSync(join(memphisRoot, item), join(tempCurrent, item));
  }

  try {
    placeStagedDatabases(stagedRoot);
    for (const item of readdirSync(stagedRoot)) {
      renameSync(join(stagedRoot, item), join(memphisRoot, item));
    }
  } catch (error) {
    for (const item of readdirSync(memphisRoot)) {
      if (item === 'backups') continue;
      rmSync(join(memphisRoot, item), { recursive: true, force: true });
    }
    for (const item of readdirSync(tempCurrent)) {
      renameSync(join(tempCurrent, item), join(memphisRoot, item));
    }
    rmSync(extractRoot, { recursive: true, force: true });
    rmSync(tempCurrent, { recursive: true, force: true });
    throw error;
  }

  rmSync(tempCurrent, { recursive: true, force: true });
  rmSync(extractRoot, { recursive: true, force: true });

  if (options.pepperRestore) {
    applyRestoredVaultPepper(memphisRoot, options.pepperRestore);
  }

  // Phase C: if the archive carried a redacted .env snapshot (provider URLs,
  // vault refs, non-secret runtime knobs), merge those keys into
  // installRoot/.env. Existing keys are preserved — operator may have
  // edited .env post-restore; we only add missing ones.
  applyRedactedDotEnv(memphisRoot);

  const post = await verifyBackup({
    file: backupPath,
    backupRoot,
    memphisRoot: options.memphisRoot,
  });
  if (!post.valid) {
    throw new Error('Post-restore verification failed');
  }

  const restoredAt = new Date().toISOString();
  appendFileSync(
    join(backupRoot, 'restore.log'),
    `${JSON.stringify({ restoredAt, backupPath })}\n`,
    'utf8',
  );

  return {
    ok: true,
    restoredAt,
    backupPath,
    restoredSize: post.size,
    fileCount: post.fileCount,
    preRestoreBackup: preRestoreBackup.file,
  };
}

export async function cleanBackups(
  options: BackupOptions & { keep?: number; dryRun?: boolean } = {},
): Promise<{
  removed: string[];
  wouldRemove: string[];
  kept: number;
}> {
  const backupRoot = getBackupsRoot(options);
  const keep = Math.max(0, options.keep ?? 7);
  // When a tag is supplied, retention is scoped to that backup class.
  // This prevents an automated scheduled cleaner from deleting manual,
  // release, or pre-repair recovery points.
  const archives = getBackupArchives(backupRoot);
  const candidates = options.tag
    ? archives.filter((archive) => archive.tag === normalizeTag(options.tag))
    : archives;
  const toRemove = candidates.slice(keep);

  if (options.dryRun) {
    return { removed: [], wouldRemove: toRemove.map((a) => a.file), kept: keep };
  }

  for (const item of toRemove) {
    unlinkSync(item.path);
    if (item.checksumPath && existsSync(item.checksumPath)) {
      unlinkSync(item.checksumPath);
    }
  }

  // The index is reconciled with the disk at the same time: the archives
  // that were removed leave it, and any archive that was never recorded
  // enters it. The archives on disk are the truth; the index follows.
  removeManifestEntries(
    backupRoot,
    toRemove.map((archive) => archive.file),
  );

  return {
    removed: toRemove.map((a) => a.file),
    wouldRemove: toRemove.map((a) => a.file),
    kept: keep,
  };
}

export async function handleBackupCommand(context: CliContext): Promise<boolean> {
  const { args } = context;
  if (args.command !== 'backup') return false;

  const explicitSubcommand = args.subcommand?.toLowerCase();
  const subcommand =
    explicitSubcommand &&
    ['create', 'list', 'verify', 'restore', 'clean'].includes(explicitSubcommand)
      ? explicitSubcommand
      : args.list
        ? 'list'
        : args.clean
          ? 'clean'
          : args.restore
            ? 'restore'
            : explicitSubcommand
              ? explicitSubcommand
              : 'create';

  if (subcommand === 'create') {
    const created = await createBackup({ tag: args.tag });
    print(
      {
        ok: true,
        mode: 'create',
        id: created.file,
        ...created,
        summary: `Created ${created.file} (${humanSize(created.size)}, files: ${created.fileCount})`,
      },
      args.json,
    );
    return true;
  }

  if (subcommand === 'list') {
    const listed = await listBackups();
    const enriched = listed.backups.map((b) => ({
      ...b,
      sizeHuman: humanSize(b.size),
      staleLabel: b.stale ? chalk.yellow('STALE') : 'fresh',
    }));
    if (args.verify) {
      // P2 hotfix: integrity sweep across every archive. Exit non-zero when
      // any archive is corrupt so cron-based backup-watch scripts can alert.
      const sweep = await verifyAllBackups();
      const merged = enriched.map((b) => {
        const v = sweep.results.find((r) => r.file === b.file);
        return { ...b, integrity: v?.valid ?? null };
      });
      print(
        {
          ok: sweep.ok,
          mode: 'list-verify',
          backups: merged,
          summary: {
            total: sweep.total,
            valid: sweep.validCount,
            corrupt: sweep.corruptCount,
          },
          totalSize: listed.totalSize,
          totalSizeHuman: humanSize(listed.totalSize),
        },
        args.json,
      );
      if (!sweep.ok) {
        // Surface the corruption to shell scripts.
        process.exitCode = 1;
      }
      return true;
    }
    print(
      {
        ok: true,
        mode: 'list',
        backups: enriched,
        totalSize: listed.totalSize,
        totalSizeHuman: humanSize(listed.totalSize),
      },
      args.json,
    );
    return true;
  }

  if (subcommand === 'verify') {
    const file = args.target ?? args.id;
    if (!file) throw new Error('Usage: memphis backup verify <file>');
    const verified = await verifyBackup({ file });
    print(
      { ok: verified.valid, mode: 'verify', ...verified, sizeHuman: humanSize(verified.size) },
      args.json,
    );
    // Exit code is the contract shell callers gate on. `scripts/backup-to-usb.sh`
    // does `if ! memphis backup verify "$latest"; then refuse to copy`. Before
    // this, verify printed `valid: false` and still exited 0, so the USB copy
    // gate could never fire and a genuinely corrupt archive would have been
    // copied anyway (observed 2026-10-08: rc=0 on a 100 KB /dev/urandom file).
    // `memphis backup list --verify` already set exitCode 1 the same way.
    if (!verified.valid) {
      process.exitCode = 1;
    }
    return true;
  }

  if (subcommand === 'restore') {
    const file = args.target ?? args.restore;
    if (!file) {
      throw new Error('Usage: memphis backup restore <file> [--yes] [--pepper-restore <old>]');
    }
    // S5-1: gate restore — overwrites the entire data dir from a
    // possibly attacker-supplied archive. --yes is operator intent
    // confirmation; passphrase is operator identity confirmation.
    if (!(await requireOperatorAuth())) {
      throw new Error('Operator authentication failed.');
    }
    const confirmed = args.yes ? true : await askRestoreConfirmation(file);
    if (!confirmed) {
      print({ ok: false, mode: 'restore', aborted: true }, args.json);
      return true;
    }
    const restored = await restoreBackup({
      file,
      confirm: true,
      pepperRestore: args.pepperRestore,
    });
    print({ ...restored, mode: 'restore' }, args.json);
    return true;
  }

  if (subcommand === 'clean') {
    // S5-1: gate clean — deletes archives that are the only path back
    // from a botched restore.
    if (!(await requireOperatorAuth())) {
      throw new Error('Operator authentication failed.');
    }
    // The tag scopes the retention to one class of archive. It used to be
    // dropped here: the parser read `--tag`, `create` forwarded it, and
    // `clean` did not — so `memphis backup clean --keep 7 --tag scheduled`
    // cleaned EVERY class. Measured 2026-11-22 on this host with the real
    // backup directory: that command would have removed all 20 manual
    // pre-repair recovery points and none of the scheduled archives — the
    // exact inversion of the operator's intent, and the archives it would
    // have destroyed are the only path back from a botched restore.
    const cleaned = await cleanBackups({
      keep: args.keep,
      tag: args.tag,
      dryRun: args.dryRun,
    });
    print({ ok: true, mode: 'clean', ...cleaned }, args.json);
    return true;
  }

  throw new Error(`Unknown backup subcommand: ${subcommand}`);
}
