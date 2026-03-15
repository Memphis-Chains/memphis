import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { TaskQueueService } from '../../src/infra/storage/task-queue-service.js';

describe('queue resume restart drill', () => {
  it('re-dispatches recovered tasks once after restart and remains deterministic on next restart', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mv5-queue-restart-drill-'));
    const walPath = join(dir, 'queue.wal');

    // Simulate pre-crash runtime.
    const beforeCrash = new TaskQueueService({
      walPath,
      mode: 'financial',
      maxPendingTasks: 10,
    });
    beforeCrash.enqueue({
      type: 'chat.generate',
      requestId: 'req-crash-1',
      payload: {
        input: 'recover me',
        provider: 'auto',
        strategy: 'default',
      },
    });

    // Simulate restart #1.
    const afterRestart = new TaskQueueService({
      walPath,
      mode: 'financial',
      maxPendingTasks: 10,
      resumePolicy: 'redispatch',
    });

    let runs = 0;
    const resumed = await afterRestart.resumeRecoveredPending({
      redispatch: async () => {
        runs += 1;
        return 'completed';
      },
    });

    expect(runs).toBe(1);
    expect(resumed.scanned).toBe(1);
    expect(resumed.redispatched).toBe(1);
    expect(resumed.failed).toBe(0);
    expect(afterRestart.snapshot().pendingTasks).toBe(0);

    // Simulate restart #2. No re-dispatch should happen.
    const secondRestart = new TaskQueueService({
      walPath,
      mode: 'financial',
      maxPendingTasks: 10,
      resumePolicy: 'redispatch',
    });

    let reruns = 0;
    const resumedAgain = await secondRestart.resumeRecoveredPending({
      redispatch: async () => {
        reruns += 1;
        return 'completed';
      },
    });

    expect(reruns).toBe(0);
    expect(resumedAgain.scanned).toBe(0);
    expect(resumedAgain.redispatched).toBe(0);
    expect(secondRestart.snapshot().pendingTasks).toBe(0);
  });
});
