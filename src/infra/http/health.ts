import { accessSync, constants, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { getAppVersion } from '../../config/paths.js';
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
import { getRustEmbedAdapterStatus } from '../storage/rust-embed-adapter.js';
import type { WorkPollingSnapshot } from '../work/work-polling-service.js';

export type HealthCheckStatus = 'ok' | 'fail';

type CheckResult = {
  status: HealthCheckStatus;
  message?: string;
  latency_ms?: number;
};

export type HealthPayload = {
  status: 'healthy' | 'unhealthy';
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
  workPolling?: WorkPollingSnapshot | null;
  localWorker?: LocalWorkerRuntimeStatus | null;
  scheduler?: SchedulerRuntimeStatus | null;
  version: string;
  uptime_seconds: number;
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
    return { status: 'fail', message: 'DATABASE_URL must use file: scheme' };
  }

  const absoluteDbPath = resolve(dbPath);
  if (!existsSync(absoluteDbPath)) {
    return { status: 'fail', message: 'database file does not exist' };
  }

  try {
    accessSync(absoluteDbPath, constants.W_OK);
    accessSync(dirname(absoluteDbPath), constants.W_OK);
    return { status: 'ok' };
  } catch {
    return { status: 'fail', message: 'database file or directory is not writable' };
  }
}

function checkDataDir(rawEnv: NodeJS.ProcessEnv): CheckResult {
  const dataDir = getRuntimeHealthDataDir(rawEnv);
  if (!existsSync(dataDir)) {
    return { status: 'fail', message: 'data directory does not exist' };
  }

  try {
    accessSync(dataDir, constants.W_OK);
    return { status: 'ok' };
  } catch {
    return { status: 'fail', message: 'data directory is not writable' };
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

  return { status: 'fail', message: 'rust bridge unavailable and no recall fallback is ready' };
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
    return { status: 'fail', message: `provider returned ${response.status}`, latency_ms };
  } catch {
    return { status: 'fail', message: 'provider ping failed', latency_ms: Date.now() - startedAt };
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

  return {
    status: requiredHealthy && runtimeHealthy ? 'healthy' : 'unhealthy',
    repairable: runtime.repair.repairable,
    recommendedAction: runtime.repair.recommendedAction,
    checks,
    runtime,
    surfacePolicies: buildSurfacePolicySnapshot(rawEnv),
    workPolling: options?.workPolling ?? null,
    localWorker: getLocalWorkerRuntimeStatus(),
    scheduler: getSchedulerRuntimeStatus(rawEnv, {
      workPollingTokenReady: options?.workPolling?.tokenReady ?? null,
    }),
    version: appVersion(),
    uptime_seconds: Math.floor(process.uptime()),
  };
}
