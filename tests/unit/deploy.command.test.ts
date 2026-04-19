import { afterEach, describe, expect, it, vi } from 'vitest';

const { runDeployPipelineMock } = vi.hoisted(() => ({
  runDeployPipelineMock: vi.fn(),
}));

vi.mock('../../src/infra/deploy/pipeline.js', () => ({
  runDeployPipeline: runDeployPipelineMock,
}));

import { handleDeployCommand } from '../../src/infra/cli/commands/deploy.js';
import type { CliContext } from '../../src/infra/cli/context.js';

function makeContext(subcommand?: string, overrides: Record<string, unknown> = {}): CliContext {
  return {
    argv: [],
    args: {
      command: 'deploy',
      subcommand,
      json: true,
      tui: false,
      write: false,
      save: false,
      confirmWrite: false,
      interactive: false,
      nonInteractive: false,
      force: false,
      apply: false,
      dryRun: false,
      yes: false,
      schema: false,
      verbose: false,
      vision: false,
      functions: false,
      reset: false,
      runtime: false,
      list: false,
      clean: false,
      safeMode: false,
      strictMode: false,
      cron: false,
      providerOnly: false,
      ...overrides,
    },
    getConfig: () => ({}) as never,
    getContainer: () => ({}) as never,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  runDeployPipelineMock.mockReset();
  process.exitCode = 0;
});

describe('deploy command', () => {
  it('passes deploy run flags through to the shared pipeline', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    runDeployPipelineMock.mockResolvedValue({
      success: true,
      action: 'run',
      profile: 'custom',
      timestamp: '2026-04-08T00:00:00.000Z',
      dryRun: true,
      plan: {
        runtimeRoot: '/repo',
        profile: 'custom',
        buildCommand: 'npm run build',
        deployCommand: './scripts/deploy.sh',
        healthUrls: ['http://127.0.0.1:4000/health'],
        testSuite: 'all',
        deep: true,
      },
    });

    const handled = await handleDeployCommand(
      makeContext('run', {
        profile: 'custom',
        buildCommand: 'npm run build',
        deployCommand: './scripts/deploy.sh',
        healthUrl: 'http://127.0.0.1:4000/health',
        testSuite: 'all',
        deep: true,
        dryRun: true,
      }),
    );

    expect(handled).toBe(true);
    expect(runDeployPipelineMock).toHaveBeenCalledWith({
      action: 'run',
      profile: 'custom',
      buildCommand: 'npm run build',
      deployCommand: './scripts/deploy.sh',
      healthUrl: 'http://127.0.0.1:4000/health',
      testSuite: 'all',
      deep: true,
      dryRun: true,
      rollbackIndex: undefined,
    });
    expect(log).toHaveBeenCalled();
    expect(process.exitCode).toBe(0);
  });

  it('maps --latest to rollback index and sets a failing exit code', async () => {
    runDeployPipelineMock.mockResolvedValue({
      success: false,
      action: 'rollback',
      profile: 'local-service',
      timestamp: '2026-04-08T00:00:00.000Z',
      dryRun: false,
      error: 'rollback failed',
      plan: {
        runtimeRoot: '/repo',
        profile: 'local-service',
        healthUrls: [],
        deep: false,
      },
    });

    const handled = await handleDeployCommand(
      makeContext('rollback', {
        latest: 2,
      }),
    );

    expect(handled).toBe(true);
    expect(runDeployPipelineMock).toHaveBeenCalledWith({
      action: 'rollback',
      profile: undefined,
      buildCommand: undefined,
      deployCommand: undefined,
      healthUrl: undefined,
      testSuite: undefined,
      deep: undefined,
      dryRun: false,
      rollbackIndex: 2,
    });
    expect(process.exitCode).toBe(1);
  });
});
