/**
 * Graceful shutdown coordinator (Phase 1.1 of production sprint).
 *
 * Hooks SIGTERM / SIGINT on the main app process so an external
 * shutdown (`systemctl stop memphis`, `docker stop`, container kill)
 * gets the same drain-and-flush treatment as an operator-initiated
 * `/restart`. Without this, those external stops drop in-flight turns
 * mid-execution, may leave torn writes to the chain or vault, and
 * fail to record a clean PULSE seam.
 *
 * Flow on signal:
 *   1. Mark `/v1/ops/status` as `shutting_down` (operators / pollers see it)
 *   2. Write a `system.shutdown.signal` security audit entry
 *   3. Signal in-flight turn controllers to abort (drain)
 *   4. Wait up to MEMPHIS_SHUTDOWN_DRAIN_TIMEOUT_MS for in-flight to finish
 *   5. Stop background loops (reflection, chain rotation, watchdog)
 *   6. Flush PULSE with `event=heartbeat` + `detail=shutdown`
 *   7. Shutdown OTel SDK (flushes any pending spans)
 *   8. process.exit with the right code (0 on clean drain, 75 if
 *      drain timed out — supervisor restarts the process)
 *
 * Idempotent: a second signal during shutdown is logged and ignored
 * (typical when an operator hits Ctrl-C twice impatiently).
 */

import { writePulseEvent } from './heartbeat-watchdog.js';
import { activeTurnCount, signalDrain } from './self-restart.js';
import type { AppLogger } from '../logging/logger.js';
import { writeSecurityAudit } from '../logging/security-audit.js';
import { shutdownOtel } from '../observability/otel.js';

/**
 * Default per-stopper timeout. Codex Round 6 P1 (PR #119): without a
 * per-stopper bound, one hung close() (e.g. a Fastify server with open
 * connections) blocked the entire shutdown sequence forever and we
 * never reached PULSE/OTel completion or exitFn.
 */
export const DEFAULT_STOPPER_TIMEOUT_MS = 5_000;

export const DEFAULT_SHUTDOWN_DRAIN_TIMEOUT_MS = 15_000;

export type ShutdownReason = 'SIGTERM' | 'SIGINT' | 'manual' | 'request-restart';

export interface ShutdownState {
  shuttingDown: boolean;
  startedAt?: string;
  reason?: ShutdownReason;
  drainTimeoutMs?: number;
  inFlightAtStart?: number;
  remainingAfterDrain?: number;
}

export interface GracefulShutdownOptions {
  rawEnv?: NodeJS.ProcessEnv;
  /** Test seam: substitute exit. */
  exitFn?: (code: number) => never;
  /** Test seam: substitute the audit writer. */
  auditFn?: typeof writeSecurityAudit;
  /** Test seam: substitute the PULSE writer. */
  pulseFn?: typeof writePulseEvent;
  /** Test seam: substitute the OTel shutdown hook. */
  otelShutdownFn?: () => Promise<void>;
  /**
   * Stoppers for background loops (reflection, chain rotation, watchdog,
   * worker, scheduler). Each is called concurrently after drain begins.
   * Failures are logged + swallowed; one stuck loop must not prevent shutdown.
   */
  stopFns?: Array<{ name: string; stop: () => void | Promise<void> }>;
  /**
   * Per-stopper timeout. Codex Round 6 P1 (PR #119): a hung stopper
   * must not block the whole shutdown. Default 5s per stopper.
   */
  stopperTimeoutMs?: number;
  /** Optional logger; if absent, structured stderr writes are used. */
  logger?: AppLogger;
}

let state: ShutdownState = { shuttingDown: false };
let installed = false;

function readDrainTimeoutMs(rawEnv: NodeJS.ProcessEnv): number {
  const raw = rawEnv.MEMPHIS_SHUTDOWN_DRAIN_TIMEOUT_MS?.trim();
  if (!raw) return DEFAULT_SHUTDOWN_DRAIN_TIMEOUT_MS;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 5 * 60_000) {
    return DEFAULT_SHUTDOWN_DRAIN_TIMEOUT_MS;
  }
  return parsed;
}

async function waitForDrain(
  timeoutMs: number,
): Promise<{ drained: boolean; remaining: number }> {
  if (activeTurnCount() === 0) return { drained: true, remaining: 0 };
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (activeTurnCount() === 0) return { drained: true, remaining: 0 };
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const remaining = activeTurnCount();
  return { drained: remaining === 0, remaining };
}

function logLine(
  logger: AppLogger | undefined,
  level: 'info' | 'warn' | 'error',
  obj: Record<string, unknown>,
  msg: string,
): void {
  if (logger) {
    logger[level](obj, msg);
  } else {
    process.stderr.write(`${JSON.stringify({ level, msg, ...obj })}\n`);
  }
}

/**
 * Run the full shutdown sequence. Exits the process at the end; returns
 * only in tests where exitFn is stubbed.
 */
