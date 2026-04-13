/**
 * memphis_fs_write — write/append/overwrite files with tier-aware sandboxing.
 *
 * Permission model (see fs-permission.ts):
 *   - Inside ~/memphis/: full access.
 *   - Outside ~/memphis/:
 *       mode='write'     → allowed only if file does not exist yet.
 *       mode='append'    → requires tier 3 (MEMPHIS_TIER3_FS_UNRESTRICTED=true).
 *       mode='overwrite' → requires tier 3.
 *   - Always-blocked paths (.env, vault-*, .git/, node_modules/) are denied
 *     even at tier 3.
 */

import { existsSync, mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import path from 'node:path';

import {
  assertFsPermission,
  isTier3FsBypassActive,
  resolveFsPath,
  type FsPermissionOperation,
} from './fs-permission.js';

export type MemphisFsWriteInput = {
  /** Path (absolute or ~-relative) to write to */
  path: string;
  /** Content to write */
  content: string;
  /**
   * 'write'     → create if missing; outside sandbox, refuses to overwrite existing
   * 'append'    → append; outside sandbox, requires tier 3
   * 'overwrite' → truncate+replace; outside sandbox, requires tier 3
   */
  mode?: 'write' | 'append' | 'overwrite';
  /** Create parent directories if missing */
  createDirs?: boolean;
};

export type MemphisFsWriteOutput = {
  path: string;
  bytesWritten: number;
  created: boolean;
  error?: string;
};

const MAX_CONTENT_BYTES = 1_048_576; // 1 MB

function operationForMode(mode: MemphisFsWriteInput['mode']): FsPermissionOperation {
  switch (mode) {
    case 'append':
      return 'append';
    case 'overwrite':
      return 'overwrite';
    case 'write':
    default:
      return 'create-new';
  }
}

export function runMemphisFsWrite(
  input: MemphisFsWriteInput,
  rawEnv: NodeJS.ProcessEnv = process.env,
): MemphisFsWriteOutput {
  const resolvedPath = resolveFsPath(input.path);
  const mode = input.mode ?? 'write';

  assertFsPermission(resolvedPath, {
    operation: operationForMode(mode),
    tier3Active: isTier3FsBypassActive(rawEnv),
  });

  const contentBytes = Buffer.byteLength(input.content, 'utf8');
  if (contentBytes > MAX_CONTENT_BYTES) {
    return {
      path: resolvedPath,
      bytesWritten: 0,
      created: false,
      error: `Content exceeds max size (${contentBytes} > ${MAX_CONTENT_BYTES} bytes)`,
    };
  }

  const existed = existsSync(resolvedPath);

  try {
    if (input.createDirs) {
      mkdirSync(path.dirname(resolvedPath), { recursive: true });
    }

    if (mode === 'append') {
      appendFileSync(resolvedPath, input.content, 'utf8');
    } else {
      // Both 'write' and 'overwrite' truncate+write. The create-new guard
      // for 'write' outside the sandbox was already enforced above.
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
