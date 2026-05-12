/**
 * Temat 2 (2026-05-12) — embed_shutdown dedup between graceful-shutdown
 * and napi-shutdown handlers.
 *
 * RCA: notes/segv-rca-2026-05-12.md — duplicate embed_shutdown() call
 * from beforeExit listener landed on torn-down cdylib (graceful path
 * ran first, then process.exit fired the napi-shutdown handler, then
 * V8 began unmapping native module → second call hit NULL deref in
 * OnceLock::is_completed).
 *
 * Fix: a process-wide flag (`embed-shutdown-state`) lets either caller
 * mark the work done; the other skips its own invocation. Rust side
 * is already idempotent for back-to-back calls, but the bug is the
 * memory being freed BETWEEN them.
 *
 * Tests:
 *   - flag starts false, mark sets it, second caller sees it set
 *   - napi-shutdown handler skips embedShutdown when flag is set
 *   - napi-shutdown handler runs embedShutdown when flag is unset
 *   - call site is recorded for forensics
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  __resetEmbedShutdownStateForTests,
  getEmbedShutdownCaller,
  hasEmbedShutdownRun,
  markEmbedShutdownCalled,
} from '../../src/infra/runtime/embed-shutdown-state.js';
import {
  __resetNapiShutdownGuardForTests,
  installNapiShutdownGuard,
} from '../../src/infra/runtime/napi-shutdown.js';

describe('embed-shutdown-state', () => {
  beforeEach(() => {
    __resetEmbedShutdownStateForTests();
  });

  it('flag starts false; mark flips it; caller string is recorded', () => {
    expect(hasEmbedShutdownRun()).toBe(false);
    expect(getEmbedShutdownCaller()).toBeUndefined();
    markEmbedShutdownCalled('test:caller-A');
    expect(hasEmbedShutdownRun()).toBe(true);
    expect(getEmbedShutdownCaller()).toBe('test:caller-A');
  });

  it('repeated mark calls update the recorded caller (last writer wins)', () => {
    markEmbedShutdownCalled('test:caller-A');
    markEmbedShutdownCalled('test:caller-B');
    expect(getEmbedShutdownCaller()).toBe('test:caller-B');
  });

  it('reset (test-only) clears the flag', () => {
    markEmbedShutdownCalled('test:caller-A');
    expect(hasEmbedShutdownRun()).toBe(true);
    __resetEmbedShutdownStateForTests();
    expect(hasEmbedShutdownRun()).toBe(false);
  });
});

describe('napi-shutdown handler skips embed_shutdown when flag is set', () => {
  beforeEach(() => {
    __resetEmbedShutdownStateForTests();
    __resetNapiShutdownGuardForTests();
  });

  afterEach(() => {
    __resetEmbedShutdownStateForTests();
    __resetNapiShutdownGuardForTests();
  });

  it('handler runs embedShutdown when flag is unset (no prior graceful call)', () => {
    const embedShutdown = vi.fn();
    const pinoFlush = vi.fn();
    installNapiShutdownGuard(
      { embed_shutdown: embedShutdown },
      { embedShutdownFn: embedShutdown, pinoFlushFn: pinoFlush, hardExit: false },
    );
    // Fire beforeExit (Node lifecycle simulation)
    process.emit('beforeExit', 0);
    expect(embedShutdown).toHaveBeenCalledTimes(1);
    expect(pinoFlush).toHaveBeenCalledTimes(1);
    // Flag now set with napi-shutdown's caller string.
    expect(hasEmbedShutdownRun()).toBe(true);
    expect(getEmbedShutdownCaller()).toBe('napi-shutdown:beforeExit');
  });

  it('handler SKIPS embedShutdown when graceful-shutdown already marked the flag', () => {
    // Simulate the prior graceful-shutdown step 5.5 call.
    markEmbedShutdownCalled('graceful-shutdown:step-5.5');
    const embedShutdown = vi.fn();
    const pinoFlush = vi.fn();
    installNapiShutdownGuard(
      { embed_shutdown: embedShutdown },
      { embedShutdownFn: embedShutdown, pinoFlushFn: pinoFlush, hardExit: false },
    );
    process.emit('beforeExit', 0);
    expect(embedShutdown).not.toHaveBeenCalled();
    // pinoFlush still runs — separate concern, separate dedup story.
    expect(pinoFlush).toHaveBeenCalledTimes(1);
    // Original caller string preserved (we only mark when WE call it).
    expect(getEmbedShutdownCaller()).toBe('graceful-shutdown:step-5.5');
  });

  it('handler is single-shot across beforeExit + exit (existing behavior preserved)', () => {
    const embedShutdown = vi.fn();
    const pinoFlush = vi.fn();
    installNapiShutdownGuard(
      { embed_shutdown: embedShutdown },
      { embedShutdownFn: embedShutdown, pinoFlushFn: pinoFlush, hardExit: false },
    );
    process.emit('beforeExit', 0);
    process.emit('exit', 0);
    // Cleanup ran once total across both events.
    expect(embedShutdown).toHaveBeenCalledTimes(1);
    expect(pinoFlush).toHaveBeenCalledTimes(1);
  });
});