export async function performGracefulShutdown(
  reason: ShutdownReason,
  options: GracefulShutdownOptions = {},
): Promise<void> {
  if (state.shuttingDown) {
    logLine(
      options.logger,
      'warn',
      { event: 'shutdown.duplicate-signal', reason },
      'shutdown already in progress; ignoring duplicate signal',
    );
    return;
  }

  const rawEnv = options.rawEnv ?? process.env;
  const exitFn = options.exitFn ?? ((code: number) => process.exit(code));
  const audit = options.auditFn ?? writeSecurityAudit;
  const pulse = options.pulseFn ?? writePulseEvent;
  const otelShutdown = options.otelShutdownFn ?? shutdownOtel;
  const drainTimeoutMs = readDrainTimeoutMs(rawEnv);

  const startedAt = new Date().toISOString();
  const inFlight = activeTurnCount();
  state = {
    shuttingDown: true,
    startedAt,
    reason,
    drainTimeoutMs,
    inFlightAtStart: inFlight,
  };

  logLine(
    options.logger,
    'info',
    { event: 'shutdown.start', reason, inFlight, drainTimeoutMs },
    `graceful shutdown started (${inFlight} in-flight turns; drain budget ${drainTimeoutMs}ms)`,
  );

  // 1. Audit
  try {
    audit({
      action: 'system.shutdown.signal',
      status: 'allowed',
      details: { reason, drainTimeoutMs, inFlightAtStart: inFlight },
    });
  } catch {
    // best-effort
  }

  // 2. Signal every registered turn controller to abort (Codex Round 6
  //    P2 fix — previously we only polled activeTurnCount, so turns
  //    that depended on the abort signal to unwind hit the timeout
  //    unnecessarily. Now we tell them explicitly, then wait.)
  try {
    signalDrain(`graceful shutdown (${reason})`);
  } catch {
    // signalDrain is best-effort; we proceed with the poll regardless
  }
  const { drained, remaining } = await waitForDrain(drainTimeoutMs);
  state.remainingAfterDrain = remaining;
  if (!drained) {
    logLine(
      options.logger,
      'warn',
      { event: 'shutdown.drain.timeout', remaining },
      `drain window exceeded; ${remaining} turns still in flight`,
    );
  }

  // 3. Stop background loops in parallel, each bounded by a timeout
  //    so one hung close() doesn't block the whole shutdown sequence
  //    (Codex Round 6 P1 fix on PR #119).
  const stoppers = options.stopFns ?? [];
  const stopperTimeoutMs =
    options.stopperTimeoutMs ?? DEFAULT_STOPPER_TIMEOUT_MS;
  await Promise.all(
    stoppers.map(async ({ name, stop }) => {
      try {
        await Promise.race([
          Promise.resolve().then(() => stop()),
          new Promise<void>((_, reject) => {
            const timer = setTimeout(
              () =>
                reject(
                  new Error(
                    `stopper '${name}' did not complete within ${stopperTimeoutMs}ms`,
                  ),
                ),
              stopperTimeoutMs,
            );
            if (typeof timer === 'object' && 'unref' in timer) timer.unref?.();
          }),
        ]);
      } catch (err) {
        logLine(
          options.logger,
          'warn',
          {
            event: 'shutdown.stop-loop.failed',
            name,
            error: err instanceof Error ? err.message : String(err),
          },
          `failed to stop background loop ${name}`,
        );
      }
    }),
  );

  // 4. Final PULSE — keeps the heartbeat history continuous across shutdown
  try {
    pulse({
      timestamp: new Date().toISOString(),
      event: 'heartbeat',
      health: drained ? 'healthy' : 'degraded',
      uptimeSeconds: Math.floor(process.uptime()),
      detail: `shutdown reason=${reason} drained=${drained} remaining=${remaining}`,
    });
  } catch {
    // best-effort
  }

  // 5. Shutdown OTel (flushes pending spans)
  try {
    await otelShutdown();
  } catch {
    // best-effort
  }

  // 6. Exit. Drain success → 0 (clean stop). Drain timeout → 75 (EX_TEMPFAIL)
  // so the supervisor restarts the process and we don't leave a half-dead
  // service behind.
  const exitCode = drained ? 0 : 75;
  logLine(
    options.logger,
    'info',
    { event: 'shutdown.exit', exitCode, drained },
    `shutdown complete; exiting ${exitCode}`,
  );
  exitFn(exitCode);
}

const installedHandlers: Array<{ signal: NodeJS.Signals; handler: () => void }> = [];

/**
 * Install signal handlers. Idempotent — re-calling is a no-op.
 *
 * Codex Round 6 P1 fix (PR #119): uses `process.on` (persistent)
 * instead of `process.once` so a SECOND signal during shutdown still
 * hits our handler (which ignores it via the `shuttingDown` guard)
 * rather than Node's default "terminate immediately" behavior. The
 * old code meant an impatient double-Ctrl-C killed the process
 * mid-drain and defeated the whole point of the graceful path.
 */
export function installShutdownHandlers(options: GracefulShutdownOptions = {}): void {
  if (installed) return;
  installed = true;

  const handler = (reason: ShutdownReason) => () => {
    void performGracefulShutdown(reason, options);
  };

  const sigterm = handler('SIGTERM');
  const sigint = handler('SIGINT');
  process.on('SIGTERM', sigterm);
  process.on('SIGINT', sigint);
  installedHandlers.push({ signal: 'SIGTERM', handler: sigterm });
  installedHandlers.push({ signal: 'SIGINT', handler: sigint });
}

/** Snapshot for /status payloads. */
export function getShutdownState(): ShutdownState {
  return { ...state };
}

/** Test-only: clear state so handlers can be reinstalled. */
export function __resetShutdownStateForTests(): void {
  state = { shuttingDown: false };
  installed = false;
  // Detach any handlers we installed — tests re-install fresh.
  for (const h of installedHandlers.splice(0)) {
    process.off(h.signal, h.handler);
  }
}
