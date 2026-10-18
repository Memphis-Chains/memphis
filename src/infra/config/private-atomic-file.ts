import { randomUUID } from 'node:crypto';
import { closeSync, fsyncSync, openSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Private from creation, durable before publication; never truncate the live file.
 *
 * Cleanup runs in `finally`, and a `throw` there would replace whatever the
 * operation itself was already failing with — a full disk during the write
 * would surface as an unlink error instead. The leftover temporary is a
 * temporary, so the failure is reported rather than thrown, and the original
 * cause survives.
 */
export function writePrivateAtomicFile(path: string, content: string): void {
  const temporary = `${path}.tmp-${randomUUID()}`;
  let fd: number | undefined;
  try {
    fd = openSync(temporary, 'wx', 0o600);
    writeFileSync(fd, content, 'utf8');
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temporary, path);
    const directory = openSync(dirname(path), 'r');
    try {
      fsyncSync(directory);
    } finally {
      closeSync(directory);
    }
  } finally {
    if (fd !== undefined) closeSync(fd);
    try {
      unlinkSync(temporary);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        process.stderr.write(
          `[private-atomic-file] leftover temporary ${temporary} could not be removed: ${
            error instanceof Error ? error.message : 'unknown_error'
          }\n`,
        );
      }
    }
  }
}
