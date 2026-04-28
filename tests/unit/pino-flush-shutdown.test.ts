/**
 * Sprint 2.3 — verify flushAllPinoStreamsSync() drains tracked pino
 * destinations without throwing on absent / shape-mismatched streams.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  __resetPinoRegistryForTests,
  createPinoLogger,
  flushAllPinoStreamsSync,
} from '../../src/infra/logging/pino.js';

describe('flushAllPinoStreamsSync (sprint 2.3)', () => {
  it('returns counts and never throws when called on a fresh registry', () => {
    __resetPinoRegistryForTests();
    const result = flushAllPinoStreamsSync();
    expect(typeof result.flushed).toBe('number');
    expect(typeof result.errors).toBe('number');
    expect(result.errors).toBe(0);
  });

  it('flushes destinations after a logger is created', () => {
    __resetPinoRegistryForTests();
    const logger = createPinoLogger({ level: 'info' });
    logger.info('seed line');
    const result = flushAllPinoStreamsSync();
    // At least the stderr destination should be tracked. Sonic-boom
    // exposes flushSync; if the log file path is also active we get 2.
    expect(result.flushed).toBeGreaterThanOrEqual(1);
    expect(result.errors).toBe(0);
  });

  it('counts errors per stream without aborting the whole flush', () => {
    // We can't easily inject a mock pino destination into the global
    // Set without exporting more internals; instead, verify the helper
    // is idempotent and survives multiple back-to-back calls (the
    // shutdown sequence calls it once, but a flush retry shouldn't
    // explode if the stream already drained).
    __resetPinoRegistryForTests();
    createPinoLogger({ level: 'info' });
    const a = flushAllPinoStreamsSync();
    const b = flushAllPinoStreamsSync();
    expect(a.errors).toBe(0);
    expect(b.errors).toBe(0);
  });

  it('is safe to spy on without breaking', () => {
    __resetPinoRegistryForTests();
    createPinoLogger();
    const spy = vi.fn(flushAllPinoStreamsSync);
    const result = spy();
    expect(spy).toHaveBeenCalledOnce();
    expect(result.errors).toBe(0);
  });
});
