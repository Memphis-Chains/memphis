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
import { existsSync, readlinkSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { findWriteBlockedLabel } from './read-scope.js';
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

// The list of always-blocked paths lives in `read-scope.ts`, shared with
// the native arm: the read path refuses vault material, the write path
// refuses vault material plus `.git/` and `node_modules/`.
//
// It used to be a list of regular expressions here. The regexes missed
// one shape — a path that IS the `node_modules` directory rather than a
// file inside it — and they were a second, independent copy of a list the
// native arm also carried.

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
 *
 * A symlink is resolved even when its TARGET does not exist. `realpathSync`
 * fails on a dangling link, and a dangling link is exactly the shape that
 * lets a write leave the repository: the link sits inside, the file it names
 * does not. A resolver that gives up at the link and keeps the link's own
 * name sees a path inside the sandbox and lets the write follow the link
 * out. The native arm resolves links the same way
 * (crates/memphis-operator/src/chat_self_modify.rs).
 */
export function realpathOrNearest(resolvedPath: string): string {
  return realpathOrNearestDepth(resolvedPath, 0);
}

/// How many symlinks may be followed before the resolver gives up.
///
/// A symlink loop would otherwise recurse forever; the limit matches the
/// one the kernel applies (ELOOP after 40 links).
const MAX_LINK_DEPTH = 32;

function realpathOrNearestDepth(resolvedPath: string, depth: number): string {
  try {
    return realpathSync(resolvedPath);
  } catch {
    // Path doesn't fully exist; walk it component by component.
  }
  if (depth >= MAX_LINK_DEPTH) return path.normalize(resolvedPath);

  const segments = path.normalize(resolvedPath).split(path.sep);
  let current = path.isAbsolute(resolvedPath) ? path.sep : '';
  for (const segment of segments) {
    if (!segment) continue;
    const candidate = path.join(current, segment);
    current = resolveLinkOrKeep(candidate, current, depth);
  }
  return current;
}

/** Follow one symlink, or keep the component as it is. */
function resolveLinkOrKeep(candidate: string, parent: string, depth: number): string {
  let link: string;
  try {
    link = readlinkSync(candidate);
  } catch {
    return candidate;
  }
  const target = path.isAbsolute(link) ? link : path.resolve(parent, link);
  return realpathOrNearestDepth(target, depth + 1);
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
  const label = findWriteBlockedLabel(resolvedPath);
  if (label) {
    throw new AppError(
      'VALIDATION_ERROR',
      `Operation on '${resolvedPath}' is always blocked (Memphis recoverability path)`,
      403,
    );
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
