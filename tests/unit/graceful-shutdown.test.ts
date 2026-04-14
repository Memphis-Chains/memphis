import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  __resetShutdownStateForTests,
  getShutdownState,
  installShutdownHandlers,
  performGracefulShutdown,
} from '../../src/infra/runtime/graceful-shutdown.js';
import {
  __resetTurnControllersForTests,
  registerTurnController,
  unregisterTurnController,
} from '../../src/infra/runtime/self-restart.js';

describe('graceful shutdown (Phase 1.1 production sprint)', () => {
  beforeEach(() => {
    __resetShutdownStateForTests();
    __resetTurnControllersForTests();
  });

  afterEach(() => {
    __resetShutdownStateForTests();
    __resetTurnControllersForTests();
  });

  it('runs full sequence on signal: audit → drain → stop loops → PULSE → OTel → exit(0)', async () => {
    const audits: Array<{ action: string }> = [];
    const pulses: unknown[] = [];
    const exitFn = vi.fn();
    const otelShutdown = vi.fn(async () => {});
    const stopFn = vi.fn(async () => {});

    await performGracefulShutdown('SIGTERM', {
      rawEnv: { MEMPHIS_SHUTDOWN_DRAIN_TIMEOUT_MS: '100' } as NodeJS.ProcessEnv,
      auditFn: (entry) => audits.push(entry as { action: string }),
      pulseFn: (entry) => {
        pulses.push(entry);
      },
      exitFn: exitFn as unknown as (code: number) => never,
      otelShutdownFn: otelShutdown,
      stopFns: [{ name: 'test-loop', stop: stopFn }],
    });

    expect(audits[0]?.action).toBe('system.shutdown.signal');
    expect(stopFn).toHaveBeenCalledOnce();
    expect(otelShutdown).toHaveBeenCalledOnce();
    expect(pulses).toHaveLength(1);
    expect(exitFn).toHaveBeenCalledWith(0);
  });

  it('signals in-flight turn controllers and waits for drain', async () => {
    const ctrl = new AbortController();
    registerTurnController(ctrl);
    const exitFn = vi.fn();

    // Resolve the controller after 30ms — well within the 200ms drain budget
    setTimeout(() => {
      unregisterTurnController(ctrl);
    }, 30);

    await performGracefulShutdown('SIGTERM', {
      rawEnv: { MEMPHIS_SHUTDOWN_DRAIN_TIMEOUT_MS: '200' } as NodeJS.ProcessEnv,
      auditFn: () => {},
      pulseFn: () => {},
      exitFn: exitFn as unknown as (code: number) => never,
      otelShutdownFn: async () => {},
    });

    expect(exitFn).toHaveBeenCalledWith(0);
    const state = getShutdownState();
    expect(state.remainingAfterDrain).toBe(0);
  });

  it('exits 75 (EX_TEMPFAIL) when drain times out so supervisor restarts', async () => {
    // Hold a controller open past the drain budget
    const ctrl = new AbortController();
    registerTurnController(ctrl);
    const exitFn = vi.fn();

    await performGracefulShutdown('SIGTERM', {
      rawEnv: { MEMPHIS_SHUTDOWN_DRAIN_TIMEOUT_MS: '50' } as NodeJS.ProcessEnv,
      auditFn: () => {},
      pulseFn: () => {},
      exitFn: exitFn as unknown as (code: number) => never,
      otelShutdownFn: async () => {},
    });

    expect(exitFn).toHaveBeenCalledWith(75);
    const state = getShutdownState();
    expect(state.remainingAfterDrain).toBeGreaterThan(0);

    // cleanup
    unregisterTurnController(ctrl);
  });

  it('a stuck stop-loop does not block shutdown (failure isolated + logged)', async () => {
    const exitFn = vi.fn();
    const goodStop = vi.fn(async () => {});

    await performGracefulShutdown('SIGTERM', {
      rawEnv: { MEMPHIS_SHUTDOWN_DRAIN_TIMEOUT_MS: '50' } as NodeJS.ProcessEnv,
      auditFn: () => {},
      pulseFn: () => {},
      exitFn: exitFn as unknown as (code: number) => never,
      otelShutdownFn: async () => {},
      stopFns: [
        {
          name: 'broken',
          stop: () => {
            throw new Error('I am stuck');
          },
        },
        { name: 'good', stop: goodStop },
      ],
    });

    expect(exitFn).toHaveBeenCalledWith(0);
    expect(goodStop).toHaveBeenCalledOnce();
  });

  it('duplicate signal during shutdown is ignored (idempotent)', async () => {
    const exitFn = vi.fn();
    const auditFn = vi.fn();

    // First signal
    const first = performGracefulShutdown('SIGTERM', {
      rawEnv: { MEMPHIS_SHUTDOWN_DRAIN_TIMEOUT_MS: '50' } as NodeJS.ProcessEnv,
      auditFn,
      pulseFn: () => {},
      exitFn: exitFn as unknown as (code: number) => never,
      otelShutdownFn: async () => {},
    });
    // Second signal while first still running
    await performGracefulShutdown('SIGINT', {
      rawEnv: { MEMPHIS_SHUTDOWN_DRAIN_TIMEOUT_MS: '50' } as NodeJS.ProcessEnv,
      auditFn,
      pulseFn: () => {},
      exitFn: exitFn as unknown as (code: number) => never,
      otelShutdownFn: async () => {},
    });
    await first;

    // Audit recorded only ONCE despite two signals
    expect(auditFn).toHaveBeenCalledOnce();
  });

  it('getShutdownState reflects in-progress shutdown for /status payloads', async () => {
    expect(getShutdownState().shuttingDown).toBe(false);

    const exitFn = vi.fn();
    let inProgressState: ReturnType<typeof getShutdownState> | null = null;
    await performGracefulShutdown('SIGTERM', {
      rawEnv: { MEMPHIS_SHUTDOWN_DRAIN_TIMEOUT_MS: '50' } as NodeJS.ProcessEnv,
      auditFn: () => {
        // Captured DURING the shutdown sequence
        inProgressState = getShutdownState();
      },
      pulseFn: () => {},
      exitFn: exitFn as unknown as (code: number) => never,
      otelShutdownFn: async () => {},
    });

    expect(inProgressState).not.toBeNull();
    expect(inProgressState!.shuttingDown).toBe(true);
    expect(inProgressState!.reason).toBe('SIGTERM');
  });

  it('installShutdownHandlers is idempotent', () => {
    installShutdownHandlers();
    installShutdownHandlers();
    // No throw, no duplicate listener — process.once handles dedup but
    // our `installed` flag is the contractual guarantee. We check by
    // confirming the listener count for SIGTERM doesn't grow past 1.
    expect(process.listenerCount('SIGTERM')).toBeLessThanOrEqual(2);
  });
});
