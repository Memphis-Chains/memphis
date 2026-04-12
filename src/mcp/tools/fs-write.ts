/**
 * memphis_fs_write — safe file write/append restricted to ~/memphis/.
 *
 * Blocks sensitive paths (.env, vault-*, .git/, node_modules/).
 */

import { existsSync, mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { AppError } from '../../core/errors.js';

export type MemphisFsWriteInput = {
  /** Path (absolute or ~-relative) to write to */
  path: string;
  /** Content to write */
  content: string;
  /** 'write' (overwrite/create) or 'append' */
  mode?: 'write' | 'append';
  /** Create parent directories if missing */
  createDirs?: boolean;
};

export type MemphisFsWriteOutput = {
  path: string;
  bytesWritten: number;
  created: boolean;
  error?: string;
};

const BLOCKED_PATTERNS = [
  /\/\.env$/,
  /\/\.env\./,
  /\/vault-state\.json$/,
  /\/vault-entries\.json$/,
  /\/\.git\//,
  /\/\.git$/,
  /\/node_modules\//,
];

const MAX_CONTENT_BYTES = 1_048_576; // 1 MB

function resolvePath(inputPath: string): string {
  return inputPath.startsWith('~/')
    ? path.join(os.homedir(), inputPath.slice(2))
    : path.resolve(inputPath);
}

function assertInMemphisDir(resolvedPath: string): void {
  const memphisDir = path.join(os.homedir(), 'memphis');
  const normalized = path.normalize(resolvedPath);
  if (!normalized.startsWith(memphisDir + path.sep) && normalized !== memphisDir) {
    throw new AppError(
      'VALIDATION_ERROR',
      `Path '${resolvedPath}' is outside the allowed ~/memphis/ directory`,
      403,
    );
  }
}

function assertNotBlocked(resolvedPath: string): void {
  const normalized = path.normalize(resolvedPath);
  for (const pattern of BLOCKED_PATTERNS) {
    if (pattern.test(normalized)) {
      throw new AppError(
        'VALIDATION_ERROR',
        `Write to '${resolvedPath}' is blocked (sensitive path)`,
        403,
      );
    }
  }
}

export function runMemphisFsWrite(input: MemphisFsWriteInput): MemphisFsWriteOutput {
  const resolvedPath = resolvePath(input.path);
  assertInMemphisDir(resolvedPath);
  assertNotBlocked(resolvedPath);

  const contentBytes = Buffer.byteLength(input.content, 'utf8');
  if (contentBytes > MAX_CONTENT_BYTES) {
    return {
      path: resolvedPath,
      bytesWritten: 0,
      created: false,
      error: `Content exceeds max size (${contentBytes} > ${MAX_CONTENT_BYTES} bytes)`,
    };
  }

  const mode = input.mode ?? 'write';
  const existed = existsSync(resolvedPath);

  try {
    if (input.createDirs) {
      mkdirSync(path.dirname(resolvedPath), { recursive: true });
    }

    if (mode === 'append') {
      appendFileSync(resolvedPath, input.content, 'utf8');
    } else {
      writeFileSync(resolvedPath, input.content, 'utf8');
    }

    return {
      path: resolvedPath,
      bytesWritten: contentBytes,
      created: !existed,
    };
  } catch (err) {
    return {
      path: resolvedPath,
      bytesWritten: 0,
      created: false,
      error: `Write failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
