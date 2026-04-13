/**
 * memphis_fs_ops — filesystem operations (copy, move, delete, mkdir, stat).
 *
 * Permission model (see fs-permission.ts):
 *   - Inside ~/memphis/: all operations allowed.
 *   - Outside ~/memphis/:
 *       mkdir, stat                → always allowed (additive / read-only).
 *       copy, move (dest missing)  → allowed (create-new).
 *       copy, move (dest exists)   → require tier 3.
 *       delete                     → requires tier 3.
 *   - Always-blocked paths (.env, vault-*, .git/, node_modules/) denied even
 *     at tier 3.
 */

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs';

import {
  assertFsPermission,
  isTier3FsBypassActive,
  resolveFsPath,
  type FsPermissionOperation,
} from './fs-permission.js';

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

function destOperationFor(operation: FsOperation): FsPermissionOperation {
  return operation === 'move' ? 'move-dest' : 'copy-dest';
}

export function runMemphisFsOps(
  input: MemphisFsOpsInput,
  rawEnv: NodeJS.ProcessEnv = process.env,
): MemphisFsOpsOutput {
  const source = resolveFsPath(input.source);
  const dest = input.destination ? resolveFsPath(input.destination) : undefined;
  const tier3Active = isTier3FsBypassActive(rawEnv);

  // Source-side permission:
  //   stat / copy       → read-only (operation 'stat')
  //   mkdir             → additive (operation 'mkdir')
  //   delete / move     → destructive on source (operation 'delete')
  const sourceOperation: FsPermissionOperation =
    input.operation === 'mkdir'
      ? 'mkdir'
      : input.operation === 'delete' || input.operation === 'move'
        ? 'delete'
        : 'stat';

  assertFsPermission(source, { operation: sourceOperation, tier3Active });

  if (dest && (input.operation === 'copy' || input.operation === 'move')) {
    assertFsPermission(dest, { operation: destOperationFor(input.operation), tier3Active });
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
