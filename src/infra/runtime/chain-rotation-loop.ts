/**
 * Scheduled chain rotation loop (closes deferred item #5).
 *
 * Operator-driven `chain rotate` is the other half: the command runs a
 * rotation on the operator's say-so, and this loop runs one on an
 * interval. When `MEMPHIS_CHAIN_ROTATE_INTERVAL_MS` is set to a positive
 * integer, the loop calls `rotateAllChains()` on that interval. Default
 * behaviour (env unset) is no-op — operators opt in.
 *
 * The loop reuses the existing rotation pipeline:
 *   - threshold check (`MEMPHIS_CHAIN_ROTATION_THRESHOLD_BYTES`, default
 *     50 MB)
 *   - snapshot before archive (`MEMPHIS_CHAIN_SNAPSHOT_ON_ROTATION`)
 *   - GC of stale archives (`MEMPHIS_CHAIN_GC_ENABLED`)
 *
 * Errors during a tick are logged and dropped — the loop keeps ticking
 * so a transient I/O failure on one chain doesn't disable rotation for
 * the rest.
 *
 * ## The loop says it ticked
 *
 * Every tick logs `chain.rotation.scheduled.start`, whether or not
 * anything was rotated.
 *
 * Measured 2026-11-23 on this host: the log held six
 * `chain.rotation.loop.started` events and not one
 * `chain.rotation.scheduled`, which reads as "the loop never ticks". The
 * loop HAD ticked, hourly, and every tick had found nothing to rotate —
 * because the threshold could not fire. The silence was the symptom, not
 * the cause.
 *
 * The scheduled backup already had this shape (`backup.scheduled.start`
 * on every tick); this loop now matches it.
 */

import { LOG_LEVEL } from '../../config/env-registry.js';
import { createPinoLogger } from '../logging/pino.js';
import { rotateAllChains, type ChainRotationResult } from '../storage/chain-rotation.js';

const log = createPinoLogger({ level: LOG_LEVEL.read(process.env) });

/** Hard floor — anything below 60s is almost certainly a misconfiguration. */
export const MIN_INTERVAL_MS = 60_000;
/** Hard ceiling — 24 h. Beyond that, schedule via cron instead. */
export const MAX_INTERVAL_MS = 24 * 60 * 60 * 1000;

export interface ChainRotationLoopState {
  lastTickAt?: string;
  lastResults?: ChainRotationResult[];
  lastError?: string;
  /** Populated when a tick was skipped because a prior tick was still running. */
  lastSkippedAt?: string;
  /** Total number of ticks skipped due to overlap since loop start. */
  skippedTickCount?: number;
}

export interface ChainRotationLoopOptions {
  rawEnv?: NodeJS.ProcessEnv;
  intervalMs?: number;
  /** Test seam: substitute the rotation function. */
  rotateFn?: () => Promise<ChainRotationResult[]>;
  /** Test seam: invoked on each tick (success or failure) for assertions. */
  onTick?: (state: ChainRotationLoopState) => void;
}

interface ChainRotationLoopHandle {
  stop: () => void;
  /** Tick once now (test/manual). */
  tickNow: () => Promise<ChainRotationLoopState>;
  /** Last observed state. */
  state: () => ChainRotationLoopState;
}

function readIntervalFromEnv(rawEnv: NodeJS.ProcessEnv): number | null {
  const raw = rawEnv.MEMPHIS_CHAIN_ROTATE_INTERVAL_MS?.trim();
  if (!raw) return null;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return null;
  if (parsed < MIN_INTERVAL_MS || parsed > MAX_INTERVAL_MS) return null;
  return Math.floor(parsed);
}

/**
 * Start the scheduled rotation loop. Returns a handle with `stop()` so
 * tests / shutdown hooks can tear it down.
 *
 * If `MEMPHIS_CHAIN_ROTATE_INTERVAL_MS` is unset / out of bounds and no
 * explicit `intervalMs` override was passed, the loop does NOT start —
 * the function returns a no-op handle.
 */
