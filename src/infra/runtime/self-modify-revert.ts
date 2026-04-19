/**
 * Self-modify boot-failure auto-revert (Phase 2.3 production sprint).
 *
 * `memphis_self_modify` has content scanning + a test-gate before
 * commit (good). But if a committed modification breaks STARTUP
 * (import crash, syntax-valid-but-runtime-fatal), the agent doesn't
 * boot and nothing rolls back. The whole point of self-modify is
 * autonomy; one bad self-modification turns autonomy into a brick.
 *
 * Approach:
 *
 * 1. Every successful self-modify commit writes a marker file recording
 *    the commit hash, timestamp, and the "previous known-good" hash
 *    (HEAD before the commit).
 *
 * 2. At BOOT, we read this marker. If we see it AND the boot has
 *    failed N times in M minutes (tracked in a separate boot-failure
 *    counter file), we revert HEAD to the previous-known-good hash via
 *    `git reset --hard <prev>` and write a security-audit + alert.
 *
 * 3. Boot success clears the failure counter.
 *
 * The signal "boot failed N times" comes from a sidecar boot-counter
 * that bootstrap.ts writes BEFORE doing anything risky. If bootstrap
 * crashes mid-init, the counter persists; if it completes, the counter
 * is reset. Net effect: the next process to start counts the prior
 * crash and decides whether to revert.
 *
 * Env:
 *   MEMPHIS_SELF_MODIFY_REVERT_AFTER_BOOT_FAILURES   — default 3
 *   MEMPHIS_SELF_MODIFY_REVERT_WINDOW_MS              — default 5 min
 *   MEMPHIS_SELF_MODIFY_AUTO_REVERT                   — default true
 *
 * The boot-counter check runs ASAP in bootstrap so a crash loop is
 * caught fast (rather than after the operator notices and SSH'es in).
 */

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { writeSecurityAudit } from '../logging/security-audit.js';

export const DEFAULT_REVERT_AFTER_FAILURES = 3;
export const DEFAULT_REVERT_WINDOW_MS = 5 * 60 * 1000;

interface SelfModifyMarker {
  commitHash: string;
  previousHash: string;
  intent: string;
  committedAt: string;
}

interface BootFailureRecord {
  failures: Array<{ at: string }>;
}

function markerPath(rawEnv: NodeJS.ProcessEnv = process.env): string {
  const dataDir = rawEnv.MEMPHIS_DATA_DIR ?? join(process.env.HOME ?? '/tmp', '.memphis');
  return join(dataDir, 'state', 'last-self-modify.json');
}

function bootFailurePath(rawEnv: NodeJS.ProcessEnv = process.env): string {
  const dataDir = rawEnv.MEMPHIS_DATA_DIR ?? join(process.env.HOME ?? '/tmp', '.memphis');
  return join(dataDir, 'state', 'boot-failures.json');
}

function readJson<T>(path: string): T | null {
  try {
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return null;
  }
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value), 'utf8');
}

/**
 * Called at the END of a successful self-modify commit. Persists the
 * "if this turns out to be bad, revert here" pointer so a later boot
 * crash loop can roll back.
 */
export function recordSelfModifyCommit(
  marker: { commitHash: string; previousHash: string; intent: string },
  rawEnv: NodeJS.ProcessEnv = process.env,
): void {
  const record: SelfModifyMarker = {
    ...marker,
    committedAt: new Date().toISOString(),
  };
  writeJson(markerPath(rawEnv), record);
}

/**
 * Called at the START of bootstrap (before risky init). Increments
 * the failure counter; if a prior boot completed successfully it
 * starts at 0.
 */
export function recordBootAttempt(rawEnv: NodeJS.ProcessEnv = process.env): void {
  const path = bootFailurePath(rawEnv);
  const existing = readJson<BootFailureRecord>(path) ?? { failures: [] };
  existing.failures.push({ at: new Date().toISOString() });
  // Cap to last 50 entries — anything past that is just history bloat.
  existing.failures = existing.failures.slice(-50);
  writeJson(path, existing);
}

/**
 * Record a boot attempt UNLESS the pre-bootstrap CLI wrapper already did.
 *
 * Production: `bin/memphis.js` records early (before dist imports) so
 * import-time crashes still bump the counter, and sets
 * MEMPHIS_BOOT_ATTEMPT_RECORDED=1 so we don't double-count here.
 *
 * Dev (tsx/test): the wrapper isn't in the path, so this records
 * normally. Prevents the "1 real crash = 2 counted attempts" bug that
 * would cross the auto-revert threshold one crash too early (Codex P1
 * on PR #141).
 */
export function maybeRecordBootAttempt(rawEnv: NodeJS.ProcessEnv = process.env): void {
  if (rawEnv.MEMPHIS_BOOT_ATTEMPT_RECORDED === '1') return;
  recordBootAttempt(rawEnv);
}

/**
 * Called at the END of successful bootstrap. Clears the failure
 * counter — we made it through.
 */
export function recordBootSuccess(rawEnv: NodeJS.ProcessEnv = process.env): void {
  try {
    const path = bootFailurePath(rawEnv);
    if (existsSync(path)) unlinkSync(path);
  } catch {
    // best-effort
  }
}

export interface AutoRevertDecision {
  shouldRevert: boolean;
  reason:
    | 'no-marker'
    | 'no-failures'
    | 'failures-below-threshold'
    | 'marker-too-old'
    | 'auto-revert-disabled'
    | 'will-revert';
  marker?: SelfModifyMarker;
  failuresInWindow: number;
  threshold: number;
  windowMs: number;
}

