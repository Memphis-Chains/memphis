import { describe, expect, it } from 'vitest';

import {
  DEFAULT_MEMORY_WARN_SHARE,
  evaluateMemoryCheck,
} from '../../src/infra/runtime/heartbeat-watchdog.js';

const MB = 1024 * 1024;
const HOST_16GB = 16 * 1024 * MB;

/**
 * The memory check measures the process's RSS against the HOST's memory.
 *
 * It used to measure `heapUsed / heapTotal`. That ratio is GC pressure,
 * not resource pressure, and on the operator's machine it flapped the
 * health state once an hour: the watch does a burst of work, the V8 heap
 * grows to ~343 MB, the ratio sits at ~90 %, the state goes `degraded`,
 * and a minute later the GC has run and it is `healthy` again.
 */
describe('evaluateMemoryCheck', () => {
  it('stays ok on the shape that used to flap: a high heap ratio on a healthy host', () => {
    // Measured on the operator's machine: heapUsed 310 MB of heapTotal
    // 343 MB (90 %), RSS 629 MB, on a host with 15 423 MB. The old check
    // called this `degraded`; the machine had 10 GB free.
    const result = evaluateMemoryCheck(
      { heapUsed: 310 * MB, heapTotal: 343 * MB, rss: 629 * MB },
      { hostTotalBytes: 15423 * MB },
    );
    expect(result.status).toBe('ok');
    expect(result.message).toContain('RSS 629/15423 MB (4% of host');
    // The heap occupancy is still worth knowing — it just does not decide.
    expect(result.message).toContain('heap 90%');
  });

  it('stays ok on a young process with a high heap ratio', () => {
    // Operator-reported shape: a freshly-booted Node process with
    // heapTotal ≈ 43 MB and heapUsed ≈ 40 MB (93 %). Nowhere near a
    // memory exhaustion signal — the process simply has not been asked
    // to grow yet.
    const result = evaluateMemoryCheck(
      { heapUsed: 40 * MB, heapTotal: 43 * MB, rss: 60 * MB },
      { hostTotalBytes: HOST_16GB },
    );
    expect(result.status).toBe('ok');
  });

  it('warns when the process holds a quarter of the machine', () => {
    // The failure this check exists to catch: the process starving the
    // host and being OOM-killed. 5 GB of a 16 GB host is that.
    const result = evaluateMemoryCheck(
      { heapUsed: 2 * 1024 * MB, heapTotal: 3 * 1024 * MB, rss: 5 * 1024 * MB },
      { hostTotalBytes: HOST_16GB },
    );
    expect(result.status).toBe('warn');
    expect(result.message).toContain('31% of host');
  });

  it('warns when the process is small but the host is tiny', () => {
    // The share is what matters, not the absolute number: 300 MB on a
    // 1 GB host is worth flagging even though it is comfortable on a
    // 16 GB one.
    const result = evaluateMemoryCheck(
      { heapUsed: 100 * MB, heapTotal: 200 * MB, rss: 300 * MB },
      { hostTotalBytes: 1024 * MB },
    );
    expect(result.status).toBe('warn');
  });

  it('respects a custom threshold', () => {
    const result = evaluateMemoryCheck(
      { heapUsed: 100 * MB, heapTotal: 200 * MB, rss: 600 * MB },
      { threshold: 0.02, hostTotalBytes: HOST_16GB },
    );
    expect(result.status).toBe('warn');
  });

  it('reports 0% without crashing on a zero snapshot', () => {
    // Defensive: never divide by zero even if the runtime somehow
    // reports a nonsensical snapshot.
    const result = evaluateMemoryCheck(
      { heapUsed: 0, heapTotal: 0, rss: 0 },
      { hostTotalBytes: HOST_16GB },
    );
    expect(result.status).toBe('ok');
    expect(result.message).toContain('0% of host');
  });

  it('exposes the default share as a testable constant', () => {
    expect(DEFAULT_MEMORY_WARN_SHARE).toBe(0.25);
  });
});
