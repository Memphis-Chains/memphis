/**
 * Exec failure budget — REV2 Temat 3.5 Warstwa 5.
 *
 * In-memory per-(surface, actorId) counter of consecutive non-zero exec
 * exit codes. The wisdom doctrine in the soul seed tells the agent to
 * stop blind-retrying after 3 failures; this module enforces it at the
 * runtime layer so a non-compliant LLM still gets stopped.
 *
 * Semantics:
 *   - Each non-zero exit increments the counter for that (surface, actor).
 *   - Each successful exec decrements (clamped at 0).
 *   - At counter >= MAX_CONSECUTIVE_FAILURES (3), the next exec attempt
 *     is refused with a structured error.
 *   - Counter resets when the actor's NEXT non-exec tool call fires
 *     (signal: "agent moved on from the failing exec loop"). Callers
 *     in the tool-executor invoke `resetOnNonExecToolCall(key)` at
 *     dispatch time for any non-`memphis_exec` tool.
 *
 * State is in-memory only — process restart resets every counter. The
 * intent is to break THIS conversation's retry loop, not a permanent
 * lockout.
 */

export const MAX_CONSECUTIVE_FAILURES = 3;

interface BudgetEntry {
  failures: number;
  lastUpdate: number;
}

const buckets = new Map<string, BudgetEntry>();

function keyFor(surface: string | undefined, actorId: string | undefined): string {
  return `${surface ?? 'unknown'}::${actorId ?? 'unknown'}`;
}

export interface ExecFailureBudgetKey {
  surface?: string;
  actorId?: string;
}

export function recordExecOutcome(
  identity: ExecFailureBudgetKey,
  exitCode: number,
): void {
  const key = keyFor(identity.surface, identity.actorId);
  const current = buckets.get(key) ?? { failures: 0, lastUpdate: Date.now() };
  if (exitCode === 0) {
    current.failures = Math.max(0, current.failures - 1);
  } else {
    current.failures += 1;
  }
  current.lastUpdate = Date.now();
  buckets.set(key, current);
}

export function isExecBlockedForBudget(identity: ExecFailureBudgetKey): boolean {
  const entry = buckets.get(keyFor(identity.surface, identity.actorId));
  if (!entry) return false;
  return entry.failures >= MAX_CONSECUTIVE_FAILURES;
}

export function getConsecutiveFailures(identity: ExecFailureBudgetKey): number {
  return buckets.get(keyFor(identity.surface, identity.actorId))?.failures ?? 0;
}

/**
 * Reset signal: the actor invoked some non-exec tool, which means
 * they're moving on from the failing retry loop. Clears the counter
 * so the next exec attempt isn't pre-emptively blocked.
 *
 * Called from tool-executor when dispatching ANY tool whose name
 * isn't `memphis_exec`.
 */
export function resetOnNonExecToolCall(identity: ExecFailureBudgetKey): void {
  buckets.delete(keyFor(identity.surface, identity.actorId));
}

/**
 * Operator-facing reset (e.g. /tier revoke clears state; also used by
 * tests). Wipes all buckets — use sparingly outside test paths.
 */
export function resetAllExecBudgetsForTests(): void {
  buckets.clear();
}

export function describeBudgetRefusal(identity: ExecFailureBudgetKey): string {
  const n = getConsecutiveFailures(identity);
  return (
    `${n} consecutive exec failures hit the safety budget ` +
    `(max ${MAX_CONSECUTIVE_FAILURES}). Stop blind-retrying. ` +
    `Re-analyze the approach, run memphis_exec_analyze on the next ` +
    `attempt, or ask the operator for guidance. The counter resets ` +
    `when you invoke any non-exec tool (signals you moved on).`
  );
}
