/**
 * Retry policy for the local span sinks.
 *
 * WHY THIS EXISTS
 * ---------------
 * Both sink arms used to disable themselves permanently after the FIRST
 * write failure (`writeFailedOnce` in TypeScript, `WRITE_FAILED_ONCE` in
 * Rust). A single transient error — a directory that was momentarily
 * unwritable, a disk that was momentarily full — cost the process the
 * rest of its telemetry, silently: the report then said "no spans in
 * window", which is indistinguishable from an idle runtime.
 *
 * The policy here is the shared contract between the two arms:
 *
 *   - a failure does NOT disable the sink; it schedules the next attempt;
 *   - the delay grows exponentially with the number of consecutive
 *     failures, so a broken sink costs a bounded number of write attempts
 *     per minute instead of one per span;
 *   - a successful write resets the counter, so the sink recovers on its
 *     own as soon as the cause is gone;
 *   - the state is observable, because the report has to be able to say
 *     "the sink is degraded" instead of "there is no telemetry".
 *
 * The delay schedule is mirrored in Rust (`crates/memphis-operator/src/
 * telemetry.rs`) and both arms are checked against
 * `tests/fixtures/telemetry-sink-status-contract.json`, so the two
 * implementations cannot drift apart silently.
 */

/** First retry delay after a single failure. */
export const SINK_RETRY_BASE_MS = 1_000;

/** Upper bound of the retry delay. */
export const SINK_RETRY_MAX_MS = 60_000;

/** How many consecutive failures are counted before the delay caps. */
export const SINK_RETRY_MULTIPLIER = 2;

export interface SinkRetryState {
  /** Consecutive failed write attempts; 0 while the sink is healthy. */
  consecutiveFailures: number;
  /** Epoch ms of the next allowed write attempt, or null when healthy. */
  nextAttemptAtMs: number | null;
  /** The last write error, verbatim. */
  lastError: string | null;
  /** Epoch ms of the last failed attempt, or null. */
  lastFailureAtMs: number | null;
  /** Epoch ms of the last successful write, or null. */
  lastSuccessAtMs: number | null;
}

export function initialSinkRetryState(): SinkRetryState {
  return {
    consecutiveFailures: 0,
    nextAttemptAtMs: null,
    lastError: null,
    lastFailureAtMs: null,
    lastSuccessAtMs: null,
  };
}

/**
 * The delay before the next attempt after `consecutiveFailures` failures.
 *
 * 1 failure → 1s, 2 → 2s, 3 → 4s, … capped at `maxMs`. The count is
 * 1-based: the delay after the first failure is the base delay.
 */
export function sinkRetryDelayMs(
  consecutiveFailures: number,
  baseMs: number = SINK_RETRY_BASE_MS,
  maxMs: number = SINK_RETRY_MAX_MS,
): number {
  if (!Number.isFinite(consecutiveFailures) || consecutiveFailures < 1) return 0;
  const exponent = Math.min(Math.floor(consecutiveFailures) - 1, 32);
  const delay = baseMs * SINK_RETRY_MULTIPLIER ** exponent;
  return Math.min(delay, maxMs);
}

/** True when the sink may attempt a write at `nowMs`. */
export function sinkMayAttempt(state: SinkRetryState, nowMs: number): boolean {
  if (state.nextAttemptAtMs === null) return true;
  return nowMs >= state.nextAttemptAtMs;
}

/** The state after a failed write attempt. */
export function sinkRecordFailure(
  state: SinkRetryState,
  nowMs: number,
  error: string,
  baseMs: number = SINK_RETRY_BASE_MS,
  maxMs: number = SINK_RETRY_MAX_MS,
): SinkRetryState {
  const consecutiveFailures = state.consecutiveFailures + 1;
  return {
    consecutiveFailures,
    nextAttemptAtMs: nowMs + sinkRetryDelayMs(consecutiveFailures, baseMs, maxMs),
    lastError: error,
    lastFailureAtMs: nowMs,
    lastSuccessAtMs: state.lastSuccessAtMs,
  };
}

/** The state after a successful write attempt. */
export function sinkRecordSuccess(state: SinkRetryState, nowMs: number): SinkRetryState {
  return {
    consecutiveFailures: 0,
    nextAttemptAtMs: null,
    lastError: null,
    lastFailureAtMs: state.lastFailureAtMs,
    lastSuccessAtMs: nowMs,
  };
}
