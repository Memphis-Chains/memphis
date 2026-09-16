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
      offline: { activeMode: 'remote', defaultProvider: 'minimax', localFallbackEnabled: true, ollamaUrl: '', ollamaReachable: false, supportedModes: ['local-fallback'], ready: true },
      chainMemory: { status: 'ready', chainRoot: '/tmp/c', totalBlocks: 10, cognitiveReady: true, counts: { journal: 1 }, activeChains: ['journal'], integrity: { status: 'ready', checked: 1, invalid: 0, repairable: false, recommendedAction: 'none' } },
      exactSearch: { status: 'indexed', databasePath: '/tmp/m.db', entries: 1, rebuildable: true, sourceChains: ['journal'], repairable: false, recommendedAction: 'none' },
      embeddings: { mode: 'local', status: 'local', rustEnabled: true, bridgeLoaded: true, embedApiAvailable: true, tunedSearchAvailable: true, repairable: false, recommendedAction: 'none' },
      memory: { recallMode: 'semantic', degraded: false, recommendedAction: 'none' },
      cognition: { persistenceStatus: 'ready', patternsChain: { entries: 1, checked: 1, invalid: 0 }, repairable: false, recommendedAction: 'none' },
      repair: { status: 'healthy', repairable: false, recommendedAction: 'none', reasons: [] },
    },
    backups: { enabled: true, lastSuccessAt: '2026-06-16T11:00:00Z', isStale: false, totalSuccess: 1, totalFailures: 0 },
    backupArchives: { total: 1, latestFile: 'backup.tar.gz', latestCreatedAt: '2026-06-16T11:00:00Z' },
    scheduler: { configuredTarget: 'local', effectiveTarget: 'local', running: true, intervalMs: 30000, workerLaneReady: true, tasks: { total: 0, enabled: 0, overdue: 0 } },
    sloReports: { '1h': { windowHours: 1, windowStart: '2026-06-16T11:00:00Z', windowEnd: '2026-06-16T12:00:00Z', spanFilesScanned: 1, totalSamples: 10, slos: [] }, '24h': { windowDays: 1, windowStart: '2026-06-15T12:00:00Z', windowEnd: '2026-06-16T12:00:00Z', spanFilesScanned: 1, totalSamples: 10, slos: [] }, '7d': { windowDays: 7, windowStart: '2026-06-09T12:00:00Z', windowEnd: '2026-06-16T12:00:00Z', spanFilesScanned: 1, totalSamples: 10, slos: [] } },
  };
}

const sampleSloFail = (windowDays: number) => ({
  windowDays,
  windowStart: `2026-06-${10 + (windowDays === 7 ? 0 : windowDays === 1 ? 5 : 9)}T12:00:00Z`,
  windowEnd: '2026-06-16T12:00:00Z',
  spanFilesScanned: 1,
  totalSamples: 20,
  slos: [
    { name: 'tool_error_rate', description: 'tool errors', threshold: 0.05, thresholdUnit: 'ratio', thresholdDirection: 'below' as const, value: 0.2, status: 'fail' as const, samples: 20 },
  ],
});

describe('self-governance canSelfModify (#can-self-modify-computed)', () => {
  it('returns canSelfModify=true when capable && canSelfRecover', () => {
    const s = buildSelfGovernanceSnapshot(healthyInput());
    expect(s.canSelfModify).toBe(true);
    expect(s.capable).toBe(true);
    expect(s.canSelfRecover).toBe(true);
  });

  it('returns canSelfModify=false when chain integrity degraded', () => {
    const input = healthyInput();
    input.runtime.chainMemory.integrity = { status: 'degraded', checked: 10, invalid: 1, repairable: false, recommendedAction: 'r' };
    const s = buildSelfGovernanceSnapshot(input);
    expect(s.canSelfModify).toBe(false);
    expect(s.capable).toBe(false);
    expect(s.canSelfRecover).toBe(false);
  });

  it('returns canSelfModify=false when no fallback ready', () => {
    const input = healthyInput();
    input.runtime.offline.ready = false;
    const s = buildSelfGovernanceSnapshot(input);
    expect(s.canSelfModify).toBe(false);
    expect(s.capable).toBe(false);
  });

  it('returns canSelfModify=false when no backup archive (canSelfRecover also false)', () => {
    const input = healthyInput();
    input.backups = { enabled: false, isStale: false, totalSuccess: 0, totalFailures: 0 };
    input.backupArchives = { total: 0 };
    const s = buildSelfGovernanceSnapshot(input);
    expect(s.canSelfModify).toBe(false); // both blockingReasons from backup AND canSelfRecover=false
    expect(s.canSelfRecover).toBe(false);
  });

  it('returns canSelfModify=false when backup stale (canSelfRecover stays true because lastSuccessAt set)', () => {
    const input = healthyInput();
    input.backups = { enabled: true, isStale: true, lastSuccessAt: '2026-06-01T11:00:00Z', totalSuccess: 5, totalFailures: 0 };
    const s = buildSelfGovernanceSnapshot(input);
    expect(s.canSelfModify).toBe(false); // capable=false (stale in blockingReasons) → false
    expect(s.canSelfRecover).toBe(true); // lastSuccessAt set → canSelfRecover stays true (pre-existing semantics)
  });

  it('returns canSelfModify=false when fresh 24h SLO fails', () => {
    const input = healthyInput();
    input.sloReports = { '1h': sampleSloFail(1) as never, '24h': sampleSloFail(1) as never, '7d': sampleSloFail(7) as never };
    const s = buildSelfGovernanceSnapshot(input);
    expect(s.canSelfModify).toBe(false);
    expect(s.capable).toBe(false);
  });

  it('returns canSelfModify=true when only historical 7d SLO fails, fresh windows pass', () => {
    const input = healthyInput();
    const failing7d = sampleSloFail(7) as never;
    const passingFresh = sampleSloFail(1);
    (passingFresh as { slos: unknown[] }).slos = [];
    input.sloReports = { '1h': passingFresh as never, '24h': passingFresh as never, '7d': failing7d as never };
    const s = buildSelfGovernanceSnapshot(input);
    expect(s.canSelfModify).toBe(true);
    expect(s.capable).toBe(true);
    expect(s.sloWindows?.['7d']?.status).toBe('fail');
  });

  it('returns canSelfModify=true with repair recommended but chain integrity ok', () => {
    const input = healthyInput();
    input.runtime.repair = { status: 'healthy', repairable: true, recommendedAction: 'memphis repair runtime', reasons: ['x'] };
    const s = buildSelfGovernanceSnapshot(input);
    expect(s.canSelfModify).toBe(true);
    expect(s.canSelfRecover).toBe(true);
  });
});
