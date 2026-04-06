import { afterEach, describe, expect, it } from 'vitest';

import {
  getSchedulerRuntimeStatus,
  stopScheduler,
} from '../../src/infra/runtime/scheduler.js';

describe('scheduler runtime status', () => {
  afterEach(() => {
    stopScheduler();
  });

  it('reports worker-target fallback when worker session tokens are not ready', () => {
    const status = getSchedulerRuntimeStatus(
      {
        MEMPHIS_SCHEDULER_EXECUTION_TARGET: 'workers',
      },
      {
        workPollingTokenReady: false,
      },
    );

    expect(status).toMatchObject({
      configuredTarget: 'workers',
      effectiveTarget: 'local',
      running: false,
      workerLaneReady: false,
      fallbackReason: 'worker session tokens are not ready; using local execution',
      tasks: {
        total: expect.any(Number),
        enabled: expect.any(Number),
        overdue: expect.any(Number),
      },
    });
  });
});
