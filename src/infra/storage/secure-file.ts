import { chmodSync, existsSync, mkdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Sensitive-file write/load helpers — POSIX 0600 enforcement.
 *
 * Memphis stores several files that carry primary-trust or
 * operationally-sensitive data and should NOT be group/world readable
 * even on a single-user box (backups, multi-user hosts, restored from
 * a tarball with permissive umask, etc.):
 *
 *   - vault-entries.json (encrypted seeds, key fingerprints)
 *   - vault-state.json   (master-key envelope; already 0600 via writer)
 *   - soul-manifest.json (autonomy_mode, trustRules, tool gating)
 *   - soul-memory.json   (operator's identity/persona narrative)
 *   - agent-profile.json (agent + owner names; user-pii adjacent)
 *   - operator.json      (operator passphrase hash; already 0600)
 *
 * Issue #272 (security): "ed25519 signing seed file permissions not
 * enforced 0600 at init". The seed itself lives inside vault-entries.json
 * (mp_v0_signing_seed entry) so the underlying file's permissions ARE
 * the seed's permissions. The fix family extends to every sensitive
 * config file: enforce 0600 on every write AND heal existing files
 * with wider perms on every read (operator's existing install pre-dates
 * the writer fix and has 664 files on disk — heal-on-load tightens
 * silently with a warn so operators don't have to manually chmod).
 *
 * Cross-platform: POSIX modes are ignored on Windows (NTFS uses ACLs).
 * The chmod is best-effort — write failure on Windows is fine, the
 * mode flag in writeFileSync is the primary path; chmodSync is the
 * pre-existing-file heal path.
 */

const SENSITIVE_PERMS = 0o600;
const SENSITIVE_DIR_PERMS = 0o700;

const healedPathsThisProcess = new Set<string>();

function isPermissive(mode: number): boolean {
  // Any non-zero bit in group/other = permissive.
  return (mode & 0o077) !== 0;
}

/**
 * Write a sensitive payload atomically (tmp + rename) with mode 0o600.
 * Creates the parent directory with 0o700 if missing. Best-effort
 * chmodSync follows the write so prior pre-existing files at the
 * destination get their perms tightened too.
 */
export function writeSensitiveFile(path: string, content: string): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: SENSITIVE_DIR_PERMS });
  const tmpPath = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmpPath, content, { mode: SENSITIVE_PERMS, encoding: 'utf8' });
  try {
    chmodSync(tmpPath, SENSITIVE_PERMS);
  } catch {
    // Best-effort — Windows / non-POSIX filesystems may reject.
  }
  // Atomic swap. POSIX rename(2) preserves the destination's inode
  // perms only if the source already had them — that's why we set the
  // mode on the tmp file before the rename.
  renameSync(tmpPath, path);
  // After rename, ensure the file has the right mode (defensive — some
  // filesystems may apply umask during the rename).
  try {
    chmodSync(path, SENSITIVE_PERMS);
  } catch {
    // ignore on non-POSIX
  }
}

/**
 * Heal-on-load: if `path` exists with permissions wider than 0600,
 * tighten in place and emit a one-time warning. Idempotent within a
 * single process — repeated calls for the same path skip the stat/chmod
 * after the first heal succeeds.
 *
 * Returns:
 *   - 'absent'  — file does not exist (no action taken)
 *   - 'ok'      — file existed with correct perms (or non-POSIX FS)
 *   - 'healed'  — file had wider perms; chmod 0o600 applied
 *
 * Callers should not rely on the return value for control flow; it's
 * for tests + audit logging. A fail-soft heal (chmod throws) is
 * treated as 'ok' rather than an error — refusing to load the file
 * because we couldn't tighten its perms would be worse than logging
 * and proceeding.
 */
export function healSensitiveFilePerms(path: string): 'absent' | 'ok' | 'healed' {
  if (!existsSync(path)) return 'absent';
  if (healedPathsThisProcess.has(path)) return 'ok';
  let mode: number;
  try {
    mode = statSync(path).mode;
  } catch {
    return 'ok';
  }
  if (!isPermissive(mode)) {
    healedPathsThisProcess.add(path);
    return 'ok';
  }
  try {
    chmodSync(path, SENSITIVE_PERMS);
    healedPathsThisProcess.add(path);
    process.stderr.write(
      `[memphis-secure-file] tightened perms on ${path} from ${(mode & 0o777).toString(8)} to 600\n`,
    );
    return 'healed';
  } catch {
    // chmod failed (Windows, foreign filesystem, missing capability) —
    // log once and proceed; we don't want to block a runtime read on a
    // best-effort hardening step.
    healedPathsThisProcess.add(path);
    return 'ok';
  }
}

/**
 * Test helper — clear the per-process heal cache so each test sees a
 * fresh lifecycle for the same fixture path.
 */
export function __resetSensitiveFileHealCacheForTests(): void {
  healedPathsThisProcess.clear();
}
