import { getAppVersion } from '../../../config/paths.js';
import { formatSurfaceStatusLines, getActiveSurfacesSnapshot } from '../../../core/surface-presence.js';
import type { OrchestrationService } from '../../../modules/orchestration/service.js';
import { metrics } from '../../logging/metrics.js';
import { computeHealthSummary } from '../../ops/health-summary.js';
import { getLocalWorkerRuntimeStatus } from '../../runtime/local-worker-state.js';
import { safeModeEnabled } from '../../runtime/safe-mode.js';
import { getSchedulerRuntimeStatus } from '../../runtime/scheduler.js';
import {
  getBootstrapWarnings,
  getStartupQueueResumeStatus,
  getStartupRevocationCacheStatus,
  getStartupSafeModeNetworkStatus,
  getStartupTrustRootStatus,
} from '../../runtime/startup-state.js';
import { snapshotTurnTelemetry } from '../../runtime/turn-telemetry.js';
import { checkForUpdate, peekCachedUpdateResult } from '../../self-update/github-release.js';
import { getChainAdapterStatus } from '../../storage/chain-adapter.js';
import { getRustVaultAdapterStatus } from '../../storage/rust-vault-adapter.js';
import type { SqliteDualApprovalRepository } from '../../storage/sqlite/repositories/dual-approval-repository.js';
import type { TaskQueueService } from '../../storage/task-queue-service.js';
import type { WorkPollingService } from '../../work/work-polling-service.js';

type RouteApp = { get: (path: string, handler: () => Promise<unknown> | unknown) => unknown };

export function registerOpsStatusRoute(
  app: RouteApp,
  options: {
    defaultProvider: string;
    orchestration: OrchestrationService;
    taskQueue?: TaskQueueService;
    workPollingService?: WorkPollingService;
    dualApprovalRepository?: SqliteDualApprovalRepository;
  },
): void {
  app.get('/v1/ops/status', async () => {
    void checkForUpdate(getAppVersion()).catch(() => undefined);
    const providers = await options.orchestration.providersHealth();
    const uptimeSec = Math.floor(process.uptime());
    const health = computeHealthSummary({ providers, uptimeSec });
    const workPolling = options.workPollingService?.snapshot() ?? null;
    const scheduler = getSchedulerRuntimeStatus(process.env, {
      workPollingTokenReady: workPolling?.tokenReady ?? null,
    });
    metrics.observeSchedulerRuntime(scheduler);
    const safeMode = safeModeEnabled(process.env);
    const activeSurfaces = getActiveSurfacesSnapshot();

    return {
      service: 'memphis',
      version: getAppVersion(),
      uptimeSec,
      defaultProvider: options.defaultProvider,
      providers,
      metrics: metrics.snapshot(),
      health,
      adapters: {
        chain: getChainAdapterStatus(process.env),
        vault: getRustVaultAdapterStatus(process.env),
      },
      queue: options.taskQueue?.snapshot() ?? null,
      workPolling,
      localWorker: getLocalWorkerRuntimeStatus(),
      scheduler,
      latestTurnTelemetry: snapshotTurnTelemetry(),
      startup: {
        queueResume: getStartupQueueResumeStatus(),
        safeModeNetwork: getStartupSafeModeNetworkStatus() ?? {
          enabled: safeMode,
          attempted: false,
          enforced: false,
          backend: safeMode ? 'iptables' : 'none',
          mode: safeMode ? 'degraded' : 'disabled',
          reason: safeMode ? 'safe mode network capability not evaluated yet' : 'safe mode disabled',
          checkedAt: new Date().toISOString(),
        },
        trustRoot: getStartupTrustRootStatus(),
        revocationCache: getStartupRevocationCacheStatus(),
        warnings: getBootstrapWarnings(),
      },
      dualApproval: options.dualApprovalRepository?.countByState() ?? null,
      activeSurfaces,
      surfaceStatus: formatSurfaceStatusLines(activeSurfaces),
      latestVersion: peekCachedUpdateResult(),
      timestamp: new Date().toISOString(),
    };
  });
}
