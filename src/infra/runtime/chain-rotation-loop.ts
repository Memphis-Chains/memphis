/**
 * Scheduled chain rotation loop (closes deferred item #5).
 *
 * Operator-driven `chain rotate` has shipped since Sprint 4. This loop
 * adds the "rotate on a schedule" half: when
 * `MEMPHIS_CHAIN_ROTATE_INTERVAL_MS` is set to a positive integer, the
 * loop calls `rotateAllChains()` on that interval. Default behaviour
 * (env unset) is no-op — operators opt in.
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
 */

import { createPinoLogger } from '../logging/pino.js';
import { rotateAllChains, type ChainRotationResult } from '../storage/chain-rotation.js';

const log = createPinoLogger({ level: process.env.LOG_LEVEL ?? 'info' });

/** Hard floor — anything below 60s is almost certainly a misconfiguration. */
export const MIN_INTERVAL_MS = 60_000;
/** Hard ceiling — 24 h. Beyond that, schedule via cron instead. */
export const MAX_INTERVAL_MS = 24 * 60 * 60 * 1000;

export interface ChainRotationLoopState {
  lastTickAt?: string;
  lastResults?: ChainRotationResult[];
  lastError?: string;
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
  const interval =
    options.intervalMs ??
    readIntervalFromEnv(rawEnv) ??
    null;

  const rotate = options.rotateFn ?? (() => rotateAllChains({ rawEnv }));
  const state: ChainRotationLoopState = {};

  const tickNow = async (): Promise<ChainRotationLoopState> => {
    try {
      const results = await rotate();
      state.lastTickAt = new Date().toISOString();
      state.lastResults = results;
      state.lastError = undefined;
      const rotated = results.filter((r) => r.rotated);
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
    } catch (err) {
      state.lastTickAt = new Date().toISOString();
      state.lastError = err instanceof Error ? err.message : String(err);
      log.warn(
        { event: 'chain.rotation.scheduled.error', error: state.lastError },
        'scheduled chain rotation failed',
      );
    } finally {
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
