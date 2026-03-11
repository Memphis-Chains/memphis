import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import readline from 'node:readline/promises';
import { gunzipSync, gzipSync } from 'node:zlib';

import chalk from 'chalk';
import cliProgress from 'cli-progress';

import { getDataDir } from '../../../config/paths.js';
import type { CliContext } from '../context.js';
import { print } from '../utils/render.js';

export type BackupOptions = {
  backupRoot?: string;
  memphisRoot?: string;
  tag?: string;
};

export type RestoreOptions = {
  file: string;
  backupRoot?: string;
  memphisRoot?: string;
  confirm?: boolean;
};

export type ManifestEntry = {
  file: string;
  tag: string;
  timestamp: string;
  size: number;
  checksum: string;
  fileCount: number;
};

type Manifest = {
  backups: ManifestEntry[];
  retentionPolicy: {
    keepDaily: number;
    keepWeekly: number;
    keepMonthly: number;
  };
};

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
const CHECKSUM_SUFFIX = '.sha256';
const DEFAULT_TAG = 'backup';
const DEFAULT_MANIFEST: Manifest = {
  backups: [],
  retentionPolicy: {
    keepDaily: 7,
    keepWeekly: 4,
    keepMonthly: 12,
  },
};

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

  while (existsSync(join(backupRoot, candidate))) {
    candidate = `${base}-${suffix}${BACKUP_SUFFIX}`;
    suffix += 1;
  }

  return candidate;
}

function sha256ForFile(path: string): string {
  const data = readFileSync(path);
  return createHash('sha256').update(data).digest('hex');
}

function checksumFilePathFor(archivePath: string): string {
  return `${archivePath}${CHECKSUM_SUFFIX}`;
}

