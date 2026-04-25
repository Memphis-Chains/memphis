import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { gzipSync } from 'node:zlib';

const DEFAULT_ROTATE_BYTES = 10 * 1024 * 1024;
const MIN_ROTATE_BYTES = 64 * 1024;
// Capped at 100 MiB: rotation does readFileSync + gzipSync, so the whole
// file lives in heap during compression. A 1 GiB cap was a footgun on
// low-RAM operator boxes (~2.5 GiB resident during rotation). If a
// future use case truly needs larger logs, switch to a streaming gzip
// path (createReadStream → createGzip → createWriteStream).
const MAX_ROTATE_BYTES = 100 * 1024 * 1024;
const DEFAULT_KEEP_ARCHIVES = 5;
const MIN_KEEP_ARCHIVES = 1;
const MAX_KEEP_ARCHIVES = 100;
// Hard cap on the size we'll feed to readFileSync+gzipSync. The trigger
// threshold (MEMPHIS_LOG_ROTATE_BYTES) only governs WHEN to rotate; if a
// pre-existing log was already much larger (older builds without
// rotation, or after running with MEMPHIS_LOG_ROTATE=disabled), we must
// not allocate hundreds of MiB synchronously and OOM the operator box
// before logging initializes. Above this cap rotation is skipped with a
// stderr hint so operators can compress / truncate manually.
//
// Default tightened to 64 MiB: peak heap during gzip is roughly file
// size + compressed output (~1.1×). 64 MiB → ~75 MiB peak which is safe
// even on the i3-2120 reference box (1 GiB free). Operators with larger
// expected logs raise via MEMPHIS_LOG_ROTATE_MAX_INPUT_BYTES; the
// higher-cost streaming path is intentionally not the default.
const DEFAULT_MAX_INPUT_BYTES = 64 * 1024 * 1024;
const MIN_MAX_INPUT_BYTES = 1024 * 1024;
const MAX_MAX_INPUT_BYTES = 4 * 1024 * 1024 * 1024;

export function resolveLogRotateBytes(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.MEMPHIS_LOG_ROTATE_BYTES;
  if (!raw) return DEFAULT_ROTATE_BYTES;
  const parsed = Number.parseInt(raw.trim(), 10);
  if (!Number.isFinite(parsed)) return DEFAULT_ROTATE_BYTES;
  if (parsed < MIN_ROTATE_BYTES) return MIN_ROTATE_BYTES;
  if (parsed > MAX_ROTATE_BYTES) return MAX_ROTATE_BYTES;
  return parsed;
}

export function resolveLogKeepArchives(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.MEMPHIS_LOG_ROTATE_KEEP;
  if (!raw) return DEFAULT_KEEP_ARCHIVES;
  const parsed = Number.parseInt(raw.trim(), 10);
  if (!Number.isFinite(parsed)) return DEFAULT_KEEP_ARCHIVES;
  if (parsed < MIN_KEEP_ARCHIVES) return MIN_KEEP_ARCHIVES;
  if (parsed > MAX_KEEP_ARCHIVES) return MAX_KEEP_ARCHIVES;
  return parsed;
}

export function resolveLogMaxInputBytes(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.MEMPHIS_LOG_ROTATE_MAX_INPUT_BYTES;
  if (!raw) return DEFAULT_MAX_INPUT_BYTES;
  const parsed = Number.parseInt(raw.trim(), 10);
  if (!Number.isFinite(parsed)) return DEFAULT_MAX_INPUT_BYTES;
  if (parsed < MIN_MAX_INPUT_BYTES) return MIN_MAX_INPUT_BYTES;
  if (parsed > MAX_MAX_INPUT_BYTES) return MAX_MAX_INPUT_BYTES;
  return parsed;
}

export function logRotationDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.MEMPHIS_LOG_ROTATE?.trim().toLowerCase();
  return raw === 'disabled' || raw === 'off' || raw === 'false' || raw === '0';
}

export interface LogRotationResult {
  rotated: boolean;
  archivePath?: string;
  bytesArchived?: number;
  prunedArchives?: number;
}

function isoStampForFilename(): string {
  return new Date().toISOString().replace(/:/g, '-');
}

