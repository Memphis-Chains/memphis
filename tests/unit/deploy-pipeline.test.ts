import { afterEach, describe, expect, it, vi } from 'vitest';

import { runDeployPipeline } from '../../src/infra/deploy/pipeline.js';

function serviceStatus(detail = 'installed and active') {
  return {
    name: 'memphis.service',
    available: true,
    installed: true,
    enabled: true,
    active: true,
    unitPath: '/tmp/memphis.service',
    runtimeRoot: '/repo',
    execStart: 'node dist/infra/cli/index.js serve',
    pathEnv: '/usr/bin',
    detail,
  };
}

function doctorReport(ok = true) {
  return {
    ok,
    checks: [],
    summary: {
      total: 1,
      pass: ok ? 1 : 0,
      warn: 0,
      fail: ok ? 0 : 1,
      requiredFailures: ok ? 0 : 1,
    },
    repairs: [],
    repairStatus: ok ? 'healthy' : 'degraded-manual',
    repairable: !ok,
    recommendedAction: ok ? 'none' : 'Run memphis doctor --fix',
    firstRunPlan: {
      ready: ok,
      status: ok ? 'ready' : 'manual-intervention',
      steps: [],
      notes: [],
      envPatches: {},
      generatedAt: '2026-04-08T00:00:00.000Z',
    },
  } as never;
}

function healthPayload(status: 'healthy' | 'unhealthy' = 'healthy') {
  return {
    status,
    repairable: status !== 'healthy',
    recommendedAction: status === 'healthy' ? 'none' : 'repair runtime',
    checks: {},
    runtime: {},
    surfacePolicies: [],
    latestTurnTelemetry: [],
    version: '1.3.0',
    uptime_seconds: 42,
  } as never;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('deploy pipeline', () => {
  it('runs test, build, restart, and health checks for local-service deploys', async () => {
    const runCommand = vi
      .fn()
      .mockReturnValueOnce({
        ok: true,
        command: 'npm run lint',
        output: 'lint ok',
        durationMs: 12,
        exitCode: 0,
      })
      .mockReturnValueOnce({
        ok: true,
        command: 'npm run build',
        output: 'build ok',
        durationMs: 18,
        exitCode: 0,
      });
    const restartService = vi.fn().mockReturnValue(serviceStatus());

    const result = await runDeployPipeline(
      {
        action: 'run',
        profile: 'local-service',
        testSuite: 'lint',
        healthUrl: 'http://127.0.0.1:3000/health',
      },
      {
        runtimeRoot: '/repo',
        rawEnv: { ...process.env },
        runCommand,
        createSnapshot: vi.fn().mockResolvedValue('snap-1'),
        getServiceStatus: vi.fn().mockReturnValue(serviceStatus()),
        restartService,
        runDoctor: vi.fn().mockResolvedValue(doctorReport()),
        runHealth: vi.fn().mockResolvedValue(healthPayload()),
        probeUrl: vi.fn().mockResolvedValue({
          url: 'http://127.0.0.1:3000/health',
          ok: true,
          latencyMs: 4,
          statusCode: 200,
        }),
      },
    );

    expect(result.success).toBe(true);
    expect(result.snapshotId).toBe('snap-1');
    expect(result.test?.command).toBe('npm run lint');
    expect(result.build?.command).toBe('npm run build');
    expect(result.deploy?.command).toBe('systemctl --user restart memphis.service');
    expect(result.health?.ok).toBe(true);
    expect(restartService).toHaveBeenCalledTimes(1);
  });

  it('rolls back the snapshot when the build step fails', async () => {
    const rollbackSnapshot = vi.fn().mockResolvedValue({
      success: true,
      snapshotId: 'snap-2',
    });

    const result = await runDeployPipeline(
      {
        action: 'run',
        profile: 'local-service',
      },
      {
        runtimeRoot: '/repo',
        rawEnv: { ...process.env },
        runCommand: vi
          .fn()
          .mockReturnValueOnce({
            ok: true,
            command: 'npx vitest run',
            output: 'tests ok',
            durationMs: 10,
            exitCode: 0,
          })
          .mockReturnValueOnce({
            ok: false,
            command: 'npm run build',
            output: 'build failed',
            durationMs: 14,
            exitCode: 1,
          }),
        createSnapshot: vi.fn().mockResolvedValue('snap-2'),
        rollbackSnapshot,
        getServiceStatus: vi.fn().mockReturnValue(serviceStatus()),
        restartService: vi.fn().mockReturnValue(serviceStatus()),
      },
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe('build failed');
    expect(result.rollback).toMatchObject({
      attempted: true,
      snapshotId: 'snap-2',
      success: true,
    });
    expect(rollbackSnapshot).toHaveBeenCalledWith('snap-2');
  });

  it('skips implicit HTTP probes for build-only health checks', async () => {
    const probeUrl = vi.fn();

    const result = await runDeployPipeline(
      {
        action: 'health',
        profile: 'build-only',
      },
      {
        runtimeRoot: '/repo',
        rawEnv: { ...process.env },
        runDoctor: vi.fn().mockResolvedValue(doctorReport()),
        runHealth: vi.fn().mockResolvedValue(healthPayload()),
        getServiceStatus: vi.fn().mockReturnValue(serviceStatus()),
        probeUrl,
      },
    );

    expect(result.success).toBe(true);
    expect(result.plan.healthUrls).toEqual([]);
    expect(result.health?.httpChecks).toEqual([]);
    expect(probeUrl).not.toHaveBeenCalled();
  });

  it('fails fast when custom deploy profile has no deploy command', async () => {
    const result = await runDeployPipeline(
      {
        action: 'run',
        profile: 'custom',
      },
      {
        runtimeRoot: '/repo',
        rawEnv: { ...process.env },
        runCommand: vi
          .fn()
          .mockReturnValueOnce({
            ok: true,
            command: 'npx vitest run',
            output: 'tests ok',
            durationMs: 8,
            exitCode: 0,
          })
          .mockReturnValueOnce({
            ok: true,
            command: 'npm run build',
            output: 'build ok',
            durationMs: 9,
            exitCode: 0,
          }),
        createSnapshot: vi.fn().mockResolvedValue('snap-3'),
        rollbackSnapshot: vi.fn().mockResolvedValue({
          success: true,
          snapshotId: 'snap-3',
        }),
        getServiceStatus: vi.fn().mockReturnValue(serviceStatus()),
      },
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe('custom deploy profile requires deployCommand');
    expect(result.rollback?.attempted).toBe(true);
  });
});