function writeChecksumFile(archivePath: string, checksumHex: string): string {
  const outPath = checksumFilePathFor(archivePath);
  const line = `${checksumHex}  ${basename(archivePath)}\n`;
  writeFileSync(outPath, line, 'utf8');
  return outPath;
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

function isTarExecutionError(error: unknown): boolean {
  return (
    error instanceof Error &&
    /(spawnSync tar EPERM|spawnSync tar EACCES|tar is required)/.test(error.message)
  );
}

function readFallbackArchive(archivePath: string): BackupArchive {
  const raw = gunzipSync(readFileSync(archivePath));
  return JSON.parse(raw.toString('utf8')) as BackupArchive;
}

function collectFallbackArchiveEntries(root: string, relativePath = '.'): BackupArchiveEntry[] {
  const currentRoot = relativePath === '.' ? root : join(root, relativePath);
  const entries: BackupArchiveEntry[] = [];

  for (const entry of readdirSync(currentRoot, { withFileTypes: true })) {
    if (relativePath === '.') {
      if (entry.name === 'backups' || entry.name === 'cache' || entry.name === 'logs') {
        continue;
      }
      if (entry.name.endsWith('.lock')) {
        continue;
      }
    }

    const entryPath = relativePath === '.' ? entry.name : join(relativePath, entry.name);
    if (entry.isDirectory()) {
      entries.push({ path: entryPath, kind: 'dir' });
      entries.push(...collectFallbackArchiveEntries(root, entryPath));
      continue;
    }

    if (entry.isFile()) {
      entries.push({
        path: entryPath,
        kind: 'file',
        contentBase64: readFileSync(join(root, entryPath)).toString('base64'),
      });
    }
  }

  return entries;
}

function createFallbackArchive(memphisRoot: string, backupPath: string): void {
  const archive: BackupArchive = {
    format: 'memphis-backup-v1',
    entries: collectFallbackArchiveEntries(memphisRoot),
  };
  writeFileSync(backupPath, gzipSync(Buffer.from(JSON.stringify(archive), 'utf8')));
}

function extractFallbackArchive(archivePath: string, targetRoot: string): void {
  const archive = readFallbackArchive(archivePath);
  for (const entry of archive.entries) {
    const targetPath = join(targetRoot, entry.path);
    if (entry.kind === 'dir') {
      mkdirSync(targetPath, { recursive: true });
      continue;
    }

    mkdirSync(dirname(targetPath), { recursive: true });
    writeFileSync(targetPath, Buffer.from(entry.contentBase64 ?? '', 'base64'));
  }
}

function listArchiveContents(archivePath: string): string[] {
  try {
    const out = execFileSync('tar', ['-tzf', archivePath], { encoding: 'utf8' });
    return out
      .split('\n')
      .map((v) => v.trim())
      .filter(Boolean);
  } catch (error) {
    if (!isTarExecutionError(error)) {
      throw error;
    }

    return readFallbackArchive(archivePath).entries.map((entry) =>
      entry.kind === 'dir' ? `${entry.path}/` : entry.path,
    );
  }
}

function loadManifest(backupRoot: string): Manifest {
  const manifestPath = join(backupRoot, 'manifest.json');
  if (!existsSync(manifestPath)) return { ...DEFAULT_MANIFEST, backups: [] };
  try {
    const parsed = JSON.parse(readFileSync(manifestPath, 'utf8')) as Manifest;
    return {
      retentionPolicy: parsed.retentionPolicy ?? DEFAULT_MANIFEST.retentionPolicy,
      backups: Array.isArray(parsed.backups) ? parsed.backups : [],
    };
  } catch {
    return { ...DEFAULT_MANIFEST, backups: [] };
  }
}

function saveManifest(backupRoot: string, manifest: Manifest): void {
  const manifestPath = join(backupRoot, 'manifest.json');
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
}

function upsertManifestEntry(backupRoot: string, entry: ManifestEntry): void {
  const manifest = loadManifest(backupRoot);
  manifest.backups = [entry, ...manifest.backups.filter((b) => b.file !== entry.file)].sort(
    (a, b) => (a.timestamp < b.timestamp ? 1 : -1),
  );
  saveManifest(backupRoot, manifest);
}

function getBackupArchives(
  backupRoot: string,
): Array<ManifestEntry & { path: string; checksumPath?: string; stale: boolean }> {
  mkdirSync(backupRoot, { recursive: true });
  const manifest = loadManifest(backupRoot);
  const now = Date.now();

  return readdirSync(backupRoot)
    .filter((file) => file.endsWith(BACKUP_SUFFIX))
    .map((file) => {
      const path = join(backupRoot, file);
      const stat = statSync(path);
      const fromManifest = manifest.backups.find((b) => b.file === file);
      const checksumHex = readChecksumHex(path);
      const timestamp = fromManifest?.timestamp ?? stat.mtime.toISOString();
      return {
        file,
        path,
        tag:
          fromManifest?.tag ??
          (file.replace(BACKUP_SUFFIX, '').split('-').slice(0, -5).join('-') || DEFAULT_TAG),
        timestamp,
        size: fromManifest?.size ?? stat.size,
        checksum:
          fromManifest?.checksum ?? (checksumHex ? `sha256:${checksumHex}` : 'sha256:missing'),
        fileCount: fromManifest?.fileCount ?? 0,
        checksumPath: existsSync(checksumFilePathFor(path)) ? checksumFilePathFor(path) : undefined,
        stale: now - new Date(timestamp).getTime() > 7 * 24 * 60 * 60 * 1000,
      };
    })
    .sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1));
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

function createArchive(memphisRoot: string, backupPath: string): void {
  try {
    execFileSync('tar', [
      '-czf',
      backupPath,
      '--exclude=./backups',
      '--exclude=./cache',
      '--exclude=./logs',
      '--exclude=*.lock',
      '-C',
      memphisRoot,
      '.',
    ]);
  } catch (error) {
    if (!isTarExecutionError(error)) {
      throw error;
    }
    createFallbackArchive(memphisRoot, backupPath);
  }
}

function extractArchive(archivePath: string, targetRoot: string): void {
  try {
    execFileSync('tar', ['-xzf', archivePath, '-C', targetRoot]);
  } catch (error) {
    if (!isTarExecutionError(error)) {
      throw error;
    }
    extractFallbackArchive(archivePath, targetRoot);
  }
}

function withProgress<T>(label: string, fn: () => T): T {
  const bar = new cliProgress.SingleBar(
    {
      format: `${label} [{bar}] {percentage}%`,
      hideCursor: true,
      clearOnComplete: true,
    },
    cliProgress.Presets.shades_classic,
  );

  bar.start(100, 10);
  const timer = setInterval(() => {
    const next = Math.min(90, (bar as unknown as { value: number }).value + 10);
    bar.update(next);
  }, 120);

  try {
    const result = fn();
    bar.update(100);
    return result;
  } finally {
    clearInterval(timer);
    bar.stop();
  }
}

