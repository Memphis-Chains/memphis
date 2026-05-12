/**
 * Unit tests for the auto-installed NAPI exit guard. The integration
 * stress test (`tests/integration/script-shutdown-segv-stress.test.ts`)
 * spawns real subprocesses and asserts no SIGSEGV; this file pins the
 * registration semantics: idempotency, handler invocation, test-seam
 * substitution, missing-bridge-export tolerance.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { __resetEmbedShutdownStateForTests } from '../../src/infra/runtime/embed-shutdown-state.js';
import {
  __isNapiShutdownGuardInstalled,
  __resetNapiShutdownGuardForTests,
  installNapiShutdownGuard,
} from '../../src/infra/runtime/napi-shutdown.js';

describe('installNapiShutdownGuard', () => {
  beforeEach(() => {
    __resetNapiShutdownGuardForTests();
    // Temat 2 dedup: the process-wide `embed-shutdown-state` flag
    // persists across vitest test instances within the same worker.
    // Without this reset, a previous test's mark-the-flag side effect
    // causes the next test's beforeExit handler to skip embedShutdown,
    // breaking call-count assertions. The reset restores the "fresh
    // process" precondition each test expects.
    __resetEmbedShutdownStateForTests();
  });

  afterEach(() => {
    __resetNapiShutdownGuardForTests();
    __resetEmbedShutdownStateForTests();
  });

  it('is a no-op when the bridge module is null (binary not loadable)', () => {
    expect(installNapiShutdownGuard(null)).toBe(false);
    expect(__isNapiShutdownGuardInstalled()).toBe(false);
  });

  it('registers exit listeners on first call and reports back true', () => {
    const before = process.listenerCount('beforeExit');
    const exit = process.listenerCount('exit');
    expect(installNapiShutdownGuard({ embed_shutdown: () => {} })).toBe(true);
    expect(__isNapiShutdownGuardInstalled()).toBe(true);
    expect(process.listenerCount('beforeExit')).toBe(before + 1);
    expect(process.listenerCount('exit')).toBe(exit + 1);
  });

  it('subsequent calls are no-ops and do NOT add more listeners', () => {
    installNapiShutdownGuard({ embed_shutdown: () => {} });
    const before = process.listenerCount('beforeExit');
    const exit = process.listenerCount('exit');
    expect(installNapiShutdownGuard({ embed_shutdown: () => {} })).toBe(false);
    expect(installNapiShutdownGuard({ embed_shutdown: () => {} })).toBe(false);
    expect(process.listenerCount('beforeExit')).toBe(before);
    expect(process.listenerCount('exit')).toBe(exit);
  });

  it('handler invokes embed_shutdown + pino flush exactly once even if both events fire', () => {
    const embedShutdown = vi.fn();
    const pinoFlush = vi.fn();
    installNapiShutdownGuard({}, { embedShutdownFn: embedShutdown, pinoFlushFn: pinoFlush });

    process.emit('beforeExit', 0);
    process.emit('exit', 0);

    expect(embedShutdown).toHaveBeenCalledTimes(1);
    expect(pinoFlush).toHaveBeenCalledTimes(1);
  });

  it('handler swallows embed_shutdown throws and still flushes pino', () => {
    const embedShutdown = vi.fn(() => {
      throw new Error('napi teardown panicked');
    });
    const pinoFlush = vi.fn();
    installNapiShutdownGuard({}, { embedShutdownFn: embedShutdown, pinoFlushFn: pinoFlush });

    expect(() => process.emit('beforeExit', 0)).not.toThrow();
    expect(embedShutdown).toHaveBeenCalledTimes(1);
    expect(pinoFlush).toHaveBeenCalledTimes(1);
  });

  it('handler tolerates a bridge missing embed_shutdown (older / partial binary)', () => {
    const pinoFlush = vi.fn();
    installNapiShutdownGuard({ chain_append: () => {} }, { pinoFlushFn: pinoFlush });

    expect(() => process.emit('beforeExit', 0)).not.toThrow();
    expect(pinoFlush).toHaveBeenCalledTimes(1);
  });

  it('handler swallows pino flush throws — exit must never be blocked by telemetry', () => {
    const embedShutdown = vi.fn();
    const pinoFlush = vi.fn(() => {
      throw new Error('sonic-boom flushSync failed');
    });
    installNapiShutdownGuard({}, { embedShutdownFn: embedShutdown, pinoFlushFn: pinoFlush });

    expect(() => process.emit('exit', 0)).not.toThrow();
    expect(embedShutdown).toHaveBeenCalledTimes(1);
    expect(pinoFlush).toHaveBeenCalledTimes(1);
  });

  // Track B (issue #270): hard-exit override skips cdylib unload via
  // process.reallyExit so V8↔Rust dlclose-time races have no surface.
  // Tests use the explicit option (hardExit: true/false) instead of
  // mutating env, keeping the rest of the suite isolated.
  describe('hard-exit override (Track B)', () => {
    function withMockedReallyExit<T>(fn: (mock: ReturnType<typeof vi.fn>) => T): T {
      const reallyExit = vi.fn();
      const original = (process as unknown as { reallyExit?: unknown }).reallyExit;
      (process as unknown as { reallyExit: unknown }).reallyExit = reallyExit;
      try {
        return fn(reallyExit);
      } finally {
        if (typeof original === 'undefined') {
          delete (process as unknown as { reallyExit?: unknown }).reallyExit;
        } else {
          (process as unknown as { reallyExit: unknown }).reallyExit = original;
        }
      }
    }

    it('does NOT call reallyExit on beforeExit alone (Codex Round 2 #542 — preserve beforeExit listeners)', () => {
      // Codex Round 2 #542: calling reallyExit from beforeExit would
      // cut off operator-registered beforeExit listeners that haven't
      // run yet (registered after our install land later in queue).
      // So beforeExit only does cleanup; the 'exit' phase that fires
      // after beforeExit drains naturally is what triggers reallyExit.
      withMockedReallyExit((reallyExit) => {
        const embedShutdown = vi.fn();
        const pinoFlush = vi.fn();
        installNapiShutdownGuard(
          {},
          { embedShutdownFn: embedShutdown, pinoFlushFn: pinoFlush, hardExit: true },
        );
        process.emit('beforeExit', 0);
        expect(reallyExit, 'reallyExit must NOT fire from beforeExit alone').not.toHaveBeenCalled();
        expect(embedShutdown).toHaveBeenCalledTimes(1);
        expect(pinoFlush).toHaveBeenCalledTimes(1);
      });
    });

    it('calls reallyExit on the natural-exit path: beforeExit then exit (Codex Round 1 #533 still fixed)', () => {
      // This pins the natural-exit flow — beforeExit fires first
      // (event loop drains), our cleanup runs but no reallyExit; then
      // exit fires, cleanupRan-true branch sees hardExit and fires
      // reallyExit. This is what makes MEMPHIS_NAPI_HARD_EXIT=1
      // effective for one-shot scripts that exit naturally without
      // calling process.exit() explicitly.
      withMockedReallyExit((reallyExit) => {
        const embedShutdown = vi.fn();
        const pinoFlush = vi.fn();
        installNapiShutdownGuard(
          {},
          { embedShutdownFn: embedShutdown, pinoFlushFn: pinoFlush, hardExit: true },
        );
        process.emit('beforeExit', 0);
        expect(reallyExit).not.toHaveBeenCalled();
        process.emit('exit', 0);
        expect(reallyExit).toHaveBeenCalledTimes(1);
        expect(reallyExit).toHaveBeenCalledWith(0);
        // Cleanup ran exactly once across both events
        expect(embedShutdown).toHaveBeenCalledTimes(1);
        expect(pinoFlush).toHaveBeenCalledTimes(1);
      });
    });

    it('calls reallyExit on the exit event when hardExit=true', () => {
      withMockedReallyExit((reallyExit) => {
        installNapiShutdownGuard(
          {},
          { embedShutdownFn: vi.fn(), pinoFlushFn: vi.fn(), hardExit: true },
        );
        process.emit('exit', 7);
        expect(reallyExit).toHaveBeenCalledTimes(1);
        // process.exitCode wasn't set; the override falls back to 0.
        expect(reallyExit).toHaveBeenCalledWith(0);
      });
    });

    it('skips reallyExit when hardExit=false (default for explicit-option callers)', () => {
      withMockedReallyExit((reallyExit) => {
        installNapiShutdownGuard(
          {},
          { embedShutdownFn: vi.fn(), pinoFlushFn: vi.fn(), hardExit: false },
        );
        process.emit('exit', 0);
        expect(reallyExit).not.toHaveBeenCalled();
      });
    });
  });
});
