/**
 * Atomic JSON file write — crash-safe + symlink-defense.
 *
 * Pattern lifted from `src/security/tier3-session-persistence.ts:169-203`.
 * Two callers need exactly these semantics (tier-3 session state +
 * Kartograf nightly training status file), so the lift removes duplicated
 * crypto-quality state-file plumbing.
 *
 * Guarantees:
 *   1. Parent dir created with mode 0o700 if missing (operator-only).
 *   2. Pre-existing tmp path is unlinked first — defends against a
 *      same-uid attacker pre-planting tmpPath as a symlink targeting
 *      another writable file (would otherwise be followed by the open).
 *   3. `openSync(O_CREAT|O_WRONLY|O_EXCL, fileMode)` closes the TOCTOU
 *      window between unlink and open.
 *   4. `fsyncSync` before rename guarantees bytes hit disk; without it,
 *      a crash between write (page cache only) and rename can publish a
 *      torn file at the canonical path.
 *   5. `renameSync` to canonical path — atomic on POSIX same-fs.
 *
 * Errors propagate. Callers wrap in try/catch if they want best-effort
 * (e.g. tier-3 persistence logs and continues; a status writer might
 * abort the run).
 */
import {
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { dirname } from 'node:path';

export interface AtomicWriteOptions {
  /** Mode for the created file. Default `0o600` (operator-only). */
  fileMode?: number;
  /** Mode for the parent dir if it has to be created. Default `0o700`. */
  dirMode?: number;
  /** Tmp suffix appended to filePath. Default `'.tmp'`. */
  tmpSuffix?: string;
}

/**
 * Write `data` (string or Buffer) to `filePath` atomically.
 */
export function atomicWriteSync(
  filePath: string,
  data: string | Buffer,
  options: AtomicWriteOptions = {},
): void {
  const fileMode = options.fileMode ?? 0o600;
  const dirMode = options.dirMode ?? 0o700;
  const tmpSuffix = options.tmpSuffix ?? '.tmp';
  const tmpPath = filePath + tmpSuffix;

  const dir = dirname(filePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: dirMode });
  }

  // Symlink defense — unlink any pre-planted tmp file/symlink so the
  // subsequent O_EXCL open never follows a hostile target.
  try {
    unlinkSync(tmpPath);
  } catch (err) {
    const errno = (err as NodeJS.ErrnoException).code;
    if (errno !== 'ENOENT') throw err;
  }

  const fd = openSync(
    tmpPath,
    constants.O_CREAT | constants.O_WRONLY | constants.O_EXCL,
    fileMode,
  );
  try {
    if (typeof data === 'string') {
      writeSync(fd, data);
    } else {
      writeSync(fd, data);
    }
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmpPath, filePath);
}

/**
 * Serialize `value` to JSON (2-space indent) and write atomically.
 */
export function atomicWriteJsonSync(
  filePath: string,
  value: unknown,
  options: AtomicWriteOptions = {},
): void {
  atomicWriteSync(filePath, JSON.stringify(value, null, 2), options);
}
