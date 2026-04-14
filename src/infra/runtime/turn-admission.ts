/**
 * Concurrent-turn admission control with user-visible queue (Phase 2.2).
 *
 * Without this, a Telegram message flood → N simultaneous LLM calls →
 * OOM risk + provider rate-limit cascade. The runtime tracks turn
 * controllers for drain but doesn't admission-control them. One spam
 * wave is one bad day away from an OOM kill.
 *
 * Approach: semaphore that admits up to `MEMPHIS_MAX_CONCURRENT_TURNS`
 * (default 10) at a time. Excess turns wait in a FIFO queue. When a
 * caller is queued, they get a synchronous `queuePosition` they can
 * surface back to the user ("queued, 3 ahead, ~15s wait").
 *
 * Hard ceiling: when the queue depth exceeds
 * `MEMPHIS_MAX_QUEUED_TURNS` (default 50), new turns are REJECTED with
 * a clear message. Better fast-fail than slow-fail at this load.
 *
 * /v1/ops/status surfaces queue depth + active count so operators see
 * "we're under load" before hitting the rejection threshold.
 */

import { AppError } from '../../core/errors.js';

export const DEFAULT_MAX_CONCURRENT_TURNS = 10;
export const DEFAULT_MAX_QUEUED_TURNS = 50;

export interface AdmissionTicket {
  /** Position the caller was at when admission started: 0 = ran immediately,
   *  N = N callers ahead at the moment of queue entry. */
  queuePositionAtEntry: number;
  /** Estimated wait at entry (rough — uses the rolling ema). */
  estimatedWaitMs: number;
  /** Release the slot back to the semaphore. MUST be called in finally. */
  release: () => void;
  /** Acquired-at, for telemetry. */
  acquiredAt: number;
}

export interface AdmissionState {
  active: number;
  queued: number;
  totalAdmitted: number;
  totalRejected: number;
  totalQueued: number;
  emaTurnDurationMs: number;
}

interface QueueEntry {
  resolve: (ticket: AdmissionTicket) => void;
  reject: (err: Error) => void;
  enqueuedAt: number;
}

const state: AdmissionState = {
  active: 0,
  queued: 0,
  totalAdmitted: 0,
  totalRejected: 0,
  totalQueued: 0,
  emaTurnDurationMs: 1000, // seed; rolling EMA updates as turns complete
};

const waitQueue: QueueEntry[] = [];

function readMaxConcurrent(rawEnv: NodeJS.ProcessEnv): number {
  const raw = rawEnv.MEMPHIS_MAX_CONCURRENT_TURNS?.trim();
  if (!raw) return DEFAULT_MAX_CONCURRENT_TURNS;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1 || parsed > 1000) {
    return DEFAULT_MAX_CONCURRENT_TURNS;
  }
  return parsed;
}

function readMaxQueued(rawEnv: NodeJS.ProcessEnv): number {
  const raw = rawEnv.MEMPHIS_MAX_QUEUED_TURNS?.trim();
  if (!raw) return DEFAULT_MAX_QUEUED_TURNS;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100_000) {
    return DEFAULT_MAX_QUEUED_TURNS;
  }
  return parsed;
}

function admitOne(): void {
  // Called when a slot frees up — pump the queue.
  // Codex Round 6 P1 fix (PR #123): re-read the cap here so hot
  // changes to MEMPHIS_MAX_CONCURRENT_TURNS actually take effect
  // while a backlog exists. Without this, operators could `/config
  // set MEMPHIS_MAX_CONCURRENT_TURNS=50` and throughput would stay
  // at the old cap until the queue drained on its own.
  const maxConcurrent = readMaxConcurrent(process.env);
  // Respect the current cap — if a release frees a slot but the cap
  // was just lowered below the active count, DON'T admit the next
  // waiter. Let the queue drain naturally as more releases happen.
  if (state.active >= maxConcurrent) return;
  const next = waitQueue.shift();
  if (!next) return;
  state.queued -= 1;
  const acquiredAt = Date.now();
  state.active += 1;
  state.totalAdmitted += 1;
  next.resolve({
    queuePositionAtEntry: 0, // they were the head when slot freed
    estimatedWaitMs: acquiredAt - next.enqueuedAt,
    release: makeRelease(acquiredAt),
    acquiredAt,
  });
  // Cap may have been raised — keep pumping until we reach it or
  // the queue is empty. This is the "raise 1→10 takes effect
  // immediately" half of the fix.
  if (state.active < maxConcurrent && waitQueue.length > 0) {
    admitOne();
  }
}