function readEnvBoolDefault(raw: string | undefined, defaultValue: boolean): boolean {
  if (!raw) return defaultValue;
  const lower = raw.trim().toLowerCase();
  if (lower === 'false' || lower === '0' || lower === 'no') return false;
  if (lower === 'true' || lower === '1' || lower === 'yes') return true;
  return defaultValue;
}

function readEnvInt(raw: string | undefined, defaultValue: number): number {
  if (!raw) return defaultValue;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1) return defaultValue;
  return parsed;
}

/**
 * Decide whether the current boot should auto-revert. Pure (no side
 * effects); call `performAutoRevert` to actually do it.
 */
export function evaluateAutoRevert(
  rawEnv: NodeJS.ProcessEnv = process.env,
  now: Date = new Date(),
): AutoRevertDecision {
  const enabled = readEnvBoolDefault(rawEnv.MEMPHIS_SELF_MODIFY_AUTO_REVERT, true);
  const threshold = readEnvInt(
    rawEnv.MEMPHIS_SELF_MODIFY_REVERT_AFTER_BOOT_FAILURES,
    DEFAULT_REVERT_AFTER_FAILURES,
  );
  const windowMs = readEnvInt(
    rawEnv.MEMPHIS_SELF_MODIFY_REVERT_WINDOW_MS,
    DEFAULT_REVERT_WINDOW_MS,
  );
  const marker = readJson<SelfModifyMarker>(markerPath(rawEnv));
  const failureRecord = readJson<BootFailureRecord>(bootFailurePath(rawEnv)) ?? {
    failures: [],
  };

  // Failures within the window
  const cutoff = now.getTime() - windowMs;
  const failuresInWindow = failureRecord.failures.filter(
    (f) => new Date(f.at).getTime() >= cutoff,
  ).length;

  if (!enabled) {
    return {
      shouldRevert: false,
      reason: 'auto-revert-disabled',
      marker: marker ?? undefined,
      failuresInWindow,
      threshold,
      windowMs,
    };
  }
  if (!marker) {
    return {
      shouldRevert: false,
      reason: 'no-marker',
      failuresInWindow,
      threshold,
      windowMs,
    };
  }
  if (failuresInWindow === 0) {
    return {
      shouldRevert: false,
      reason: 'no-failures',
      marker,
      failuresInWindow,
      threshold,
      windowMs,
    };
  }
  // Only revert if the marker is RECENT — i.e. committed within the
  // failure window. Otherwise the boot crash isn't the self-modify's
  // fault.
  const markerAge = now.getTime() - new Date(marker.committedAt).getTime();
  if (markerAge > windowMs) {
    return {
      shouldRevert: false,
      reason: 'marker-too-old',
      marker,
      failuresInWindow,
      threshold,
      windowMs,
    };
  }
  if (failuresInWindow < threshold) {
    return {
      shouldRevert: false,
      reason: 'failures-below-threshold',
      marker,
      failuresInWindow,
      threshold,
      windowMs,
    };
  }
  return {
    shouldRevert: true,
    reason: 'will-revert',
    marker,
    failuresInWindow,
    threshold,
    windowMs,
  };
}

/**
 * Actually perform the revert. `git reset --hard <previousHash>` in
 * the project root + clear the marker + log + audit.
 */
export async function performAutoRevert(
  decision: AutoRevertDecision,
  options: {
    projectRoot?: string;
    rawEnv?: NodeJS.ProcessEnv;
    /** Test seam: substitute the git operation. */
    gitResetFn?: (previousHash: string, projectRoot: string) => Promise<void>;
  } = {},
): Promise<{ ok: boolean; revertedTo?: string; error?: string }> {
  if (!decision.shouldRevert || !decision.marker) {
    return { ok: false, error: 'evaluateAutoRevert did not request a revert' };
  }
  const rawEnv = options.rawEnv ?? process.env;
  const projectRoot = options.projectRoot ?? process.cwd();
  const gitReset =
    options.gitResetFn ??
    (async (hash: string, root: string) => {
      const { execFile } = await import('node:child_process');
      const { promisify } = await import('node:util');
      const execFileAsync = promisify(execFile);
      await execFileAsync('git', ['reset', '--hard', hash], { cwd: root });
    });

  try {
    await gitReset(decision.marker.previousHash, projectRoot);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    writeSecurityAudit({
      action: 'self_modify.auto_revert.failed',
      status: 'blocked',
      details: {
        previousHash: decision.marker.previousHash,
        commitHash: decision.marker.commitHash,
        error: message,
      },
    });
    return { ok: false, error: message };
  }

  // Clear marker so a second boot doesn't try to re-revert
  try {
    unlinkSync(markerPath(rawEnv));
  } catch {
    // best-effort
  }
  // Clear failure counter — we just intervened, give the new (reverted)
  // process a clean slate
  try {
    unlinkSync(bootFailurePath(rawEnv));
  } catch {
    // best-effort
  }

  writeSecurityAudit({
    action: 'self_modify.auto_revert.executed',
    status: 'allowed',
    details: {
      revertedFrom: decision.marker.commitHash,
      revertedTo: decision.marker.previousHash,
      intent: decision.marker.intent,
      failuresInWindow: decision.failuresInWindow,
    },
  });

  return { ok: true, revertedTo: decision.marker.previousHash };
}

/** Test-only: reset both state files. */
export function __resetSelfModifyRevertForTests(rawEnv: NodeJS.ProcessEnv = process.env): void {
  try {
    unlinkSync(markerPath(rawEnv));
  } catch {
    /* noop */
  }
  try {
    unlinkSync(bootFailurePath(rawEnv));
  } catch {
    /* noop */
  }
}
