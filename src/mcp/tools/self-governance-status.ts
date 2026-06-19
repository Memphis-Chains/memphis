import { listBackups } from '../../infra/cli/commands/backup.js';
import { loadConfig } from '../../infra/config/env.js';
import { buildRuntimeHealthSnapshot } from '../../infra/runtime/runtime-health.js';
import { getScheduledBackupState } from '../../infra/runtime/scheduled-backup.js';
import { getSchedulerRuntimeStatus } from '../../infra/runtime/scheduler.js';
import {
  buildSelfGovernanceSnapshot,
  type SelfGovernanceSnapshot,
} from '../../infra/runtime/self-governance.js';
import { evaluateSlos } from '../../observability/slo-evaluator.js';

export type MemphisSelfGovernanceStatusOutput = SelfGovernanceSnapshot;

export async function runMemphisSelfGovernanceStatus(
  rawEnv: NodeJS.ProcessEnv = process.env,
): Promise<MemphisSelfGovernanceStatusOutput> {
  const config = loadConfig(rawEnv);
  const runtime = await buildRuntimeHealthSnapshot(config, rawEnv);
  const backupReport = getScheduledBackupState(rawEnv);
  const archives = await listBackups().catch(() => ({ backups: [], totalSize: 0 }));
  const latestArchive = archives.backups[0];
  const sloReports = {
    '1h': evaluateSlos({ rawEnv, windowHours: 1 }),
    '24h': evaluateSlos({ rawEnv, windowDays: 1 }),
    '7d': evaluateSlos({ rawEnv, windowDays: 7 }),
  };

  return buildSelfGovernanceSnapshot({
    runtime,
    backups: {
      enabled: backupReport.state.enabled,
      lastSuccessAt: backupReport.state.lastSuccessAt,
      isStale: backupReport.isStale,
      lastError: backupReport.state.lastError,
      totalSuccess: backupReport.state.totalSuccess,
      totalFailures: backupReport.state.totalFailures,
    },
    backupArchives: {
      total: archives.backups.length,
      latestFile: latestArchive?.file,
      latestCreatedAt: latestArchive?.timestamp,
    },
    scheduler: getSchedulerRuntimeStatus(rawEnv),
    sloReports,
  });
}
