import { accessSync, constants, existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { getAppVersion } from '../../config/paths.js';
import {
  formatSurfaceStatusLines,
  getActiveSurfacesSnapshot,
  type SurfaceActivitySnapshot,
} from '../../core/surface-presence.js';
import { buildSurfacePolicySnapshot, type SurfacePolicy } from '../../gateway/surface-policy.js';
import type { AppConfig } from '../config/schema.js';
import { countConfabulationEventsInWindow } from '../observability/confabulation-detector.js';
import {
  getLocalWorkerRuntimeStatus,
  type LocalWorkerRuntimeStatus,
} from '../runtime/local-worker-state.js';
import {
  buildRuntimeHealthSnapshot,
  getRuntimeHealthDataDir,
  type RuntimeHealthSnapshot,
} from '../runtime/runtime-health.js';
import { getSchedulerRuntimeStatus, type SchedulerRuntimeStatus } from '../runtime/scheduler.js';
import { snapshotTurnTelemetry, type TurnTelemetrySnapshot } from '../runtime/turn-telemetry.js';
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
  /**
   * Sprint 0.2: rolling 7-day count of confabulation events recorded by
   * the agent loop. Baseline metric for Sprint 1.3 anti-confab guard —
   * exit criterion is ≥70% reduction within a week of the guard merging.
   * Always returned (zero when telemetry sink is empty / disabled).
   */
  confabulationEvents7d: number;
  /**
   * Phase 3.4 (autopilot 2026-05-08): demo readiness state. Populated
   * from data/demo-armed.json which `memphis demo arm` (Phase 3.1)
   * writes after passing the checklist. Used by monitoring scripts +
   * the TUI status panel + future Tauri shell to render
   * `DEMO READY ✅ / NOT ARMED ❌`. `lastRehearseAt` lands in PR 3.2,
   * `planBReady` in PR 3.3.
   */
  demo: {
    armed: boolean;
    armedAt: string | null;
    armedBy: string | null;
    lastRehearseAt: string | null;
    planBReady: boolean;
  };
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
   * Phase 1.3 production sprint: per-provider cost-cap status.
   * Operators see daily/monthly burn rate per provider so the "did
   * Memphis just blow my budget?" question is one /status hit away.
   */
  providerBudgets?: Array<{
    provider: string;
    allowed: boolean;
    reason?: string;
    daily: { used: number; cap?: number; pctUsed?: number };
    monthly: { used: number; cap?: number; pctUsed?: number };
  }>;
  /**
   * Phase 2.2 production sprint: turn admission depth.
   * Operators see "we're under load" before hitting the rejection
   * threshold. `queued > 0` is the early signal; `totalRejected` rising
   * means the cap is biting.
   */
  turnAdmission?: {
    active: number;
    queued: number;
    totalAdmitted: number;
    totalRejected: number;
    totalQueued: number;
    emaTurnDurationMs: number;
  };
  /**
   * Phase 2.1 production sprint: per-provider circuit breaker state.
   * Operators see "anthropic OPEN since 14:23" instead of guessing
   * why latency just spiked. Empty until at least one provider call
   * has been made (we don't pre-emit unconfigured-but-plausible state).
   */
  providerBreakers?: Array<{
    provider: string;
    state: 'closed' | 'open' | 'half-open';
    recentFailures: number;
    failureThreshold: number;
    windowMs: number;
    cooldownMs: number;
    lastFailureAt?: string;
    openedAt?: string;
    halfOpenAt?: string;
    totalTrips: number;
    totalRecoveries: number;
  }>;
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
  /**
   * Phase 4.2 (autopilot 2026-05-08): tier-3 elevated-session counts.
   * Monitoring scripts use these to detect "elevated session still
   * active" without hitting the privileged tier3/sessions detail
   * endpoint. Operator IDs and session metadata stay behind that
   * privileged path. Per docs/dev/TIER3-SURFACE-AUDIT-2026-05-08.md
   * gap #1.
   */
  tier3: {
    activeSessions: number;
    expiringWithinMinutes: number;
  };
  /**
   * Production-safety degraded-boot reasons. Empty/absent when the
   * daemon booted with all production secrets resolved; populated when
   * MEMPHIS_API_TOKEN / provider credentials were missing and the
   * daemon chose graceful degradation over crash-loop (default behavior
   * post-PR `fix/config-degraded-boot-on-missing-vault`, opt-out via
   * `MEMPHIS_STRICT_PRODUCTION_SAFETY=1`). Each reason is operator-
   * facing copy — same text as bootstrap warnings + audit log.
   * Operator recovery guide: `docs/operator/VAULT-RECOVERY-RUNBOOK.md`.
   */
  degradedConfig?: {
    reasons: string[];
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
      fixAction:
        'Set DATABASE_URL to a valid SQLite file path, e.g. DATABASE_URL=file:./data/memphis.db',
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

function checkRustBridge(rawEnv: NodeJS.ProcessEnv, runtime: RuntimeHealthSnapshot): CheckResult {
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
  options?: {
    workPolling?: WorkPollingSnapshot | null;
    /**
     * Production-safety degraded-boot reasons captured at boot time
     * by `loadConfigDetailed()`. Mirror to /health so operators +
     * monitoring dashboards see "this daemon is up but degraded"
     * without re-reading logs.
     */
    degradedReasons?: string[];
  },
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
  const { getAllProviderBudgets } = await import('../runtime/cost-cap.js');
  const providerBudgets = getAllProviderBudgets(rawEnv);
  const { getAllBreakerSnapshots } = await import('../runtime/circuit-breaker.js');
  const providerBreakers = getAllBreakerSnapshots(rawEnv);
  const { getAdmissionState } = await import('../runtime/turn-admission.js');
  const turnAdmission = getAdmissionState();
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
    confabulationEvents7d: countConfabulationEventsInWindow(undefined, rawEnv),
    version: appVersion(),
    uptime_seconds: Math.floor(process.uptime()),
    shutdown: shutdown.shuttingDown ? shutdown : undefined,
    providerBudgets: providerBudgets.length > 0 ? providerBudgets : undefined,
    providerBreakers: providerBreakers.length > 0 ? providerBreakers : undefined,
    turnAdmission,
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
    tier3: readTier3Snapshot(rawEnv),
    demo: readDemoReadinessSnapshot(rawEnv),
    degradedConfig:
      options?.degradedReasons && options.degradedReasons.length > 0
        ? { reasons: options.degradedReasons }
        : undefined,
  };
}

/**
 * Phase 4.2 (autopilot 2026-05-08): expose tier-3 session count on
 * /v1/ops/status so monitoring scripts can detect "elevated session
 * still active" without parsing the privileged /v1/ops/tier3/sessions
 * detail endpoint. Per docs/dev/TIER3-SURFACE-AUDIT-2026-05-08.md gap #1.
 *
 * Returns counts only — never operator IDs or session metadata. The
 * detail endpoint stays the privileged path.
 */
function readTier3Snapshot(rawEnv: NodeJS.ProcessEnv): {
  activeSessions: number;
  expiringWithinMinutes: number;
} {
  try {
    // Dynamic import keeps tier3-session out of the health module's
    // import graph until /status is actually called — health is on
    // the cold path for cold-start machines.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const tier3 = require('../../security/tier3-session.js') as {
      listActiveTier3Sessions: (env: NodeJS.ProcessEnv) => Array<{ expiresAt: number }>;
    };
    const sessions = tier3.listActiveTier3Sessions(rawEnv);
    const nowMs = Date.now();
    const fiveMinMs = 5 * 60 * 1000;
    const expiringWithinMinutes = sessions.filter(
      (s) => s.expiresAt - nowMs > 0 && s.expiresAt - nowMs < fiveMinMs,
    ).length;
    return {
      activeSessions: sessions.length,
      expiringWithinMinutes,
    };
  } catch {
    // Best-effort; never fail the whole /status payload over tier3 read.
    return { activeSessions: 0, expiringWithinMinutes: 0 };
  }
}

