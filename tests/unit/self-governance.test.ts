import { describe, expect, it } from 'vitest';

import {
  buildSelfGovernanceSnapshot,
  type BuildSelfGovernanceSnapshotInput,
} from '../../src/infra/runtime/self-governance.js';

function healthyInput(): BuildSelfGovernanceSnapshotInput {
  return {
    now: new Date('2026-06-16T12:00:00Z'),
    runtime: {
      firstRun: {
        state: 'initialized-clean',
        initialized: true,
        envPresent: true,
        vaultInitialized: true,
        operatorConfigured: true,
        recordOrigin: 'controlled-init',
        legacyChains: [],
        legacyFiles: 0,
        reasons: [],
        recommendedAction: 'none',
        plan: {} as never,
      },
      offline: {
        activeMode: 'remote',
        defaultProvider: 'minimax',
        localFallbackEnabled: true,
        ollamaUrl: 'http://127.0.0.1:11434',
        ollamaReachable: false,
        supportedModes: ['local-fallback'],
        ready: true,
      },
      chainMemory: {
        status: 'ready',
        chainRoot: '/tmp/chains',
        totalBlocks: 10,
        cognitiveReady: true,
        counts: { journal: 1 },
        activeChains: ['journal'],
        integrity: {
          status: 'ready',
          checked: 1,
          invalid: 0,
          repairable: false,
          recommendedAction: 'none',
        },
      },
      exactSearch: {
        status: 'indexed',
        databasePath: '/tmp/memphis.db',
        entries: 1,
        rebuildable: true,
        sourceChains: ['journal'],
        repairable: false,
        recommendedAction: 'none',
      },
      embeddings: {
        mode: 'local',
        status: 'local',
        rustEnabled: true,
        bridgeLoaded: true,
        embedApiAvailable: true,
        tunedSearchAvailable: true,
        repairable: false,
        recommendedAction: 'none',
      },
      memory: {
        recallMode: 'semantic',
        degraded: false,
        recommendedAction: 'none',
      },
      cognition: {
        persistenceStatus: 'ready',
        patternsChain: { entries: 1, checked: 1, invalid: 0 },
        repairable: false,
        recommendedAction: 'none',
      },
      repair: {
        status: 'healthy',
        repairable: false,
        recommendedAction: 'none',
        reasons: [],
      },
    },
    backups: {
      enabled: true,
      lastSuccessAt: '2026-06-16T11:00:00Z',
      isStale: false,
      totalSuccess: 1,
      totalFailures: 0,
    },
    backupArchives: {
      total: 1,
      latestFile: 'backup.tar.gz',
      latestCreatedAt: '2026-06-16T11:00:00Z',
    },
    scheduler: {
      configuredTarget: 'local',
      effectiveTarget: 'local',
      running: true,
      intervalMs: 30_000,
      workerLaneReady: true,
      tasks: { total: 0, enabled: 0, overdue: 0 },
    },
    sloReport: {
      windowDays: 7,
      windowStart: '2026-06-09T12:00:00Z',
      windowEnd: '2026-06-16T12:00:00Z',
      spanFilesScanned: 1,
      totalSamples: 10,
      slos: [],
    },
  };
}

describe('self-governance snapshot', () => {
  it('marks a healthy supervised-operational runtime as capable', () => {
    const snapshot = buildSelfGovernanceSnapshot(healthyInput());

    expect(snapshot).toMatchObject({
      mode: 'supervised-operational',
      capable: true,
      canSelfRecover: true,
      canSelfModify: false,
      blockingReasons: [],
    });
  });

  it('blocks capability when canonical chain integrity is degraded', () => {
    const input = healthyInput();
    input.runtime.chainMemory.integrity = {
      status: 'degraded',
      checked: 10,
      invalid: 1,
      repairable: false,
      recommendedAction: 'restore from backup',
    };

    const snapshot = buildSelfGovernanceSnapshot(input);

    expect(snapshot.capable).toBe(false);
    expect(snapshot.canSelfRecover).toBe(false);
    expect(snapshot.blockingReasons).toContain('canonical chain integrity is degraded');
    expect(snapshot.recommendedActions).toContain('restore from backup');
  });

  it('blocks capability when no backup is known after restart', () => {
    const input = healthyInput();
    input.backups = {
      enabled: true,
      isStale: false,
      totalSuccess: 0,
      totalFailures: 0,
    };
    input.backupArchives = { total: 0 };

    const snapshot = buildSelfGovernanceSnapshot(input);

    expect(snapshot.capable).toBe(false);
    expect(snapshot.canSelfRecover).toBe(false);
    expect(snapshot.blockingReasons).toContain('no successful backup is known for this runtime');
  });

  it('treats failing SLOs as autonomy blockers without enabling self-modify', () => {
    const input = healthyInput();
    input.sloReport!.slos = [
      {
        name: 'tool_error_rate',
        description: 'tool errors',
        threshold: 0.05,
        thresholdUnit: 'ratio',
        thresholdDirection: 'below',
        value: 0.2,
        status: 'fail',
        samples: 20,
      },
    ];

    const snapshot = buildSelfGovernanceSnapshot(input);

    expect(snapshot.capable).toBe(false);
    expect(snapshot.canSelfModify).toBe(false);
    expect(snapshot.blockingReasons).toContain('SLO failing (default): tool_error_rate');
    expect(snapshot.recommendedActions).toContain(
      'Run memphis slo status --json and inspect recent telemetry before increasing autonomy',
    );
  });

  it('does not block capability on historical 7d SLO failures when fresh windows pass', () => {
    const input = healthyInput();
    const failing7d = {
      ...input.sloReport!,
      windowDays: 7,
      slos: [
        {
          name: 'tool_error_rate',
          description: 'tool errors',
          threshold: 0.05,
          thresholdUnit: 'ratio',
          thresholdDirection: 'below',
          value: 0.2,
          status: 'fail',
          samples: 100,
        },
      ],
    } as const;
    const passingFresh = { ...input.sloReport!, slos: [] };
    input.sloReport = undefined;
    input.sloReports = {
      '1h': passingFresh,
      '24h': passingFresh,
      '7d': failing7d,
    };

    const snapshot = buildSelfGovernanceSnapshot(input);

    expect(snapshot.capable).toBe(true);
    expect(snapshot.sloWindows?.['7d']?.status).toBe('fail');
    expect(snapshot.blockingReasons).not.toContain('SLO failing (7d): tool_error_rate');
  });

  it('blocks capability on fresh 24h SLO failures', () => {
    const input = healthyInput();
    const passingFresh = { ...input.sloReport!, slos: [] };
    const failing24h = {
      ...input.sloReport!,
      windowDays: 1,
      slos: [
        {
          name: 'confabulation_rate',
          description: 'confabulation',
          threshold: 0.001,
          thresholdUnit: 'ratio',
          thresholdDirection: 'below',
          value: 0.1,
          status: 'fail',
          samples: 20,
        },
      ],
    } as const;
    input.sloReport = undefined;
    input.sloReports = {
      '1h': passingFresh,
      '24h': failing24h,
      '7d': failing24h,
    };

    const snapshot = buildSelfGovernanceSnapshot(input);

    expect(snapshot.capable).toBe(false);
    expect(snapshot.blockingReasons).toContain('SLO failing (24h): confabulation_rate');
  });
});
