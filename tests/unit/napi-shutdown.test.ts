/**
 * Unit tests for the auto-installed NAPI exit guard. The integration
 * stress test (`tests/integration/script-shutdown-segv-stress.test.ts`)
 * spawns real subprocesses and asserts no SIGSEGV; this file pins the
 * registration semantics: idempotency, handler invocation, test-seam
 * substitution, missing-bridge-export tolerance.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  __isNapiShutdownGuardInstalled,
  __resetNapiShutdownGuardForTests,
  installNapiShutdownGuard,
} from '../../src/infra/runtime/napi-shutdown.js';

describe('installNapiShutdownGuard', () => {
  beforeEach(() => {
    __resetNapiShutdownGuardForTests();
  });

  afterEach(() => {
    __resetNapiShutdownGuardForTests();
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
});
