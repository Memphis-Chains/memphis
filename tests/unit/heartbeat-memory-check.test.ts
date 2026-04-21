import { describe, expect, it } from 'vitest';

import {
  DEFAULT_MIN_HEAP_BYTES_FOR_WARN,
  evaluateMemoryCheck,
} from '../../src/infra/runtime/heartbeat-watchdog.js';

const MB = 1024 * 1024;

describe('evaluateMemoryCheck', () => {
  it('returns ok when young heap exceeds 90% (filters GC-pressure false positive)', () => {
    // Operator-reported shape: a freshly-booted Node process with
    // heapTotal ≈ 43 MB and heapUsed ≈ 40 MB. That is 93 %, above the
    // default 90 % threshold, but the heap is nowhere near a memory
    // exhaustion signal — the process simply hasn't been asked to
    // grow yet. The minHeapBytes gate must keep this at ok.
    const result = evaluateMemoryCheck({ heapUsed: 40 * MB, heapTotal: 43 * MB });
    expect(result.status).toBe('ok');
    expect(result.message).toBe('40/43 MB (93%)');
  });

  it('emits warn once heap has matured past the 128 MB floor', () => {
    // Same ~93 % ratio, but heapTotal is now well past the
    // minHeapBytes threshold — this is a real long-running process
    // under sustained heap pressure, so we must surface it.
    const result = evaluateMemoryCheck({ heapUsed: 470 * MB, heapTotal: 500 * MB });
    expect(result.status).toBe('warn');
    expect(result.message).toBe('470/500 MB (94%)');
  });

  it('stays ok below the ratio threshold regardless of heap size', () => {
    const result = evaluateMemoryCheck({ heapUsed: 100 * MB, heapTotal: 500 * MB });
    expect(result.status).toBe('ok');
  });

  it('respects custom threshold + minHeapBytes overrides', () => {
    // Allow the caller to tighten both knobs independently.
    const result = evaluateMemoryCheck(
      { heapUsed: 80 * MB, heapTotal: 100 * MB },
      { threshold: 0.7, minHeapBytes: 50 * MB },
    );
    expect(result.status).toBe('warn');
  });

  it('reports 0% without crashing on zero heapTotal', () => {
    // Defensive: never divide by zero even if the runtime somehow
    // reports a nonsensical snapshot.
    const result = evaluateMemoryCheck({ heapUsed: 0, heapTotal: 0 });
    expect(result.status).toBe('ok');
    expect(result.message).toBe('0/0 MB (0%)');
  });

  it('exposes the default floor as a testable constant', () => {
    expect(DEFAULT_MIN_HEAP_BYTES_FOR_WARN).toBe(128 * MB);
  });
});
