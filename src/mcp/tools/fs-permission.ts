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
import { existsSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { AppError } from '../../core/errors.js';

export type FsPermissionOperation =
  | 'create-new' // fs-write mode=write (fails loud if exists outside sandbox)
  | 'append' // fs-write mode=append (requires tier 3 outside sandbox)
  | 'overwrite' // fs-write mode=overwrite (requires tier 3 outside sandbox)
  | 'copy-dest' // fs-ops copy destination
  | 'move-dest' // fs-ops move destination
  | 'delete' // fs-ops delete
  | 'mkdir' // fs-ops mkdir (additive — allowed outside sandbox)
  | 'stat'; // fs-ops stat (read-only — always allowed)

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

/**
 * Resolve a path through any symlinks. If the path itself doesn't exist yet
 * (e.g. a create-new target), walk up to the nearest existing ancestor,
 * realpath that, and re-append the non-existent suffix. Returns the input
 * when no existing ancestor is found (e.g. nonexistent root), which the
 * caller then evaluates against the sandbox prefix as-is.
 */
export function realpathOrNearest(resolvedPath: string): string {
  try {
    return realpathSync(resolvedPath);
  } catch {
    // Path doesn't exist; walk up.
  }
  const segments = path.normalize(resolvedPath).split(path.sep);
  for (let depth = segments.length - 1; depth > 0; depth -= 1) {
    const ancestor = segments.slice(0, depth).join(path.sep) || path.sep;
    try {
      const realAncestor = realpathSync(ancestor);
      const suffix = segments.slice(depth).join(path.sep);
      return suffix.length > 0 ? path.join(realAncestor, suffix) : realAncestor;
    } catch {
      // keep walking up
    }
  }
  return path.normalize(resolvedPath);
}

export function isInsideMemphisSandbox(resolvedPath: string): boolean {
  const sandbox = memphisSandboxDir();
  // Resolve real paths so a symlink inside ~/memphis/ that points at /etc
  // doesn't trick the prefix check into believing the target is inside the
  // sandbox. Both sides are realpath'd in case ~/memphis itself is a symlink
  // (common on NixOS / containerised setups).
  let realSandbox: string;
  try {
    realSandbox = realpathSync(sandbox);
  } catch {
    realSandbox = sandbox;
  }
  const realTarget = realpathOrNearest(resolvedPath);
  return realTarget === realSandbox || realTarget.startsWith(realSandbox + path.sep);
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
 * Read the tier-3 fs bypass flag from the REQUEST env. This must be the
 * per-turn overlay set by `applyTier3EnvOverride(surface, actorId)`, not a
 * process-global "any tier-3 session is active anywhere" fallback.
 *
 * The earlier `hasAnyActiveTier3Session` fallback broke per-actor isolation:
 * one surface's tier-3 session (e.g. TUI elevation) would light up the
 * bypass for every other surface's turn (e.g. a Telegram tier-2 request).
 * That turned the fs bypass into a process-global privilege, contradicting
 * the sprint-2 "tier-3 is scoped per surface+actor" contract.
 *
 * Surface code is responsible for threading the env overlay through to the
 * tool executor — that's the only valid signal here.
 */
export function isTier3FsBypassActive(rawEnv: NodeJS.ProcessEnv = process.env): boolean {
  return (rawEnv.MEMPHIS_TIER3_FS_UNRESTRICTED ?? '').toLowerCase() === 'true';
}