export function startChainRotationLoop(
  options: ChainRotationLoopOptions = {},
): ChainRotationLoopHandle {
  const rawEnv = options.rawEnv ?? process.env;
  const interval = options.intervalMs ?? readIntervalFromEnv(rawEnv) ?? null;

  const rotate = options.rotateFn ?? (() => rotateAllChains({ rawEnv }));
  const state: ChainRotationLoopState = {};

  // Codex Round 5 P2 fix: prevent overlapping ticks. A long-running
  // rotation must not be re-entered by the next interval tick — that
  // could race on the same archive files.
  let inFlight = false;
  let skippedCount = 0;

  const tickNow = async (): Promise<ChainRotationLoopState> => {
    if (inFlight) {
      skippedCount += 1;
      state.lastSkippedAt = new Date().toISOString();
      state.skippedTickCount = skippedCount;
      log.warn(
        { event: 'chain.rotation.scheduled.overlap', skippedCount },
        'scheduled chain rotation skipped — prior tick still running',
      );
      options.onTick?.(state);
      return state;
    }
    inFlight = true;
    try {
      // A heartbeat on EVERY tick.
      //
      // The loop used to log only when a chain actually rotated, so a
      // tick that found nothing to do was invisible. An operator could
      // not tell a working loop from a dead one — and the symptom of the
      // threshold bug looked exactly like a dead loop.
      //
      // Measured 2026-11-23 on this host: the log held six
      // `chain.rotation.loop.started` events and not one
      // `chain.rotation.scheduled`, which reads as "the loop never
      // ticks". The loop HAD ticked, hourly, and every tick had found
      // nothing to rotate — because the threshold could not fire. The
      // silence was the symptom, not the cause.
      //
      // The scheduled backup already had this shape (`backup.scheduled
      // .start` on every tick); the rotation loop now matches it.
      log.info(
        { event: 'chain.rotation.scheduled.start' },
        'scheduled chain rotation tick starting',
      );
      const results = await rotate();
      state.lastTickAt = new Date().toISOString();
      state.lastResults = results;
      state.lastError = undefined;
      const rotated = results.filter((r) => r.rotated);
      const perChainErrors = results.filter((r) => r.error);
      if (rotated.length > 0) {
        log.info(
          {
            event: 'chain.rotation.scheduled',
            rotatedChains: rotated.map((r) => r.chain),
            archivedBlocks: rotated.reduce((sum, r) => sum + r.archivedBlocks, 0),
          },
          'scheduled chain rotation completed',
        );
      }
      // Codex Round 5 P1 fix (per-chain isolation): surface individual
      // chain failures so a corrupt chain doesn't silently eat the
      // scheduled run.
      for (const entry of perChainErrors) {
        log.warn(
          {
            event: 'chain.rotation.scheduled.chain-failed',
            chain: entry.chain,
            error: entry.error,
          },
          'chain rotation failed for one chain; others proceeded',
        );
      }
    } catch (err) {
      state.lastTickAt = new Date().toISOString();
      state.lastError = err instanceof Error ? err.message : String(err);
      log.warn(
        { event: 'chain.rotation.scheduled.error', error: state.lastError },
        'scheduled chain rotation failed',
      );
    } finally {
      inFlight = false;
      options.onTick?.(state);
    }
    return state;
  };

  if (interval === null) {
    return {
      stop: () => {},
      tickNow,
      state: () => state,
    };
  }

  const timer = setInterval(() => void tickNow(), interval);
  if (typeof timer === 'object' && 'unref' in timer) {
    timer.unref();
  }

  log.info(
    { event: 'chain.rotation.loop.started', intervalMs: interval },
    'scheduled chain rotation loop started',
  );

  return {
    stop: () => clearInterval(timer),
    tickNow,
    state: () => state,
  };
}