function makeRelease(acquiredAt: number): () => void {
  let released = false;
  return () => {
    if (released) return;
    released = true;
    state.active -= 1;
    // Update EMA on actual duration so estimatedWaitMs gets more accurate
    const duration = Math.max(50, Date.now() - acquiredAt);
    state.emaTurnDurationMs = Math.round(
      0.7 * state.emaTurnDurationMs + 0.3 * duration,
    );
    admitOne();
  };
}

/**
 * Acquire a turn admission slot. Resolves immediately when below the
 * concurrency cap; otherwise queues. Rejects when the queue itself is
 * full (over the configured ceiling).
 *
 * Caller MUST call `ticket.release()` in finally — otherwise the slot
 * leaks.
 */
export async function acquireTurnSlot(
  rawEnv: NodeJS.ProcessEnv = process.env,
): Promise<AdmissionTicket> {
  const maxConcurrent = readMaxConcurrent(rawEnv);
  const maxQueued = readMaxQueued(rawEnv);

  // Fast path: under cap, no queue
  if (state.active < maxConcurrent && waitQueue.length === 0) {
    const acquiredAt = Date.now();
    state.active += 1;
    state.totalAdmitted += 1;
    return {
      queuePositionAtEntry: 0,
      estimatedWaitMs: 0,
      release: makeRelease(acquiredAt),
      acquiredAt,
    };
  }

  // Queue-rejection path: too many already waiting
  if (waitQueue.length >= maxQueued) {
    state.totalRejected += 1;
    throw new AppError(
      'PROVIDER_RATE_LIMIT',
      `turn admission refused — ${state.active} active + ${waitQueue.length} queued (cap ${maxConcurrent} active / ${maxQueued} queued). Try again in a few seconds.`,
      429,
      {
        active: state.active,
        queued: waitQueue.length,
        maxConcurrent,
        maxQueued,
      },
    );
  }

  // Queue
  const positionAtEntry = waitQueue.length; // 0 = next up
  const enqueuedAt = Date.now();
  state.queued += 1;
  state.totalQueued += 1;

  return new Promise<AdmissionTicket>((resolve, reject) => {
    waitQueue.push({
      resolve: (ticket) => {
        // Override the positionAtEntry with what we observed at enqueue
        resolve({
          ...ticket,
          queuePositionAtEntry: positionAtEntry,
          estimatedWaitMs: positionAtEntry * state.emaTurnDurationMs,
        });
      },
      reject,
      enqueuedAt,
    });
  });
}

/**
 * For surfaces (Telegram) that want a synchronous "you're queued" hint
 * BEFORE awaiting acquireTurnSlot — peek at the current queue depth +
 * EMA so the user gets feedback fast.
 */
export function previewQueueState(): {
  active: number;
  queued: number;
  estimatedWaitMs: number;
  willQueue: boolean;
  willReject: boolean;
} {
  const env = process.env;
  const maxConcurrent = readMaxConcurrent(env);
  const maxQueued = readMaxQueued(env);
  const willQueue = state.active >= maxConcurrent;
  const willReject = willQueue && waitQueue.length >= maxQueued;
  // EstimatedWait = positionAheadOfYou * emaTurnDuration. If you're not
  // queued yet, your "position" is `queued` (you'd land at the back).
  const aheadOfYou = willQueue ? waitQueue.length : 0;
  return {
    active: state.active,
    queued: waitQueue.length,
    estimatedWaitMs: aheadOfYou * state.emaTurnDurationMs,
    willQueue,
    willReject,
  };
}

export function getAdmissionState(): AdmissionState {
  return { ...state, active: state.active, queued: waitQueue.length };
}

/** Test-only: clear queue + counters so a fresh test starts at zero. */
export function __resetTurnAdmissionForTests(): void {
  state.active = 0;
  state.queued = 0;
  state.totalAdmitted = 0;
  state.totalRejected = 0;
  state.totalQueued = 0;
  state.emaTurnDurationMs = 1000;
  while (waitQueue.length > 0) waitQueue.pop();
}
