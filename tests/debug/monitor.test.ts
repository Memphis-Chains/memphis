import { describe, expect, it } from 'vitest';

import { monitorRuntime } from '../../src/infra/cli/commands/debug.js';

describe('debug monitor', () => {
  it('streams runtime points and produces summary', async () => {
    const result = await monitorRuntime(20, 120);
    expect(result.points.length).toBeGreaterThan(0);
    expect(result.summary.ticks).toBe(result.points.length);
    expect(result.summary.avgLatencyMs).toBeGreaterThanOrEqual(0);
  });

  it('does not leak listeners across repeated calls (#277)', async () => {
    // Issue #277: monitorRuntime used to call emitter.on('tick', …)
    // without ever pairing emitter.off(). The internal emitter is
    // local-scoped so each call discards its own emitter at function
    // return — but this is the "doesn't accumulate" smoke test.
    // We capture process-level Node EventEmitter warning counter to
    // catch the regression if anyone reintroduces a long-lived emitter
    // and forgets cleanup.
    const before = process.listenerCount('warning');
    let warningSeen = false;
    const onWarn = (warning: Error & { name: string }) => {
      if (warning.name === 'MaxListenersExceededWarning') warningSeen = true;
    };
    process.on('warning', onWarn);
    try {
      // 20 sequential 60ms-window calls. Each call attaches one tick
      // listener; with proper cleanup the local emitter is GC'd. With
      // a leak we'd hit Node's default 10-listener threshold long
      // before the loop ends.
      for (let i = 0; i < 20; i += 1) {
        await monitorRuntime(20, 60);
      }
    } finally {
      process.off('warning', onWarn);
    }
    expect(warningSeen).toBe(false);
    expect(process.listenerCount('warning')).toBe(before);
  });
});
