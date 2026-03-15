import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  getRuntimeAlertEmitter,
  startAlertSuppressionFlushLoop,
  stopAlertRuntimeForTests,
} from '../../src/infra/logging/alert-runtime.js';

describe('alert runtime', () => {
  afterEach(() => {
    stopAlertRuntimeForTests();
    vi.useRealTimers();
  });

  it('flushes suppressed alerts on configured interval', async () => {
    vi.useFakeTimers();
    const env = {
      MEMPHIS_ALERT_DEDUPE_WINDOW_MS: '25',
      MEMPHIS_ALERT_SUMMARY_INTERVAL_MS: '50',
    } as NodeJS.ProcessEnv;
    const emitter = getRuntimeAlertEmitter(env);
    const flushSpy = vi.spyOn(emitter, 'flushSuppressed').mockResolvedValue(undefined);

    startAlertSuppressionFlushLoop(env);
    vi.advanceTimersByTime(120);
    await Promise.resolve();

    expect(flushSpy).toHaveBeenCalled();
  });
});
