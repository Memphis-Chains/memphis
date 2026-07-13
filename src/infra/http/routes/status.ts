import { getAppVersion } from '../../../config/paths.js';
import { buildSurfacePolicySnapshot } from '../../../gateway/surface-policy.js';
import type { OrchestrationService } from '../../../modules/orchestration/service.js';
import { metrics } from '../../logging/metrics.js';
import { computeHealthSummary } from '../../ops/health-summary.js';
import { getLocalWorkerRuntimeStatus } from '../../runtime/local-worker-state.js';
import { getSchedulerRuntimeStatus } from '../../runtime/scheduler.js';
import { snapshotTurnTelemetry } from '../../runtime/turn-telemetry.js';
import { getChainAdapterStatus } from '../../storage/chain-adapter.js';
import { getRustEmbedAdapterStatus } from '../../storage/rust-embed-adapter.js';
import { getRustVaultAdapterStatus } from '../../storage/rust-vault-adapter.js';
import type { SqliteAgentPeerRepository } from '../../storage/sqlite/repositories/agent-peer-repository.js';
import type { WorkPollingService } from '../../work/work-polling-service.js';

// See health-metrics.ts: this avoids coupling a route module to the server's
// concrete contextual logger generic.
type RouteApp = {
  get: (path: string, handler: () => Promise<unknown> | unknown) => unknown;
};

export function registerStatusRoute(
  app: RouteApp,
  options: {
    orchestration: OrchestrationService;
    agentPeerRepository?: SqliteAgentPeerRepository;
    workPollingService?: WorkPollingService;
  },
): void {
  app.get('/api/status', async () => {
    const providers = await options.orchestration.providersHealth();
    const uptime = Math.floor(process.uptime());
    const chainAdapter = getChainAdapterStatus(process.env);
    const vaultAdapter = getRustVaultAdapterStatus(process.env);
    const embedAdapter = getRustEmbedAdapterStatus(process.env);
    const health = computeHealthSummary({ providers, uptimeSec: uptime });
    const surfacePolicies = buildSurfacePolicySnapshot(process.env);
    const onlinePeers = options.agentPeerRepository?.list('online') ?? [];
    const allPeers = options.agentPeerRepository?.list() ?? [];
    const workPolling = options.workPollingService?.snapshot() ?? null;
    const localWorker = getLocalWorkerRuntimeStatus();
    const scheduler = getSchedulerRuntimeStatus(process.env, {
      workPollingTokenReady: workPolling?.tokenReady ?? null,
    });
    metrics.observeSchedulerRuntime(scheduler);
    const mem = process.memoryUsage();

    return {
      ok: true,
      service: 'memphis',
      version: getAppVersion(),
      uptime,
      uptimeSec: uptime,
      memory: {
        heapUsed: mem.heapUsed,
        heapTotal: mem.heapTotal,
        rss: mem.rss,
        external: mem.external,
      },
      agents: { online: onlinePeers.length, total: allPeers.length },
      workPolling,
      localWorker,
      scheduler,
      latestTurnTelemetry: snapshotTurnTelemetry(),
      health,
      adapters: {
        chain: {
          ...chainAdapter,
          bridgeLoaded: chainAdapter.rustBridgeLoaded,
          loaded: chainAdapter.rustBridgeLoaded,
        },
        vault: vaultAdapter,
        embed: embedAdapter,
      },
      surfacePolicies,
      providers,
      timestamp: new Date().toISOString(),
    };
  });
}
