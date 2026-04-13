/**
 * Shared filesystem permission check for memphis_fs_write / memphis_fs_ops.
 *
 * Two-level permission model:
 *
 *   Default (tier ≤ 2, no tier-3 session active)
 *     - Inside ~/memphis/: full read/write/overwrite/delete.
 *     - Outside ~/memphis/: may create new files/dirs; may NOT modify,
 *       overwrite, truncate, or delete existing files/dirs.
 *
 *   Tier 3 active (MEMPHIS_TIER3_FS_UNRESTRICTED=true)
 *     - Full read/write/overwrite/delete anywhere.
 *
 *   Always blocked (regardless of tier)
 *     - .env / .env.* files (any depth)
 *     - vault-state.json / vault-entries.json (vault recoverability)
 *     - .git/ directories (source of truth for state)
 *     - node_modules/ (reproducible from package-lock.json)
 */
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { AppError } from '../../core/errors.js';
import { hasAnyActiveTier3Session } from '../../security/tier3-session.js';

export type FsPermissionOperation =
  | 'create-new'   // fs-write mode=write (fails loud if exists outside sandbox)
  | 'append'       // fs-write mode=append (requires tier 3 outside sandbox)
  | 'overwrite'    // fs-write mode=overwrite (requires tier 3 outside sandbox)
  | 'copy-dest'    // fs-ops copy destination
  | 'move-dest'    // fs-ops move destination
  | 'delete'       // fs-ops delete
  | 'mkdir'        // fs-ops mkdir (additive — allowed outside sandbox)
  | 'stat';        // fs-ops stat (read-only — always allowed)

export interface FsPermissionContext {
  operation: FsPermissionOperation;
  /** True when a tier-3 elevation session is active for this request. */
  tier3Active: boolean;
}

const ALWAYS_BLOCKED_PATTERNS: RegExp[] = [
  /(^|\/)\.env$/,
  /(^|\/)\.env\.[^/]+$/,
  /(^|\/)vault-state\.json$/,
  /(^|\/)vault-entries\.json$/,
  /(^|\/)\.git\//,
  /(^|\/)\.git$/,
  /(^|\/)node_modules\//,
];

export function resolveFsPath(inputPath: string): string {
  if (inputPath.startsWith('~/')) {
    return path.join(os.homedir(), inputPath.slice(2));
  }
  return path.resolve(inputPath);
}

function memphisSandboxDir(): string {
  return path.join(os.homedir(), 'memphis');
}

export function isInsideMemphisSandbox(resolvedPath: string): boolean {
  const sandbox = memphisSandboxDir();
  const normalized = path.normalize(resolvedPath);
  return normalized === sandbox || normalized.startsWith(sandbox + path.sep);
}

function assertNotAlwaysBlocked(resolvedPath: string): void {
  const normalized = path.normalize(resolvedPath);
  for (const pattern of ALWAYS_BLOCKED_PATTERNS) {
    if (pattern.test(normalized)) {
      throw new AppError(
        'VALIDATION_ERROR',
        `Operation on '${resolvedPath}' is always blocked (Memphis recoverability path)`,
        403,
      );
    }
  }
}

/**
 * True when the operation is inherently non-destructive (cannot mutate
 * existing state): stat (read), mkdir (creates only, no-op on existing),
 * create-new (refuses to overwrite).
 */
function isAdditiveOperation(op: FsPermissionOperation, resolvedPath: string): boolean {
  if (op === 'stat' || op === 'mkdir') return true;
  if (op === 'create-new' || op === 'copy-dest' || op === 'move-dest') {
    // Allowed when target does not already exist.
    return !existsSync(resolvedPath);
  }
  return false;
}

/**
 * Assert that {operation} is permitted at {resolvedPath} given the current
 * tier. Throws AppError(403) when denied. Returns silently when allowed.
 */
export function assertFsPermission(resolvedPath: string, context: FsPermissionContext): void {
  // Recoverability paths are always off-limits (even at tier 3).
  assertNotAlwaysBlocked(resolvedPath);

  // stat is purely read-only — always allowed (subject to always-blocked).
  if (context.operation === 'stat') return;

  // Inside the sandbox, anything goes (still subject to always-blocked).
  if (isInsideMemphisSandbox(resolvedPath)) return;

  // Tier-3 session active → full access outside sandbox.
  if (context.tier3Active) return;

  // Additive-only operations are allowed outside sandbox.
  if (isAdditiveOperation(context.operation, resolvedPath)) return;

  throw new AppError(
    'VALIDATION_ERROR',
    `Outside ~/memphis/, ${context.operation} on an existing path requires tier 3. ` +
      `Run "/tier 3 <operator_passphrase>" to elevate for 3 hours. (path: ${resolvedPath})`,
    403,
  );
}

/**
 * Read the tier-3 fs bypass flag from the current process env. Kept as a
 * helper so call sites can pass a custom rawEnv (for tests) without each
 * site duplicating the parsing.
 */
export function isTier3FsBypassActive(rawEnv: NodeJS.ProcessEnv = process.env): boolean {
  if ((rawEnv.MEMPHIS_TIER3_FS_UNRESTRICTED ?? '').toLowerCase() === 'true') {
    return true;
  }
  // Fallback: if any tier-3 session is active in this process (e.g. TUI /tier 3
  // elevation whose env override hasn't been threaded to the tool executor's
  // rawEnv), respect it. Surface policy is the primary tier gate, so this
  // cannot escalate a non-elevated surface past its declared maxToolTier.
  return hasAnyActiveTier3Session();
}
