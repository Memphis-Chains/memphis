/**
 * memphis_fs_ops — filesystem operations (copy, move, delete, mkdir, stat).
 *
 * Sandboxed to ~/memphis/. Blocks sensitive paths.
 */

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { AppError } from '../../core/errors.js';

export type FsOperation = 'copy' | 'move' | 'delete' | 'mkdir' | 'stat';

export type MemphisFsOpsInput = {
  operation: FsOperation;
  source: string;
  destination?: string;
  recursive?: boolean;
};

export type MemphisFsOpsOutput = {
  operation: FsOperation;
  success: boolean;
  source: string;
  destination?: string;
  stats?: {
    size: number;
    isFile: boolean;
    isDirectory: boolean;
    modified: string;
    created: string;
  };
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
      `Path '${resolvedPath}' is outside ~/memphis/`,
      403,
    );
  }
}

function assertNotBlocked(resolvedPath: string): void {
  const normalized = path.normalize(resolvedPath);
  for (const pattern of BLOCKED_PATTERNS) {
    if (pattern.test(normalized)) {
      throw new AppError('VALIDATION_ERROR', `Operation on '${resolvedPath}' is blocked`, 403);
    }
  }
}

export function runMemphisFsOps(input: MemphisFsOpsInput): MemphisFsOpsOutput {
  const source = resolvePath(input.source);
  assertInMemphisDir(source);

  const dest = input.destination ? resolvePath(input.destination) : undefined;
  if (dest) assertInMemphisDir(dest);

  // Block sensitive paths for destructive ops
  if (input.operation !== 'stat') {
    assertNotBlocked(source);
    if (dest) assertNotBlocked(dest);
  }

  try {
    switch (input.operation) {
      case 'stat': {
        if (!existsSync(source)) {
          return { operation: 'stat', success: false, source, error: 'Path does not exist' };
        }
        const st = statSync(source);
        return {
          operation: 'stat',
          success: true,
          source,
          stats: {
            size: st.size,
            isFile: st.isFile(),
            isDirectory: st.isDirectory(),
            modified: st.mtime.toISOString(),
            created: st.birthtime.toISOString(),
          },
        };
      }

      case 'mkdir':
        mkdirSync(source, { recursive: true });
        return { operation: 'mkdir', success: true, source };

      case 'copy': {
        if (!dest) {
          return { operation: 'copy', success: false, source, error: 'destination is required' };
        }
        copyFileSync(source, dest);
        return { operation: 'copy', success: true, source, destination: dest };
      }

      case 'move': {
        if (!dest) {
          return { operation: 'move', success: false, source, error: 'destination is required' };
        }
        renameSync(source, dest);
        return { operation: 'move', success: true, source, destination: dest };
      }

      case 'delete': {
        if (!existsSync(source)) {
          return { operation: 'delete', success: false, source, error: 'Path does not exist' };
        }
        rmSync(source, { recursive: input.recursive ?? false, force: false });
        return { operation: 'delete', success: true, source };
      }

      default:
        return {
          operation: input.operation,
          success: false,
          source,
          error: `Unknown operation: ${input.operation}`,
        };
    }
  } catch (err) {
    return {
      operation: input.operation,
      success: false,
      source,
      destination: dest,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
