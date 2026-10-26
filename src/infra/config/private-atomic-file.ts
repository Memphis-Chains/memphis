import { randomUUID } from 'node:crypto';
import {
  closeSync,
  fsyncSync,
  linkSync,
  openSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';

import { safeIoErrorCode } from '../storage/io-error-code.js';

function reportCleanupFailure(operation: 'close' | 'unlink', error: unknown): void {
  try {
    process.stderr.write(
      `[private-atomic-file] temporary ${operation} failed (${safeIoErrorCode(error) ?? 'PRIVATE_ATOMIC_CLEANUP_FAILED'})\n`,
    );
  } catch {
    /* A failed warning cannot replace the primary storage error. */
  }
}

/**
 * Private from creation, durable before publication; never truncate the live file.
 *
 * Cleanup runs in `finally`, and a `throw` there would replace whatever the
 * operation itself was already failing with — a full disk during the write
 * would surface as an unlink error instead. The leftover temporary is a
 * temporary, so the failure is reported rather than thrown, and the original
 * cause survives.
 */
export function writePrivateAtomicFile(
  path: string,
  content: string | Uint8Array,
  options: { exclusive?: boolean } = {},
): void {
  const temporary = `${path}.tmp-${randomUUID()}`;
  let fd: number | undefined;
  try {
    fd = openSync(temporary, 'wx', 0o600);
    writeFileSync(fd, content, 'utf8');
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    if (options.exclusive) linkSync(temporary, path);
    else renameSync(temporary, path);
    const directory = openSync(dirname(path), 'r');
    try {
      fsyncSync(directory);
    } finally {
      closeSync(directory);
    }
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch (error) {
        reportCleanupFailure('close', error);
      }
    }
    try {
      unlinkSync(temporary);
    } catch (error) {
      if (safeIoErrorCode(error) !== 'ENOENT') reportCleanupFailure('unlink', error);
    }
  }
}