/**
 * Phase 3.4 (autopilot 2026-05-08): expose demo readiness state on
 * /v1/ops/status so monitoring scripts (and the future Tauri shell)
 * can render a `DEMO READY ✅ / NOT ARMED ❌` badge without parsing
 * `data/demo-armed.json` themselves.
 *
 * `armed` is true iff `memphis demo arm` (Phase 3.1) succeeded and
 * the state file has not been disarmed since. `armedAt` and
 * `armedBy` mirror what the operator sees in `memphis demo status`.
 *
 * `lastRehearseAt` and `planBReady` are reserved slots for PR 3.2 and
 * 3.3 respectively; they're null until those phases land.
 */
function readDemoReadinessSnapshot(rawEnv: NodeJS.ProcessEnv): {
  armed: boolean;
  armedAt: string | null;
  armedBy: string | null;
  lastRehearseAt: string | null;
  planBReady: boolean;
} {
  const empty = {
    armed: false,
    armedAt: null,
    armedBy: null,
    lastRehearseAt: null,
    planBReady: false,
  } as const;
  try {
    const homeDir = rawEnv.HOME ? `${rawEnv.HOME}/.memphis` : '.';
    const dataDir = rawEnv.MEMPHIS_DATA_DIR ?? homeDir;
    const path = `${dataDir}/demo-armed.json`;
    if (!existsSync(path)) return empty;
    const raw = readFileSync(path, 'utf8');
    if (raw.trim().length === 0) return empty;
    const parsed = JSON.parse(raw) as {
      armedAt?: string;
      armedBy?: string;
      lastRehearseAt?: string;
      planBRecordedAt?: string;
    };
    return {
      armed: true,
      armedAt: parsed.armedAt ?? null,
      armedBy: parsed.armedBy ?? null,
      lastRehearseAt: parsed.lastRehearseAt ?? null,
      // Phase 3.3 populates planBRecordedAt; planBReady=true means a
      // snapshot exists and can be replayed via `demo plan-b play`.
      planBReady: typeof parsed.planBRecordedAt === 'string' && parsed.planBRecordedAt.length > 0,
    };
  } catch {
    // Best-effort surface — never fail the whole /status payload over
    // a missing/malformed demo-armed.json.
    return empty;
  }
}