function nextAvailableArchivePath(archiveDir: string, baseName: string, stamp: string): string {
  const candidate = join(archiveDir, `${baseName}-${stamp}.gz`);
  if (!existsSync(candidate)) return candidate;
  for (let i = 1; i < 1000; i += 1) {
    const next = join(archiveDir, `${baseName}-${stamp}-${i}.gz`);
    if (!existsSync(next)) return next;
  }
  throw new Error(
    `log rotation: could not find a unique archive name after 1000 attempts for stamp ${stamp}`,
  );
}

function sizeOfFile(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

function pruneOldArchives(archiveDir: string, baseName: string, keep: number): number {
  let entries: string[];
  try {
    entries = readdirSync(archiveDir);
  } catch {
    return 0;
  }
  // Anchor the WHOLE archive pattern, not just the prefix. The format
  // written by nextAvailableArchivePath is `${stamp}.gz` or
  // `${stamp}-${i}.gz` where stamp = ISO-8601 with `:` → `-`. Anchoring
  // only the prefix matched contrived sibling names like
  // `memphis-2026-04-25Tfoo.gz` and could prune another logger's
  // archives in shared `archives/` layouts.
  const archivePattern = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z(?:-\d+)?\.gz$/;
  const candidates = entries
    .filter((name) => {
      const prefix = `${baseName}-`;
      if (!name.startsWith(prefix)) return false;
      return archivePattern.test(name.slice(prefix.length));
    })
    .map((name) => {
      const full = join(archiveDir, name);
      let mtime = 0;
      try {
        mtime = statSync(full).mtimeMs;
      } catch {
        // best-effort
      }
      return { full, mtime };
    })
    .sort((a, b) => b.mtime - a.mtime);

  const surplus = candidates.slice(keep);
  let pruned = 0;
  for (const entry of surplus) {
    try {
      unlinkSync(entry.full);
      pruned += 1;
    } catch {
      // best-effort
    }
  }
  return pruned;
}

export function maybeRotateLogFile(
  logPath: string,
  rawEnv: NodeJS.ProcessEnv = process.env,
): LogRotationResult {
  if (logRotationDisabled(rawEnv)) return { rotated: false };
  if (!existsSync(logPath)) return { rotated: false };

  const size = sizeOfFile(logPath);
  const threshold = resolveLogRotateBytes(rawEnv);
  if (size < threshold) return { rotated: false };

  const maxInput = resolveLogMaxInputBytes(rawEnv);
  if (size > maxInput) {
    try {
      process.stderr.write(
        `[memphis] log rotation skipped: ${logPath} is ${size} bytes ` +
          `(> MEMPHIS_LOG_ROTATE_MAX_INPUT_BYTES=${maxInput}); ` +
          `compress externally (e.g. \`gzip ${logPath}\`) or truncate to recover.\n`,
      );
    } catch {
      // best-effort: never let stderr failure break logger startup
    }
    return { rotated: false };
  }

  const dir = dirname(logPath);
  const fileName = basename(logPath);
  const dotIdx = fileName.lastIndexOf('.');
  const baseName = dotIdx > 0 ? fileName.slice(0, dotIdx) : fileName;
  const archiveDir = join(dir, 'archives');

  try {
    mkdirSync(archiveDir, { recursive: true });
  } catch {
    return { rotated: false };
  }

  const stamp = isoStampForFilename();
  const finalPath = nextAvailableArchivePath(archiveDir, baseName, stamp);
  const stagedPath = finalPath.replace(/\.gz$/, '');

  try {
    renameSync(logPath, stagedPath);
  } catch {
    return { rotated: false };
  }

  try {
    const data = readFileSync(stagedPath);
    const gz = gzipSync(data, { level: 6 });
    writeFileSync(finalPath, gz);
    unlinkSync(stagedPath);
  } catch {
    try {
      renameSync(stagedPath, logPath);
    } catch {
      // staged file is lost; nothing more we can do
    }
    return { rotated: false };
  }

  try {
    writeFileSync(logPath, '', 'utf8');
  } catch {
    // best-effort: a subsequent append will create the file
  }

  const keep = resolveLogKeepArchives(rawEnv);
  const prunedArchives = pruneOldArchives(archiveDir, baseName, keep);

  return { rotated: true, archivePath: finalPath, bytesArchived: size, prunedArchives };
}
