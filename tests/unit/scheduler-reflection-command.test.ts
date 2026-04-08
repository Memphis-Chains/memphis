import { describe, expect, it, vi } from 'vitest';

const { runReflectionCycleMock } = vi.hoisted(() => ({
  runReflectionCycleMock: vi.fn(),
}));

vi.mock('../../src/infra/runtime/reflection-loop.js', () => ({
  runReflectionCycle: runReflectionCycleMock,
}));

import { executeCommand } from '../../src/infra/runtime/scheduler.js';

describe('scheduler reflection command', () => {
  it('uses the shared reflection runtime helper', async () => {
    runReflectionCycleMock.mockResolvedValue({
      generatedAt: '2026-04-08T10:00:00.000Z',
      trigger: 'scheduler',
      periods: ['daily'],
      reflectionCount: 1,
      insightCount: 3,
      recentDecisionCount: 2,
      soulMemoryUpdated: true,
      skipped: false,
    });

    const result = await executeCommand({ type: 'reflection' }, { taskId: 'task-reflection' });

    expect(runReflectionCycleMock).toHaveBeenCalledWith({
      rawEnv: process.env,
      periods: ['daily'],
      trigger: 'scheduler',
    });
    expect(result).toMatchObject({
      taskId: 'task-reflection',
      success: true,
      output: 'Reflection: 1 reflection(s), 3 insight(s)',
    });
  });
});
