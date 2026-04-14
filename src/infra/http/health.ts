import { accessSync, constants, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { getAppVersion } from '../../config/paths.js';
import {
  formatSurfaceStatusLines,
  getActiveSurfacesSnapshot,
  type SurfaceActivitySnapshot,
} from '../../core/surface-presence.js';
import { buildSurfacePolicySnapshot, type SurfacePolicy } from '../../gateway/surface-policy.js';
import type { AppConfig } from '../config/schema.js';
import {
  getLocalWorkerRuntimeStatus,
  type LocalWorkerRuntimeStatus,
} from '../runtime/local-worker-state.js';
import {
  buildRuntimeHealthSnapshot,
  getRuntimeHealthDataDir,
  type RuntimeHealthSnapshot,
} from '../runtime/runtime-health.js';
import {
  getSchedulerRuntimeStatus,
  type SchedulerRuntimeStatus,
} from '../runtime/scheduler.js';
import {
  snapshotTurnTelemetry,
  type TurnTelemetrySnapshot,
} from '../runtime/turn-telemetry.js';
import { getRustEmbedAdapterStatus } from '../storage/rust-embed-adapter.js';
import type { WorkPollingSnapshot } from '../work/work-polling-service.js';

export type HealthCheckStatus = 'ok' | 'fail';

type CheckResult = {
  status: HealthCheckStatus;
  message?: string;
  latency_ms?: number;
  fixAction?: string;
};

export type HealthPayload = {
  status: 'healthy' | 'unhealthy' | 'shutting_down';
  repairable: boolean;
  recommendedAction: string;
  checks: {
    database: CheckResult;
    rust_bridge: CheckResult;
    data_dir: CheckResult;
    embedding_provider: CheckResult;
  };
  runtime: RuntimeHealthSnapshot;
  surfacePolicies: SurfacePolicy[];
  activeSurfaces: SurfaceActivitySnapshot[];
  surfaceStatus: string[];
  workPolling?: WorkPollingSnapshot | null;
  localWorker?: LocalWorkerRuntimeStatus | null;
  scheduler?: SchedulerRuntimeStatus | null;
  latestTurnTelemetry: TurnTelemetrySnapshot[];
  version: string;
  uptime_seconds: number;
  /**
   * Phase 1.1 production sprint: shutdown progress visible to operators
   * and pollers. Populated when the SIGTERM/SIGINT handler has fired.
   */
  shutdown?: {
    shuttingDown: boolean;
    startedAt?: string;
    reason?: string;
    drainTimeoutMs?: number;
    inFlightAtStart?: number;
    remainingAfterDrain?: number;
  };
  /**
   * Phase 1.2 production sprint: scheduled-backup observability.
   * Operators see the latest backup age + drill outcome + staleness flag
   * so they can confirm "yes, my data is being protected" at a glance.
   */
  backups?: {
    enabled: boolean;
    intervalMs?: number;
    lastSuccessAt?: string;
    lastSuccessFile?: string;
    lastSuccessSizeBytes?: number;
    ageMs: number | null;
    isStale: boolean;
    lastError?: string;
    lastErrorAt?: string;
    lastDrillAt?: string;
    lastDrillOk?: boolean;
    lastDrillError?: string;
    totalSuccess: number;
    totalFailures: number;
    totalDrills: number;
  };
};

function runtimeIsOperational(runtime: RuntimeHealthSnapshot): boolean {
  if (runtime.repair.status === 'healthy') {
    return true;
  }

  return (
    runtime.firstRun.state === 'initialized-clean' &&
    runtime.offline.ready &&
    runtime.chainMemory.status !== 'missing' &&
    runtime.chainMemory.integrity.status !== 'degraded' &&
    runtime.memory.recallMode !== 'none'
  );
}

function appVersion(): string {
  return getAppVersion();
}

function resolveSqlitePath(databaseUrl: string): string | null {
  if (!databaseUrl.startsWith('file:')) return null;
  return databaseUrl.replace(/^file:/, '');
}

function checkDatabase(databaseUrl: string): CheckResult {
  const dbPath = resolveSqlitePath(databaseUrl);
  if (!dbPath) {
    return {
      status: 'fail',
      message: 'DATABASE_URL must use file: scheme',
      fixAction: 'Set DATABASE_URL to a valid SQLite file path, e.g. DATABASE_URL=file:./data/memphis.db',
    };
  }

  const absoluteDbPath = resolve(dbPath);
  if (!existsSync(absoluteDbPath)) {
    return {
      status: 'fail',
      message: 'database file does not exist',
      fixAction: `Create the database file by running: memphis repair runtime. The expected path is ${absoluteDbPath}`,
    };
  }

  try {
    accessSync(absoluteDbPath, constants.W_OK);
    accessSync(dirname(absoluteDbPath), constants.W_OK);
    return { status: 'ok' };
  } catch {
    return {
      status: 'fail',
      message: 'database file or directory is not writable',
      fixAction: `Check write permissions on ${absoluteDbPath} and its directory: chmod +w $(dirname ${absoluteDbPath})`,
    };
  }
}

function checkDataDir(rawEnv: NodeJS.ProcessEnv): CheckResult {
  const dataDir = getRuntimeHealthDataDir(rawEnv);
  if (!existsSync(dataDir)) {
    return {
      status: 'fail',
      message: 'data directory does not exist',
      fixAction: `Create the data directory: mkdir -p ${dataDir}`,
    };
  }

  try {
    accessSync(dataDir, constants.W_OK);
    return { status: 'ok' };
  } catch {
    return {
      status: 'fail',
      message: 'data directory is not writable',
      fixAction: `Fix write permissions: chmod +w ${dataDir}`,
    };
  }
}

function checkRustBridge(
  rawEnv: NodeJS.ProcessEnv,
  runtime: RuntimeHealthSnapshot,
): CheckResult {
  const status = getRustEmbedAdapterStatus(rawEnv);
  if (!status.rustEnabled) {
    return { status: 'ok', message: 'rust bridge disabled' };
  }

  if (status.bridgeLoaded && status.embedApiAvailable) {
    return { status: 'ok' };
  }

  if (runtime.memory.recallMode !== 'none') {
    return {
      status: 'ok',
      message: `rust embeddings unavailable; using ${runtime.memory.recallMode} recall fallback`,
    };
  }

  return {
    status: 'fail',
    message: 'rust bridge unavailable and no recall fallback is ready',
    fixAction:
      'Ensure the Rust embed bridge is loaded. Check MEMPHIS_EMBED_MODE env and verify memphis-bindings are installed. Or run: RUST_EMBED_MODE=local',
  };
}

async function checkEmbeddingProvider(rawEnv: NodeJS.ProcessEnv): Promise<CheckResult> {
  const mode = rawEnv.RUST_EMBED_MODE ?? 'local';
  let endpoint: string | undefined;

  if (mode === 'ollama') endpoint = 'http://127.0.0.1:11434/api/tags';
  if (mode === 'provider' || mode === 'openai-compatible') {
    endpoint = rawEnv.RUST_EMBED_PROVIDER_URL;
  }

  if (!endpoint) {
    return { status: 'ok', message: `mode=${mode} (no ping required)` };
  }

  const startedAt = Date.now();
  try {
    const response = await fetch(endpoint, {
      method: 'GET',
      signal: AbortSignal.timeout(350),
    });
    const latency_ms = Date.now() - startedAt;
    if (response.ok || response.status < 500) {
      return { status: 'ok', latency_ms };
    }
    return {
      status: 'fail',
      message: `provider returned ${response.status}`,
      latency_ms,
      fixAction: `Check embedding provider URL ${endpoint} - server may be down or misconfigured. For Ollama: ollama serve`,
    };
  } catch {
    return {
      status: 'fail',
      message: 'provider ping failed',
      latency_ms: Date.now() - startedAt,
      fixAction: `Cannot reach embedding provider at ${endpoint}. Verify the service is running. For Ollama: ollama serve`,
    };
  }
}

export async function buildHealthPayload(
  config: AppConfig,
  rawEnv: NodeJS.ProcessEnv = process.env,
  options?: { workPolling?: WorkPollingSnapshot | null },
): Promise<HealthPayload> {
  const runtime = await buildRuntimeHealthSnapshot(config, rawEnv);
  const checks = {
    database: checkDatabase(config.DATABASE_URL),
    rust_bridge: checkRustBridge(rawEnv, runtime),
    data_dir: checkDataDir(rawEnv),
    embedding_provider: await checkEmbeddingProvider(rawEnv),
  };

  const requiredHealthy = checks.database.status === 'ok' && checks.data_dir.status === 'ok';
  const runtimeHealthy = runtimeIsOperational(runtime);

  const activeSurfaces = getActiveSurfacesSnapshot();
  // Phase 1.1: shutdown state takes precedence in the top-level status.
  // Operators / pollers see "shutting_down" as soon as the signal fires,
  // not after the drain completes.
  const { getShutdownState } = await import('../runtime/graceful-shutdown.js');
  const shutdown = getShutdownState();
  const { getScheduledBackupState } = await import('../runtime/scheduled-backup.js');
  const backupReport = getScheduledBackupState(rawEnv);
  const topLevelStatus: HealthPayload['status'] = shutdown.shuttingDown
    ? 'shutting_down'
    : requiredHealthy && runtimeHealthy
      ? 'healthy'
      : 'unhealthy';
  return {
    status: topLevelStatus,
    repairable: runtime.repair.repairable,
    recommendedAction: runtime.repair.recommendedAction,
    checks,
    runtime,
    surfacePolicies: buildSurfacePolicySnapshot(rawEnv),
    activeSurfaces,
    surfaceStatus: formatSurfaceStatusLines(activeSurfaces),
    workPolling: options?.workPolling ?? null,
    localWorker: getLocalWorkerRuntimeStatus(),
    scheduler: getSchedulerRuntimeStatus(rawEnv, {
      workPollingTokenReady: options?.workPolling?.tokenReady ?? null,
    }),
    latestTurnTelemetry: snapshotTurnTelemetry(),
    version: appVersion(),
    uptime_seconds: Math.floor(process.uptime()),
    shutdown: shutdown.shuttingDown ? shutdown : undefined,
    backups: {
      enabled: backupReport.state.enabled,
      intervalMs: backupReport.state.intervalMs,
      lastSuccessAt: backupReport.state.lastSuccessAt,
      lastSuccessFile: backupReport.state.lastSuccessFile,
      lastSuccessSizeBytes: backupReport.state.lastSuccessSizeBytes,
      ageMs: backupReport.ageMs,
      isStale: backupReport.isStale,
      lastError: backupReport.state.lastError,
      lastErrorAt: backupReport.state.lastErrorAt,
      lastDrillAt: backupReport.state.lastDrillAt,
      lastDrillOk: backupReport.state.lastDrillOk,
      lastDrillError: backupReport.state.lastDrillError,
      totalSuccess: backupReport.state.totalSuccess,
      totalFailures: backupReport.state.totalFailures,
      totalDrills: backupReport.state.totalDrills,
    },
  };
}
