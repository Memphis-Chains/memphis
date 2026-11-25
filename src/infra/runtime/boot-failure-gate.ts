/**
 * The boot-failure gate — a runtime that is crash-looping must not keep
 * starting.
 *
 * WHY THIS EXISTS
 * ---------------
 * Postmortem item B3 (docs/postmortems/2026-09-22-chains-halt-invalid-block-shape.md):
 *
 *     "B3. `memphis doctor` should refuse `start` when
 *      `boot-failures.json` had > 5 entries in the last 10 minutes.
 *      Currently the service keeps restarting regardless of the JSON file
 *      that exists exactly for this purpose."
 *
 * MEASURED 2026-09-22 on the operator's host: the incident opened with a
 * boot loop — 50+ failed restarts in the first three minutes, continuing
 * every ~5 s, and `boot-failures.json` grew to 50 entries. The file was
 * written for exactly this purpose, and nothing read it at the point
 * where reading it would have mattered: the START.
 *
 * The counter itself already exists (`self-modify-revert.ts`): every boot
 * attempt is recorded before the risky initialisation, and a successful
 * boot clears it. So the signal is there; what was missing is the rule
 * that turns it into a refusal.
 *
 * THE RULE
 * --------
 * More than five boot failures in the last ten minutes means the runtime
 * is crash-looping, and a crash loop that keeps restarting hides the
 * cause behind the noise of the restarts. The runtime refuses to start
 * and says why.
 *
 * The refusal exits with 102 (`ERR_CORRUPTION`), which is in the unit's
 * `RestartPreventExitStatus=101 102 103` — so systemd does NOT restart
 * it. The service stays down, visibly, with the reason in the log. That
 * is the point: the operator sees the failure instead of a service that
 * flickers.
 *
 * THE ESCAPE
 * ----------
 * The counter is cleared by a successful boot, so the gate does not
 * fire on a runtime that starts cleanly — it fires only on a runtime
 * that cannot start. The operator fixes the cause and removes the
 * counter: `rm ~/.memphis/state/boot-failures.json`. The message names
 * the file.
 *
 * This is a different rule from the self-modify auto-revert, which
 * watches the SAME file with a different threshold and window (3
 * failures in 5 minutes) and a different action (roll back the last
 * self-modify). Both read one file; neither copies its path.
 */

import { existsSync, readFileSync } from 'node:fs';

import { bootFailurePath } from './self-modify-revert.js';

/** More than this many failures in the window means the runtime is looping. */
export const BOOT_FAILURE_GATE_THRESHOLD = 5;

/** The window the failures are counted in. */
export const BOOT_FAILURE_GATE_WINDOW_MS = 10 * 60 * 1000;

/** What the gate decided, and why. */
export interface BootFailureGateDecision {
  /** The runtime must not start. */
  refuseStart: boolean;
  /** How many failures fell inside the window. */
  failuresInWindow: number;
  /** The threshold that was applied. */
  threshold: number;
  /** The window that was applied, in milliseconds. */
  windowMs: number;
  /** The oldest failure inside the window. */
  oldestFailureAt?: string;
  /** The newest failure inside the window. */
  newestFailureAt?: string;
  /** Where the counter lives — the operator needs the path to clear it. */
  counterPath: string;
}

interface BootFailureRecord {
  failures?: Array<{ at?: string }>;
}

function readFailureTimestamps(path: string): string[] {
  if (!existsSync(path)) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as BootFailureRecord;
    const failures = Array.isArray(parsed.failures) ? parsed.failures : [];
    return failures
      .map((failure) => failure?.at)
      .filter((at): at is string => typeof at === 'string' && at.length > 0);
  } catch {
    // A counter that cannot be read is not evidence of a crash loop. The
    // runtime must not refuse to start because the FILE is broken — it
    // must refuse because the COUNT is high.
    return [];
  }
}

/**
 * Evaluate the gate. Pure: it reads the counter and decides, and changes
 * nothing.
 */
export function evaluateBootFailureGate(
  rawEnv: NodeJS.ProcessEnv = process.env,
  now: Date = new Date(),
): BootFailureGateDecision {
  const counterPath = bootFailurePath(rawEnv);
  const threshold = BOOT_FAILURE_GATE_THRESHOLD;
  const windowMs = BOOT_FAILURE_GATE_WINDOW_MS;

  const cutoff = now.getTime() - windowMs;
  const inWindow = readFailureTimestamps(counterPath)
    .map((at) => ({ at, ms: new Date(at).getTime() }))
    .filter((entry) => Number.isFinite(entry.ms) && entry.ms >= cutoff)
    .sort((left, right) => left.ms - right.ms);

  return {
    refuseStart: inWindow.length > threshold,
    failuresInWindow: inWindow.length,
    threshold,
    windowMs,
    oldestFailureAt: inWindow[0]?.at,
    newestFailureAt: inWindow[inWindow.length - 1]?.at,
    counterPath,
  };
}

/**
 * The operator-facing sentence. Kept next to the rule so the message and
 * the decision cannot drift apart.
 */
export function describeBootFailureGate(decision: BootFailureGateDecision): string {
  if (!decision.refuseStart) {
    return `${decision.failuresInWindow} boot failure(s) in the last ${String(
      decision.windowMs / 60_000,
    )} min — under the threshold of ${String(decision.threshold + 1)}`;
  }
  return (
    `${decision.failuresInWindow} boot failures in the last ${String(
      decision.windowMs / 60_000,
    )} min (threshold ${String(decision.threshold + 1)}) — ` +
    `the runtime is crash-looping and will not start again. ` +
    `Fix the cause, then remove ${decision.counterPath} to start it again.`
  );
}
