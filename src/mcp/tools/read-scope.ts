/**
 * The read-scope policy shared by `memphis_code_read`, `memphis_grep` and
 * `memphis_glob`.
 *
 * WHY THIS EXISTS
 * ---------------
 * The read tools used to be restricted to a whitelist of roots
 * (`~/memphis/`, `~/.memphis/`, `~/projects/`). That whitelist was never a
 * security boundary: `memphis_exec` — the SAME tier 2 — could `cat` any
 * file on the host, and the native arm did not even honour the whitelist
 * (the TypeScript arm read `MEMPHIS_CODE_READ_EXTRA_ROOTS`, the Rust arm
 * ignored it, so the two arms already disagreed about what was readable).
 *
 * The real boundary is the TIER: code_read, grep and glob are tier 2, which
 * requires the vault passphrase. The operator asked for "Memphis must be able
 * to read everything on this computer", so the whitelist is gone and the
 * tier carries the authorization.
 *
 * WHAT IS STILL REFUSED
 * ---------------------
 * Vault material: `.env`, `.env.*`, `vault-state.json`, `vault-entries.json`.
 * Not because the tier is too low — exec at the same tier can read them —
 * but because the output of these tools is durable: it lands in the
 * conversation, in the journal and in the semantic embed index, i.e. a
 * plaintext copy of a secret OUTSIDE the encrypted vault. `exec` output does
 * not get indexed the same way. The vault is the place a secret belongs.
 *
 * The WRITE path is stricter still: it refuses vault material, `.git/` and
 * `node_modules/`, and stays inside `~/memphis/`. Writing into a `.git`
 * directory corrupts the source of truth; reading it does not.
 */

import os from 'node:os';
import path from 'node:path';

import { MEMPHIS_CODE_READ_ROOTS } from '../../config/env-registry.js';
import { AppError } from '../../core/errors.js';

/**
 * Path segments whose CONTENT is vault material.
 *
 * `.env` and `.env.*` hold the vault pepper and the provider keys;
 * `vault-state.json` and `vault-entries.json` hold the encrypted vault
 * state. The vault is the only place a secret belongs, and these tools
 * index what they return.
 */
export const SECRET_MATERIAL_SEGMENTS: ReadonlySet<string> = new Set([
  '.env',
  'vault-state.json',
  'vault-entries.json',
]);

/**
 * The file names that are vault material, as glob patterns.
 *
 * The read path refuses a path that NAMES vault material. A search over a
 * DIRECTORY is a different case: the directory is not a secret, but a file
 * inside it can be. `grep` over a directory containing `.env` would put the
 * secret into the output, and the output is indexed — so the search tools
 * exclude these names from their results.
 */
export const VAULT_MATERIAL_GLOBS: readonly string[] = [
  '!.env',
  '!.env.*',
  '!vault-state.json',
  '!vault-entries.json',
];

/**
 * True when a FILE NAME is vault material.
 *
 * The read path refuses a path that names vault material. A search over a
 * DIRECTORY is a different case: the directory is not a secret, but a file
 * inside it can be. `grep` over a directory containing `.env` would put
 * the secret into the output, and the output is indexed.
 *
 * One predicate, used by every search path: the ripgrep invocation, the
 * grep fallback, the pure-JavaScript fallback and the file listing.
 */
export function isVaultMaterialName(name: string): boolean {
  return (
    name === '.env' ||
    name.startsWith('.env.') ||
    name === 'vault-state.json' ||
    name === 'vault-entries.json'
  );
}

/**
 * Path segments the WRITE path additionally refuses.
 *
 * `node_modules/` is reproducible from the lockfile; `.git/` is the source
 * of truth for the repository state. Reading them is harmless, writing them
 * is not.
 */
export const WRITE_BLOCKED_SEGMENTS: ReadonlySet<string> = new Set(['.git', 'node_modules']);

/** The label used in the refusal message for a blocked segment. */
export function blockedSegmentLabel(segment: string): string | null {
  if (SECRET_MATERIAL_SEGMENTS.has(segment)) return segment;
  if (segment.startsWith('.env.')) return '.env.*';
  return null;
}

/** The label used in the refusal message for a write-blocked segment. */
export function writeBlockedSegmentLabel(segment: string): string | null {
  const secret = blockedSegmentLabel(segment);
  if (secret) return secret;
  if (WRITE_BLOCKED_SEGMENTS.has(segment)) return segment;
  return null;
}

