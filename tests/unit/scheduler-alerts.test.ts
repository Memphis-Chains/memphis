import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  getRuntimeAlertEmitter,
  stopAlertRuntimeForTests,
} from '../../src/infra/logging/alert-runtime.js';
import { reportSchedulerWorkerFallback } from '../../src/infra/runtime/scheduler-alerts.js';
import {
  getBootstrapWarnings,
  resetStartupRuntimeStateForTests,
} from '../../src/infra/runtime/startup-state.js';

describe('scheduler alerts', () => {
  afterEach(() => {
    stopAlertRuntimeForTests();
    resetStartupRuntimeStateForTests();
    vi.restoreAllMocks();
  });

  it('emits a high-severity runtime alert and bootstrap warning when workers fall back to local', async () => {
    const emitter = getRuntimeAlertEmitter({});
    const emitSpy = vi.spyOn(emitter, 'emit').mockResolvedValue({ ok: true, deduped: false });

    const reported = await reportSchedulerWorkerFallback({
      configuredTarget: 'workers',
      effectiveTarget: 'local',
      running: true,
      intervalMs: 30_000,
      workerLaneReady: false,
      fallbackReason: 'worker session tokens are not ready; using local execution',
      tasks: {
        total: 2,
        enabled: 2,
        overdue: 1,
      },
    });

    expect(reported).toBe(true);
    expect(emitSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'SchedulerWorkerFallback',
        severity: 'high',
        message: 'Scheduler worker execution fell back to local execution',
        details: expect.objectContaining({
          configuredTarget: 'workers',
          effectiveTarget: 'local',
          workerLaneReady: false,
          reason: 'worker session tokens are not ready; using local execution',
        }),
      }),
    );
    expect(getBootstrapWarnings()).toContainEqual(
      expect.objectContaining({
        component: 'scheduler',
        message: 'Scheduler worker execution fell back to local execution',
        detail: 'worker session tokens are not ready; using local execution',
      }),
    );
  });

  it('stays quiet when the scheduler posture is already safe', async () => {
    const emitter = getRuntimeAlertEmitter({});
    const emitSpy = vi.spyOn(emitter, 'emit').mockResolvedValue({ ok: true, deduped: false });

    const reported = await reportSchedulerWorkerFallback({
      configuredTarget: 'workers',
      effectiveTarget: 'workers',
      running: true,
      intervalMs: 30_000,
      workerLaneReady: true,
      tasks: {
        total: 0,
        enabled: 0,
        overdue: 0,
      },
    });

    expect(reported).toBe(false);
    expect(emitSpy).not.toHaveBeenCalled();
    expect(getBootstrapWarnings()).toEqual([]);
  });
});
