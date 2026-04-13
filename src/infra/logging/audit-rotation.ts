import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { gzip, gzipSync } from 'node:zlib';

const gzipAsync = promisify(gzip);

const DEFAULT_ROTATE_BYTES = 5 * 1024 * 1024;
const MIN_ROTATE_BYTES = 64 * 1024;
const MAX_ROTATE_BYTES = 100 * 1024 * 1024;

export function resolveAuditLogPath(rawEnv: NodeJS.ProcessEnv = process.env): string {
  return resolve(rawEnv.MEMPHIS_SECURITY_AUDIT_LOG_PATH ?? 'data/security-audit.jsonl');
}

export function resolveAuditArchiveDir(rawEnv: NodeJS.ProcessEnv = process.env): string {
  const override = rawEnv.MEMPHIS_SECURITY_AUDIT_ARCHIVE_DIR;
  if (override) return resolve(override);
  return join(dirname(resolveAuditLogPath(rawEnv)), 'security-audit-archives');
}

export function resolveRotateThresholdBytes(rawEnv: NodeJS.ProcessEnv = process.env): number {
  const raw = rawEnv.MEMPHIS_SECURITY_AUDIT_ROTATE_BYTES;
  if (!raw) return DEFAULT_ROTATE_BYTES;
  const parsed = Number.parseInt(raw.trim(), 10);
  if (!Number.isFinite(parsed)) return DEFAULT_ROTATE_BYTES;
  if (parsed < MIN_ROTATE_BYTES) return MIN_ROTATE_BYTES;
  if (parsed > MAX_ROTATE_BYTES) return MAX_ROTATE_BYTES;
  return parsed;
}

function isoStampForFilename(): string {
  return new Date()
    .toISOString()
    .replace(/[:]/g, '-')
    .replace(/\.\d+Z$/, 'Z');
}

function sizeOfFile(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

export interface RotationResult {
  rotated: boolean;
  archivePath?: string;
  bytesArchived?: number;
}

export function maybeRotateAuditLog(rawEnv: NodeJS.ProcessEnv = process.env): RotationResult {
  const logPath = resolveAuditLogPath(rawEnv);
  if (!existsSync(logPath)) return { rotated: false };

  const size = sizeOfFile(logPath);
  const threshold = resolveRotateThresholdBytes(rawEnv);
  if (size < threshold) return { rotated: false };

  const archiveDir = resolveAuditArchiveDir(rawEnv);
  mkdirSync(archiveDir, { recursive: true });

  const stamp = isoStampForFilename();
  const stagedPath = join(archiveDir, `security-audit-${stamp}.jsonl`);
  const finalPath = `${stagedPath}.gz`;

  renameSync(logPath, stagedPath);

  try {
    const data = readFileSync(stagedPath);
    const gz = gzipSync(data, { level: 9 });
    writeFileSync(finalPath, gz);
    unlinkSync(stagedPath);
  } catch (err) {
    renameSync(stagedPath, logPath);
    throw err;
  }

  try {
    writeFileSync(logPath, '', 'utf8');
  } catch {
    // Non-fatal: a subsequent append will create the file.
  }

  return { rotated: true, archivePath: finalPath, bytesArchived: size };
}

export async function compressFileToGzAsync(sourcePath: string): Promise<string> {
  const destPath = `${sourcePath}.gz`;
  const data = await readFile(sourcePath);
  const compressed = await gzipAsync(data, { level: 9 });
  await writeFile(destPath, compressed);
  return destPath;
}

export function formatArchiveFilename(archivePath: string): string {
  return basename(archivePath);
}