function verifyChecksum(archivePath: string): {
  valid: boolean;
  expected?: string;
  actual: string;
} {
  const expected = readChecksumHex(archivePath);
  const actual = sha256ForFile(archivePath);
  if (!expected) return { valid: false, expected: undefined, actual };
  return { valid: expected === actual, expected, actual };
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

export async function createBackup(options: BackupOptions = {}): Promise<{
  backupPath: string;
  file: string;
  tag: string;
  size: number;
  fileCount: number;
  checksum: string;
}> {
  const memphisRoot = getMemphisRoot(options.memphisRoot);
  const backupRoot = getBackupsRoot(options);
  mkdirSync(backupRoot, { recursive: true });

  const file = createUniqueBackupFilename(backupRoot, options.tag);
  const backupPath = join(backupRoot, file);

  withProgress('Creating backup', () => {
    createArchive(memphisRoot, backupPath);
  });

  const size = statSync(backupPath).size;
  const contents = listArchiveContents(backupPath);
  const fileCount = contents.filter((entry) => !entry.endsWith('/')).length;
  const checksumHex = sha256ForFile(backupPath);
  writeChecksumFile(backupPath, checksumHex);

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
  };
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
  const checksum = verifyChecksum(backupPath);

  let entries: string[];
  try {
    entries = withProgress('Verifying archive', () => listArchiveContents(backupPath));
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
  return {
    file: basename(backupPath),
    path: backupPath,
    valid: checksum.valid,
    checksum: { expected: checksum.expected, actual: checksum.actual },
    fileCount,
    size,
  };
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

  const backupPath = resolveBackupFile(options.file, backupRoot);
  const check = await verifyBackup({
    file: backupPath,
    backupRoot,
    memphisRoot: options.memphisRoot,
  });
  if (!check.valid) {
    throw new Error(`Checksum verification failed for ${basename(backupPath)}`);
  }

  const preRestoreBackup = await createBackup({
    backupRoot,
    memphisRoot: options.memphisRoot,
    tag: 'pre-restore',
  });

  const extractRoot = mkdtempSync(join(tmpdir(), 'memphis-restore-'));
  const stagedRoot = join(extractRoot, 'data');
  mkdirSync(stagedRoot, { recursive: true });

  withProgress('Extracting backup', () => {
    extractArchive(backupPath, stagedRoot);
  });

  const tempCurrent = mkdtempSync(join(tmpdir(), 'memphis-current-'));
  const memphisItems = readdirSync(memphisRoot);
  for (const item of memphisItems) {
    if (item === 'backups') continue;
    renameSync(join(memphisRoot, item), join(tempCurrent, item));
  }

  try {
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
  const archives = getBackupArchives(backupRoot);
  const toRemove = archives.slice(keep);

  if (options.dryRun) {
    return { removed: [], wouldRemove: toRemove.map((a) => a.file), kept: keep };
  }

  for (const item of toRemove) {
    unlinkSync(item.path);
    if (item.checksumPath && existsSync(item.checksumPath)) {
      unlinkSync(item.checksumPath);
    }
  }

  const manifest = loadManifest(backupRoot);
  manifest.backups = manifest.backups.filter(
    (entry) => !toRemove.some((rm) => rm.file === entry.file),
  );
  saveManifest(backupRoot, manifest);

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
    return true;
  }

  if (subcommand === 'restore') {
    const file = args.target ?? args.restore;
    if (!file) throw new Error('Usage: memphis backup restore <file> [--yes]');
    const confirmed = args.yes ? true : await askRestoreConfirmation(file);
    if (!confirmed) {
      print({ ok: false, mode: 'restore', aborted: true }, args.json);
      return true;
    }
    const restored = await restoreBackup({ file, confirm: true });
    print({ ...restored, mode: 'restore' }, args.json);
    return true;
  }

  if (subcommand === 'clean') {
    const cleaned = await cleanBackups({ keep: args.keep, dryRun: args.dryRun });
    print({ ok: true, mode: 'clean', ...cleaned }, args.json);
    return true;
  }

  throw new Error(`Unknown backup subcommand: ${subcommand}`);
}
