import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';

import type { CliContext } from '../context.js';
import { print } from '../utils/render.js';
import { getDataDir } from '../../../config/paths.js';

export type BackupOptions = {
  backupRoot?: string;
  memphisRoot?: string;
};

export type RestoreOptions = {
  id: string;
  backupRoot?: string;
  memphisRoot?: string;
  confirm?: boolean;
};

const BACKUP_PREFIX = 'backup-';
const BACKUP_SUFFIX = '.tar.gz';
const BACKUP_FOLDERS = ['chains', 'embeddings', 'vault', 'config'] as const;

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

function createUniqueBackupId(backupRoot: string): string {
  const base = `${BACKUP_PREFIX}${nowStamp()}`;
  let candidate = base;
  let suffix = 1;

  while (existsSync(join(backupRoot, `${candidate}${BACKUP_SUFFIX}`))) {
    candidate = `${base}-${suffix}`;
    suffix += 1;
  }

  return candidate;
}

function getVersion(): string {
  try {
    const pkgPath = resolve(process.cwd(), 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version?: string };
    return pkg.version ?? '0.1.0';
  } catch {
    return '0.1.0';
  }
}

function safeSize(path: string): number {
  if (!existsSync(path)) return 0;
  const stat = statSync(path);
  if (stat.isFile()) return stat.size;
  if (!stat.isDirectory()) return 0;

  let total = 0;
  for (const entry of readdirSync(path)) {
    total += safeSize(join(path, entry));
  }
  return total;
}

function getBackupArchives(backupRoot: string): Array<{ id: string; filename: string; path: string; size: number; createdAt: string }> {
  mkdirSync(backupRoot, { recursive: true });
  return readdirSync(backupRoot)
    .filter((file) => file.startsWith(BACKUP_PREFIX) && file.endsWith(BACKUP_SUFFIX))
    .map((filename) => {
      const fullPath = join(backupRoot, filename);
      const stat = statSync(fullPath);
      return {
        id: filename.slice(0, -BACKUP_SUFFIX.length),
        filename,
        path: fullPath,
        size: stat.size,
        createdAt: stat.mtime.toISOString(),
      };
    })
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

export async function createBackup(options: BackupOptions = {}): Promise<{ backupPath: string; id: string; size: number }> {
  const memphisRoot = getMemphisRoot(options.memphisRoot);
  const backupRoot = getBackupsRoot(options);
  mkdirSync(backupRoot, { recursive: true });

  const id = createUniqueBackupId(backupRoot);
  const archivePath = join(backupRoot, `${id}${BACKUP_SUFFIX}`);

  const stageRoot = mkdtempSync(join(tmpdir(), 'memphis-backup-stage-'));
  const stageDataRoot = join(stageRoot, 'data');
  mkdirSync(stageDataRoot, { recursive: true });

  for (const folder of BACKUP_FOLDERS) {
    const source = join(memphisRoot, folder);
    if (existsSync(source)) {
      cpSync(source, join(stageDataRoot, folder), { recursive: true });
    }
  }

  const metadata = {
    id,
    timestamp: new Date().toISOString(),
    version: getVersion(),
    size: safeSize(stageDataRoot),
    included: BACKUP_FOLDERS,
  };
  writeFileSync(join(stageRoot, 'backup.json'), JSON.stringify(metadata, null, 2), 'utf8');

  execFileSync('tar', ['-czf', archivePath, '-C', stageRoot, '.']);
  const size = statSync(archivePath).size;

  rmSync(stageRoot, { recursive: true, force: true });
  return { backupPath: archivePath, id, size };
}

export async function listBackups(options: BackupOptions = {}): Promise<Array<{ id: string; filename: string; path: string; size: number; createdAt: string }>> {
  return getBackupArchives(getBackupsRoot(options));
}

function resolveBackupById(id: string, backupRoot: string): string {
  if (existsSync(id)) return resolve(id);
  const all = getBackupArchives(backupRoot);
  const normalized = basename(id).replace(BACKUP_SUFFIX, '');
  const hit = all.find((item) => item.id === normalized || item.filename === id || item.id.includes(normalized));
  if (!hit) throw new Error(`Backup not found: ${id}`);
  return hit.path;
}

export async function restoreBackup(options: RestoreOptions): Promise<{ ok: true; backupPath: string; restoredAt: string }> {
  const memphisRoot = getMemphisRoot(options.memphisRoot);
  const backupRoot = getBackupsRoot(options);
  const backupPath = resolveBackupById(options.id, backupRoot);

  if (!options.confirm) {
    throw new Error('Restore requires explicit confirmation: use --yes');
  }

  execFileSync('tar', ['-tzf', backupPath], { stdio: 'pipe' });

  const extractRoot = mkdtempSync(join(tmpdir(), 'memphis-restore-'));
  execFileSync('tar', ['-xzf', backupPath, '-C', extractRoot]);

  const metadataPath = join(extractRoot, 'backup.json');
  const dataRoot = join(extractRoot, 'data');
  if (!existsSync(metadataPath) || !existsSync(dataRoot)) {
    rmSync(extractRoot, { recursive: true, force: true });
    throw new Error('Backup validation failed: missing backup.json or data payload');
  }

  for (const folder of BACKUP_FOLDERS) {
    const target = join(memphisRoot, folder);
    const extracted = join(dataRoot, folder);
    rmSync(target, { recursive: true, force: true });
    if (existsSync(extracted)) {
      cpSync(extracted, target, { recursive: true });
    }
  }

  const restoredAt = new Date().toISOString();
  const restoreLog = join(backupRoot, 'restore.log');
  appendFileSync(restoreLog, `${JSON.stringify({ restoredAt, backupPath })}\n`, 'utf8');

  rmSync(extractRoot, { recursive: true, force: true });
  return { ok: true, backupPath, restoredAt };
}

export async function cleanBackups(options: BackupOptions & { keep?: number } = {}): Promise<{ removed: string[]; kept: number }> {
  const backupRoot = getBackupsRoot(options);
  const keep = Math.max(0, options.keep ?? 5);
  const archives = getBackupArchives(backupRoot);
  const toRemove = archives.slice(keep);

  for (const item of toRemove) {
    unlinkSync(item.path);
  }

  return { removed: toRemove.map((item) => item.filename), kept: keep };
}

export async function handleBackupCommand(context: CliContext): Promise<boolean> {
  const { args } = context;
  if (args.command !== 'backup') return false;

  if (args.restore) {
    const restored = await restoreBackup({ id: args.restore, confirm: args.yes });
    print({ mode: 'restore', ...restored }, args.json);
    return true;
  }

  if (args.list) {
    const backups = await listBackups();
    print({ ok: true, mode: 'list', backups }, args.json);
    return true;
  }

  if (args.clean) {
    const cleaned = await cleanBackups({ keep: args.keep });
    print({ ok: true, mode: 'clean', ...cleaned }, args.json);
    return true;
  }

  const backup = await createBackup();
  print({ ok: true, mode: 'create', ...backup }, args.json);
  return true;
}
