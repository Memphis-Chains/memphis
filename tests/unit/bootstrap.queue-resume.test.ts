import { describe, expect, it } from 'vitest';

import { resolveStartupQueueResumePolicy, runStartupQueueResume } from '../../src/app/bootstrap.js';
import type { TaskQueueResumePolicy } from '../../src/infra/storage/task-queue-service.js';

describe('bootstrap queue resume', () => {
  it('overrides redispatch to keep in safe mode', () => {
    const selection = resolveStartupQueueResumePolicy(
      { MEMPHIS_QUEUE_RESUME_POLICY: 'redispatch' },
      { MEMPHIS_SAFE_MODE: 'true' },
    );

    expect(selection.policy).toBe('keep');
    expect(selection.safeModeOverrideApplied).toBe(true);
  });

  it('uses configured policy when not in safe mode', () => {
    const selection = resolveStartupQueueResumePolicy(
      { MEMPHIS_QUEUE_RESUME_POLICY: 'redispatch' },
      { MEMPHIS_SAFE_MODE: 'false' },
    );

    expect(selection.policy).toBe('redispatch');
    expect(selection.safeModeOverrideApplied).toBe(false);
  });

  it('passes effective startup policy to queue resume', async () => {
    const seenPolicies: TaskQueueResumePolicy[] = [];
    const queue = {
      async resumeRecoveredPending(input?: { policy?: TaskQueueResumePolicy }) {
        const policy = input?.policy ?? 'keep';
        seenPolicies.push(policy);
        return {
          policy,
          scanned: 1,
          redispatched: 0,
          failed: 0,
          canceled: 0,
          kept: 1,
          errors: [],
        };
      },
    };

    const resumed = await runStartupQueueResume(
      queue,
      { MEMPHIS_QUEUE_RESUME_POLICY: 'redispatch' },
      { MEMPHIS_SAFE_MODE: 'true' },
      async () => 'completed',
    );

    expect(seenPolicies).toEqual(['keep']);
    expect(resumed.policy).toBe('keep');
    expect(resumed.safeModeOverrideApplied).toBe(true);
  });
});
