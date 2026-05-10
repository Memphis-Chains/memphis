import { EventEmitter } from 'node:events';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { getUserServiceStatusMock, resolveRuntimeRootMock, runDeployPipelineMock, spawnMock } =
  vi.hoisted(() => ({
    getUserServiceStatusMock: vi.fn(),
    resolveRuntimeRootMock: vi.fn(),
    runDeployPipelineMock: vi.fn(),
    spawnMock: vi.fn(),
  }));

vi.mock('node:child_process', () => ({
  spawn: spawnMock,
}));

vi.mock('../../src/infra/deploy/pipeline.js', () => ({
  runDeployPipeline: runDeployPipelineMock,
}));

vi.mock('../../src/infra/runtime/user-service.js', () => ({
  getUserServiceStatus: getUserServiceStatusMock,
  resolveRuntimeRoot: resolveRuntimeRootMock,
}));

import { executeCommand } from '../../src/infra/runtime/scheduler.js';

function childThatCloses(
  code = 0,
  stdout = '',
): EventEmitter & {
  stdout: EventEmitter;
  stderr: EventEmitter;
} {
  const emitter = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
  };
  emitter.stdout = new EventEmitter();
  emitter.stderr = new EventEmitter();
  queueMicrotask(() => {
    if (stdout.length > 0) {
      emitter.stdout.emit('data', stdout);
    }
    emitter.emit('close', code);
  });
  return emitter;
}

describe('scheduler git-pull-build command', () => {
  beforeEach(() => {
    spawnMock.mockReset();
    runDeployPipelineMock.mockReset();
    resolveRuntimeRootMock.mockReset();
    getUserServiceStatusMock.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('uses the shared deploy pipeline after a successful git pull', async () => {
    spawnMock.mockReturnValueOnce(childThatCloses(0, 'Already up to date.\n'));
    resolveRuntimeRootMock.mockReturnValue('/repo');
    getUserServiceStatusMock.mockReturnValue({
      available: true,
      installed: true,
    });
    runDeployPipelineMock.mockResolvedValue({
      success: true,
      action: 'run',
      profile: 'local-service',
      timestamp: '2026-04-08T00:00:00.000Z',
      dryRun: false,
      snapshotId: 'snap-1',
      health: {
        ok: true,
        healthStatus: 'healthy',
      },
      plan: {
        runtimeRoot: '/repo',
        profile: 'local-service',
        healthUrls: [],
        deep: false,
      },
    });

    const result = await executeCommand(
      { type: 'git-pull-build' },
      { taskId: 'task-git-pull-build' },
    );

    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(spawnMock).toHaveBeenCalledWith(
      '/bin/bash',
      [
        '-lc',
        'cd "$1" || exit 1; __memphis_script="$2"; set --; eval "$__memphis_script"',
        'bash',
        '/repo',
        // `--ff-only` keeps the cron task from auto-merging or auto-
        // rebasing if local main has diverged — surface the divergence
        // as a clear failure instead. See `scheduler.ts:case 'git-pull-build'`.
        'git pull --ff-only origin main',
      ],
      expect.objectContaining({
        cwd: '/repo',
      }),
    );
    expect(runDeployPipelineMock).toHaveBeenCalledWith(
      {
        action: 'run',
        profile: 'local-service',
      },
      {
        rawEnv: process.env,
        runtimeRoot: '/repo',
      },
    );
    expect(result).toMatchObject({
      taskId: 'task-git-pull-build',
      success: true,
      output: 'Git pull OK, deploy completed (local-service)',
    });
  });
});
