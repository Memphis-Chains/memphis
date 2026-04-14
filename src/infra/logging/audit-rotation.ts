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
  // Keep milliseconds so two rotations in the same second don't produce
  // the same filename — writeFileSync on an existing archive path silently
  // overwrites, which would drop audit events on the floor.
  return new Date().toISOString().replace(/[:]/g, '-');
}

function nextAvailableArchivePath(archiveDir: string, stamp: string): string {
  // Defensive: even with millisecond precision, two rotations inside the
  // same Date.now() tick would still collide. Suffix with a counter when
  // the first candidate already exists so no archive is ever overwritten.
  const base = join(archiveDir, `security-audit-${stamp}.jsonl.gz`);
  if (!existsSync(base)) return base;
  for (let i = 1; i < 1000; i += 1) {
    const candidate = join(archiveDir, `security-audit-${stamp}-${i}.jsonl.gz`);
    if (!existsSync(candidate)) return candidate;
  }
  throw new Error(
    `audit rotation: could not find a unique archive name after 1000 attempts for stamp ${stamp}`,
  );
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
  const finalPath = nextAvailableArchivePath(archiveDir, stamp);
  const stagedPath = finalPath.replace(/\.gz$/, '');

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
