import type { RuntimeHealthSnapshot } from './runtime-health.js';
import type { SchedulerRuntimeStatus } from './scheduler.js';
import { assessGatedSlos } from '../../observability/slo-assessment.js';
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
  canSelfModify: boolean;
  blockingReasons: string[];
  recommendedActions: string[];
  sloWindows?: Record<
    string,
    {
      status: 'pass' | 'fail' | 'unavailable';
      failingSlos: string[];
      unavailableSlos: string[];
      samples: number;
      windowStart: string;
      windowEnd: string;
    }
  >;
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

function currentSloWindow(report: SloReport, label: string, nowMs: number): boolean {
  const start = Date.parse(report.windowStart);
  const end = Date.parse(report.windowEnd);
  const maxWindowMs = label === '1h' ? 3_600_000 : 86_400_000;
  return (
    Number.isFinite(start) &&
    Number.isFinite(end) &&
    end > start &&
    end - start <= maxWindowMs + 1000 &&
    end >= nowMs - 300_000 &&
    end <= nowMs + 1000
  );
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
      addUnique(
        recommendedActions,
        'Enable scheduled backups or create and verify a manual backup',
      );
    }
    if (backups.enabled && backups.isStale) {
      addUnique(blockingReasons, 'latest scheduled backup is stale');
      addUnique(recommendedActions, 'Run memphis backup create and verify the latest archive');
    }
    if (
      backups.enabled &&
      !backups.lastSuccessAt &&
      backups.totalSuccess === 0 &&
      archiveCount === 0
    ) {
      addUnique(blockingReasons, 'no successful backup is known for this runtime');
      addUnique(recommendedActions, 'Run memphis backup create before relying on self-recovery');
    }
    if (backups.lastError) {
      addUnique(blockingReasons, `scheduled backup has last error: ${backups.lastError}`);
      addUnique(
        recommendedActions,
        'Inspect scheduled backup logs and run memphis backup list --verify',
      );
    }
  } else if (archiveCount === 0) {
    addUnique(blockingReasons, 'backup readiness is unavailable');
    addUnique(recommendedActions, 'Run memphis backup list --verify to establish backup readiness');
  }

  const sloReports = input.sloReports;
  const blockingSloReports: Array<readonly [string, SloReport | undefined]> = sloReports
    ? [
        ['1h', sloReports['1h']],
        ['24h', sloReports['24h']],
      ]
    : input.sloReport
      ? [['default', input.sloReport] as const]
      : [['default', undefined]];
  const nowMs = (input.now ?? new Date()).getTime();
  let sloBlocked = false;
  for (const [label, report] of blockingSloReports) {
    if (!report) {
      addUnique(blockingReasons, `SLO report unavailable (${label})`);
      sloBlocked = true;
      continue;
    }
    if (!currentSloWindow(report, label, nowMs)) {
      addUnique(blockingReasons, `SLO report stale or invalid (${label})`);
      sloBlocked = true;
      continue;
    }
    // The GATE weighs the gated metrics only. The report itself still
    // names every metric, reported-only ones included — a tool that hid
    // them would be hiding the state of the system.
    const assessment = assessGatedSlos(report);
    for (const name of assessment.failingSlos) {
      addUnique(blockingReasons, `SLO failing (${label}): ${name}`);
      sloBlocked = true;
    }
    for (const name of assessment.unavailableSlos) {
      addUnique(blockingReasons, `SLO unavailable (${label}): ${name}`);
      sloBlocked = true;
    }
  }
  if (sloBlocked) {
    addUnique(
      recommendedActions,
      'Run memphis slo status --json and inspect recent telemetry before increasing autonomy',
    );
  }

  if (
    input.scheduler &&
    input.scheduler.configuredTarget === 'workers' &&
    input.scheduler.effectiveTarget !== 'workers'
  ) {
    addUnique(blockingReasons, 'scheduler worker target fell back from workers');
    addUnique(
      recommendedActions,
      input.scheduler.fallbackReason ?? 'Restore scheduler worker lane readiness',
    );
  }

  const canSelfRecover =
    runtime.chainMemory.integrity.status !== 'degraded' &&
    runtime.repair.status !== 'degraded-manual' &&
    runtime.offline.ready &&
    (Boolean(backups?.lastSuccessAt) || archiveCount > 0);
  const capable = blockingReasons.length === 0;

  return {
    mode: 'supervised-operational',
    capable,
    canSelfRecover,
    canSelfModify: capable && canSelfRecover,
    blockingReasons,
    recommendedActions: recommendedActions.filter((action) => action !== 'none'),
    sloWindows: sloReports
      ? Object.fromEntries(
          Object.entries(sloReports).map(([label, report]) => {
            const assessment = assessGatedSlos(report);
            const current =
              (label !== '1h' && label !== '24h') || currentSloWindow(report, label, nowMs);
            return [
              label,
              {
                ...assessment,
                status: current ? assessment.status : 'unavailable',
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
