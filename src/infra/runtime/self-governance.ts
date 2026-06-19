import type { RuntimeHealthSnapshot } from './runtime-health.js';
import type { SchedulerRuntimeStatus } from './scheduler.js';
import type { SloReport } from '../../observability/slo-evaluator.js';

export type SelfGovernanceMode = 'supervised-operational';

export type SelfGovernanceBackupSnapshot = {
  enabled: boolean;
  lastSuccessAt?: string;
  isStale: boolean;
  lastError?: string;
  totalSuccess: number;
  totalFailures: number;
};

export type SelfGovernanceBackupArchiveSnapshot = {
  total: number;
  latestFile?: string;
  latestCreatedAt?: string;
};

export type SelfGovernanceSnapshot = {
  mode: SelfGovernanceMode;
  capable: boolean;
  canSelfRecover: boolean;
  canSelfModify: false;
  blockingReasons: string[];
  recommendedActions: string[];
  sloWindows?: Record<string, {
    status: 'pass' | 'fail' | 'unavailable';
    failingSlos: string[];
    samples: number;
    windowStart: string;
    windowEnd: string;
  }>;
  freshness: {
    generatedAt: string;
    sloWindowEnd?: string;
    backupLastSuccessAt?: string;
    latestBackupArchive?: string;
  };
};

export type BuildSelfGovernanceSnapshotInput = {
  runtime: RuntimeHealthSnapshot;
  backups?: SelfGovernanceBackupSnapshot;
  backupArchives?: SelfGovernanceBackupArchiveSnapshot;
  scheduler?: SchedulerRuntimeStatus | null;
  sloReport?: SloReport;
  sloReports?: Record<string, SloReport>;
  now?: Date;
};

function addUnique(target: string[], value: string): void {
  if (!target.includes(value)) target.push(value);
}

export function buildSelfGovernanceSnapshot(
  input: BuildSelfGovernanceSnapshotInput,
): SelfGovernanceSnapshot {
  const blockingReasons: string[] = [];
  const recommendedActions: string[] = [];
  const runtime = input.runtime;
  const backups = input.backups;
  const archives = input.backupArchives;

  if (!runtime.firstRun.initialized || runtime.firstRun.state !== 'initialized-clean') {
    addUnique(blockingReasons, `first-run state is ${runtime.firstRun.state}`);
    addUnique(recommendedActions, runtime.firstRun.recommendedAction);
  }

  if (runtime.chainMemory.integrity.status === 'degraded') {
    addUnique(blockingReasons, 'canonical chain integrity is degraded');
    addUnique(recommendedActions, runtime.chainMemory.integrity.recommendedAction);
  }

  if (runtime.repair.status === 'degraded-manual') {
    addUnique(blockingReasons, 'runtime requires manual recovery');
    addUnique(recommendedActions, runtime.repair.recommendedAction);
  }

  if (!runtime.offline.ready) {
    addUnique(blockingReasons, 'no provider fallback path is ready');
    addUnique(
      recommendedActions,
      'Enable local-fallback or restore Ollama/local provider availability before relying on self-recovery',
    );
  }

  if (runtime.memory.recallMode === 'none') {
    addUnique(blockingReasons, 'local memory recall is unavailable');
    addUnique(recommendedActions, runtime.memory.recommendedAction);
  }

  const archiveCount = archives?.total ?? 0;
  if (backups) {
    if (!backups.enabled && archiveCount === 0) {
      addUnique(blockingReasons, 'scheduled backups are disabled and no backup archive is present');
      addUnique(recommendedActions, 'Enable scheduled backups or create and verify a manual backup');
    }
    if (backups.enabled && backups.isStale) {
      addUnique(blockingReasons, 'latest scheduled backup is stale');
      addUnique(recommendedActions, 'Run memphis backup create and verify the latest archive');
    }
    if (backups.enabled && !backups.lastSuccessAt && backups.totalSuccess === 0 && archiveCount === 0) {
      addUnique(blockingReasons, 'no successful backup is known for this runtime');
      addUnique(recommendedActions, 'Run memphis backup create before relying on self-recovery');
    }
    if (backups.lastError) {
      addUnique(blockingReasons, `scheduled backup has last error: ${backups.lastError}`);
      addUnique(recommendedActions, 'Inspect scheduled backup logs and run memphis backup list --verify');
    }
  } else if (archiveCount === 0) {
    addUnique(blockingReasons, 'backup readiness is unavailable');
    addUnique(recommendedActions, 'Run memphis backup list --verify to establish backup readiness');
  }

  const sloReports = input.sloReports;
  const blockingSloReports = sloReports
    ? Object.entries(sloReports).filter(([label]) => label === '1h' || label === '24h')
    : input.sloReport
      ? [['default', input.sloReport] as const]
      : [];
  const failingSloLabels = new Set<string>();
  for (const [label, report] of blockingSloReports) {
    for (const slo of report.slos.filter((item) => item.status === 'fail')) {
      addUnique(blockingReasons, `SLO failing (${label}): ${slo.name}`);
      failingSloLabels.add(label);
    }
  }
  if (failingSloLabels.size > 0) {
    addUnique(
      recommendedActions,
      'Investigate failing fresh SLO windows using memphis_slo_status and recent telemetry before increasing autonomy',
    );
  }

  if (input.scheduler && input.scheduler.configuredTarget === 'workers' && input.scheduler.effectiveTarget !== 'workers') {
    addUnique(blockingReasons, 'scheduler worker target fell back from workers');
    addUnique(recommendedActions, input.scheduler.fallbackReason ?? 'Restore scheduler worker lane readiness');
  }

  const canSelfRecover =
    runtime.chainMemory.integrity.status !== 'degraded' &&
    runtime.repair.status !== 'degraded-manual' &&
    runtime.offline.ready &&
    (Boolean(backups?.lastSuccessAt) || archiveCount > 0);

  return {
    mode: 'supervised-operational',
    capable: blockingReasons.length === 0,
    canSelfRecover,
    canSelfModify: false,
    blockingReasons,
    recommendedActions: recommendedActions.filter((action) => action !== 'none'),
    sloWindows: sloReports
      ? Object.fromEntries(
          Object.entries(sloReports).map(([label, report]) => {
            const failingSlos = report.slos
              .filter((slo) => slo.status === 'fail')
              .map((slo) => slo.name);
            const hasUnavailable = report.slos.some((slo) => slo.status === 'unavailable');
            return [
              label,
              {
                status: failingSlos.length > 0 ? 'fail' : hasUnavailable ? 'unavailable' : 'pass',
                failingSlos,
                samples: report.totalSamples,
                windowStart: report.windowStart,
                windowEnd: report.windowEnd,
              },
            ];
          }),
        )
      : undefined,
    freshness: {
      generatedAt: (input.now ?? new Date()).toISOString(),
      sloWindowEnd: input.sloReports?.['24h']?.windowEnd ?? input.sloReport?.windowEnd,
      backupLastSuccessAt: backups?.lastSuccessAt,
      latestBackupArchive: archives?.latestFile,
    },
  };
}