function segmentsOf(resolvedPath: string): string[] {
  return path
    .normalize(resolvedPath)
    .split('/')
    .filter((segment) => segment !== '' && segment !== '.');
}

/**
 * The roots the read tools may look at.
 *
 * Empty by default: the whole host is readable. When
 * `MEMPHIS_CODE_READ_ROOTS` is set, it is a comma-separated list and
 * becomes the complete allowlist — the way back to a narrower setup.
 */
export function readRoots(rawEnv: NodeJS.ProcessEnv = process.env): string[] {
  return MEMPHIS_CODE_READ_ROOTS.read(rawEnv)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) =>
      item.startsWith('~/') ? path.join(os.homedir(), item.slice(2)) : path.resolve(item),
    );
}

/**
 * Refuse a path that names vault material.
 *
 * The same words on both arms (TypeScript and the native one), because the
 * shared contract fixture compares them literally.
 */
export function assertNotSecretMaterial(resolvedPath: string): void {
  for (const segment of segmentsOf(resolvedPath)) {
    const label = blockedSegmentLabel(segment);
    if (label) {
      throw new AppError(
        'VALIDATION_ERROR',
        `Path '${resolvedPath}' is blocked because it matches ${label} and may contain secrets or generated state`,
        403,
      );
    }
  }
}

/**
 * Refuse a path the WRITE path may not touch.
 *
 * Vault material plus `.git/` and `node_modules/`.
 */
export function assertNotWriteBlocked(resolvedPath: string): void {
  const label = findWriteBlockedLabel(resolvedPath);
  if (label) {
    throw new AppError(
      'VALIDATION_ERROR',
      `Path '${resolvedPath}' is blocked because it matches ${label} and may contain secrets or generated state`,
      403,
    );
  }
}

/**
 * The label of the segment that makes a path unwritable, if there is one.
 *
 * The caller decides how to report it: the write tools (`fs_write`,
 * `fs_ops`) use their own recoverability wording, the native arm uses the
 * same words as the read path. The LIST is shared, so the two cannot drift.
 */
export function findWriteBlockedLabel(resolvedPath: string): string | null {
  for (const segment of segmentsOf(resolvedPath)) {
    const label = writeBlockedSegmentLabel(segment);
    if (label) return label;
  }
  return null;
}

/**
 * Refuse a path outside the configured read roots.
 *
 * With no roots configured (the default) every path on the host is
 * readable, so this never refuses. It exists so an operator who sets
 * `MEMPHIS_CODE_READ_ROOTS` gets a real boundary, and so both arms refuse
 * the same paths in the same words.
 */
export function assertWithinReadRoots(
  resolvedPath: string,
  rawEnv: NodeJS.ProcessEnv = process.env,
): void {
  const roots = readRoots(rawEnv);
  if (roots.length === 0) return;

  const normalized = path.normalize(resolvedPath);
  for (const root of roots) {
    if (normalized === root || normalized.startsWith(root + path.sep)) return;
  }
  throw new AppError(
    'VALIDATION_ERROR',
    `Path '${resolvedPath}' is outside the allowed read roots: ${roots.join(', ')}`,
    403,
  );
}

/**
 * The path a relative `path` argument resolves against: the install root.
 */
export function projectRoot(): string {
  return path.join(os.homedir(), 'memphis');
}

/**
 * The prefix to strip from result paths, so the output is readable.
 *
 * The install root when the search happened inside it — the operator
 * (and the model) wants `src/live.ts`, not `live.ts` — and the search
 * path itself when the search happened elsewhere on the host.
 */
export function displayPrefix(searchPath: string, root: string): string {
  const normalizedSearch = path.normalize(searchPath);
  const normalizedRoot = path.normalize(root);
  if (
    normalizedSearch === normalizedRoot ||
    normalizedSearch.startsWith(normalizedRoot + path.sep)
  ) {
    return normalizedRoot;
  }
  return normalizedSearch;
}

/** Escape a path for use inside a regular expression. */
export function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Resolve a caller-supplied path.
 *
 * `~/x` expands against `$HOME`, a relative path resolves against the
 * given root (the install root by default), an absolute path is taken as
 * it is.
 */
export function resolveReadPath(inputPath: string, root: string = projectRoot()): string {
  if (inputPath.startsWith('~/')) return path.join(os.homedir(), inputPath.slice(2));
  if (path.isAbsolute(inputPath)) return path.normalize(inputPath);
  return path.resolve(root, inputPath);
}
