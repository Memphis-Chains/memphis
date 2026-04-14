import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';

import { createAppContainer } from './container.js';
import { getCognitiveModeConfig } from '../cognitive/modes.js';
import { getAppVersion } from '../config/paths.js';
import { AppError, errorTemplates } from '../core/errors.js';
import {
  formatSurfaceStatusLines,
  getActiveSurfacesSnapshot,
} from '../core/surface-presence.js';
import type { GenerateInput, GenerateOptions, ProviderName } from '../core/types.js';
import {
  channelGatewayEnabled as resolveTelegramGatewayEnabled,
  parseTelegramAllowedUserIds,
  resolveTelegramBotToken,
} from '../gateway/channels/telegram-readiness.js';
import { createTelegramAdapter } from '../gateway/channels/telegram.js';
import { startGateway, type GatewayHandle } from '../gateway/chat-loop.js';
import type { ChannelAdapter } from '../gateway/chat-types.js';
import { resolveActorId } from '../gateway/conversation-identity.js';
import { createInProcessMemoryClient } from '../gateway/memory-client.js';
import { createOperatorChatSessionStore } from '../gateway/operator-chat-session-store.js';
import { providerToLlmClient } from '../gateway/provider-adapter.js';
import { createInProcessToolExecutor } from '../gateway/tool-executor.js';
import { checkOllama, checkRustToolchain } from '../infra/cli/utils/dependencies.js';
import { loadConfig } from '../infra/config/env.js';
import type { AppConfig } from '../infra/config/schema.js';
import { createHttpServer } from '../infra/http/server.js';
import { startAlertSuppressionFlushLoop } from '../infra/logging/alert-runtime.js';
// Side-effect import: registers the LOG_LEVEL post-apply hook so /config
// reload propagates to live loggers without restart.
import '../infra/logging/contextual.js';
import { createPinoLogger } from '../infra/logging/pino.js';
import { writeSecurityAudit } from '../infra/logging/security-audit.js';
import { initOtelIfEnabled } from '../infra/observability/otel.js';
import { startChainRotationLoop } from '../infra/runtime/chain-rotation-loop.js';
import { inStrictMode } from '../infra/runtime/emergency-log.js';
import { EXIT_CODES, MemphisExitError } from '../infra/runtime/exit-codes.js';
import { installShutdownHandlers } from '../infra/runtime/graceful-shutdown.js';
import { HeartbeatWatchdog, writeBootPulse } from '../infra/runtime/heartbeat-watchdog.js';
import { setLocalWorkerRuntimeStatus } from '../infra/runtime/local-worker-state.js';
import { startReflectionLoop } from '../infra/runtime/reflection-loop.js';
import { enforceSafeModeNoEgress, safeModeEnabled } from '../infra/runtime/safe-mode.js';
import { startScheduledBackupLoop } from '../infra/runtime/scheduled-backup.js';
import { reportSchedulerWorkerFallback } from '../infra/runtime/scheduler-alerts.js';
import {
  getSchedulerRuntimeStatus,
  resolveConfiguredSchedulerExecutionTarget,
  startScheduler,
} from '../infra/runtime/scheduler.js';
import { writeSecurityCriticalEvent } from '../infra/runtime/security-critical.js';
import {
  evaluateAutoRevert,
  performAutoRevert,
  recordBootAttempt,
  recordBootSuccess,
} from '../infra/runtime/self-modify-revert.js';
import {
  evaluateRevocationCacheStartup,
  evaluateTrustRootStartup,
  type RevocationCacheStartupStatus,
  type TrustRootStartupStatus,
} from '../infra/runtime/startup-guards.js';
import {
  addBootstrapWarning,
  setStartupRevocationCacheStatus,
  setStartupQueueResumeStatus,
  setStartupSafeModeNetworkStatus,
  setStartupTrustRootStatus,
} from '../infra/runtime/startup-state.js';
import { CaseChainAdapter } from '../infra/storage/case-chain-adapter.js';
import { appendBlock, verifyChainIntegrity } from '../infra/storage/chain-adapter.js';
import { embedSearch, getRustEmbedAdapterStatus } from '../infra/storage/rust-embed-adapter.js';
import type {
  QueuePendingTask,
  TaskQueueResumeResult,
  TaskQueueResumePolicy,
  TaskQueueStatus,
} from '../infra/storage/task-queue-service.js';
import { buildChatDispatchWorkItem, type HttpChatRuntimeDeps } from '../infra/work/chat-work.js';
import { LocalWorkerRunner } from '../infra/work/local-worker-runner.js';
import { DEFAULT_LOCAL_WORKER_CAPABILITY_SCOPE } from '../infra/work/work-capabilities.js';
import { getCognitiveMode, ensureIskra, ensureSoulManifest } from '../soul/manifest.js';
import { loadSoulMemory } from '../soul/memory.js';

export async function bootstrap(): Promise<void> {
  // Phase 2.3 production sprint: bump the boot-attempt counter BEFORE
  // any risky init. If we crash mid-init, the next process sees the
  // failure and may auto-revert a recent self-modify commit.
  recordBootAttempt(process.env);

  // Then evaluate whether the prior crashes warrant a revert. If yes,
  // perform it and continue boot — the just-reverted code is what we'll
  // run from this point.
  const revertDecision = evaluateAutoRevert(process.env);
  if (revertDecision.shouldRevert) {
    const result = await performAutoRevert(revertDecision);
    process.stderr.write(
      `[memphis-bootstrap] self-modify auto-revert: ` +
        `${result.ok ? 'reverted to ' + result.revertedTo : 'FAILED — ' + result.error}\n`,
    );
  }

  const envFilePath = resolveBootstrapEnvPath(process.env);

  if (!existsSync(envFilePath)) {
    const isTTY = process.stdin.isTTY && process.stdout.isTTY;
    if (isTTY) {
      console.log('\n  Memphis has not been initialized yet.\n');
      console.log('  Run:  memphis init\n');
      console.log('  This will set up your .env, vault, and provider configuration.\n');
    }
    throw errorTemplates.missingEnv({ path: envFilePath });
  }

  const rust = checkRustToolchain();
  if (!rust.ok && rust.required) {
    throw new AppError('CONFIG_ERROR', rust.detail, 500, rust.meta, rust.fix);
  }

  const config = loadConfig();
  startAlertSuppressionFlushLoop(process.env);

  // Phase 3.2 production sprint: auto-migrate chain schema if operator
  // opted in via MEMPHIS_AUTO_MIGRATE_ON_BOOT=true. Default = no-op
  // (operator explicitly runs `memphis chain migrate --apply`).
  try {
    const { maybeAutoMigrateOnBoot } = await import(
      '../infra/storage/migrations/runner.js'
    );
    const migrationResult = await maybeAutoMigrateOnBoot(process.env);
    if (migrationResult && !migrationResult.ok) {
      process.stderr.write(
        `[memphis-bootstrap] chain auto-migration reported errors: ${JSON.stringify(
          migrationResult.perChain.filter((c) => c.error),
        )}\n`,
      );
    }
  } catch (err) {
    // Migration machinery crashing on boot is non-fatal; operators can
    // run the migrator manually after investigating.
    process.stderr.write(
      `[memphis-bootstrap] chain auto-migration crashed: ${err instanceof Error ? err.message : String(err)}\n`,
    );
  }

  await runStartupSecurityGuards(process.env);

  if (!safeModeEnabled(process.env)) {
    setStartupSafeModeNetworkStatus({
      enabled: false,
      attempted: false,
      enforced: false,
      backend: 'none',
      mode: 'disabled',
      reason: 'safe mode disabled',
    });
  }

  if (safeModeEnabled(process.env)) {
    const networkPolicy = enforceSafeModeNoEgress(process.env);
    setStartupSafeModeNetworkStatus({
      enabled: true,
      attempted: networkPolicy.attempted,
      enforced: networkPolicy.enforced,
      backend: networkPolicy.backend,
      mode: networkPolicy.mode,
      reason: networkPolicy.reason,
    });
    if (!networkPolicy.enforced) {
      const reason = networkPolicy.reason ?? 'safe-mode no-egress policy failed';
      await writeSecurityCriticalEvent(
        {
          event: 'SecurityDegraded',
          reason,
          details: {
            guard: 'safe_mode_no_egress',
            attempted: networkPolicy.attempted,
          },
        },
        process.env,
      );
      if (inStrictMode(process.env)) {
        throw new MemphisExitError(
          EXIT_CODES.ERR_HARDENING,
          `hardening failed in strict mode: ${reason}`,
        );
      }
    }
  }

  if (config.RUST_EMBED_MODE === 'ollama') {
    const ollama = await checkOllama({ rawEnv: process.env });
    if (!ollama.ok) {
      throw errorTemplates.missingOllama({
        url: String(ollama.meta?.url ?? 'http://127.0.0.1:11434'),
        required: true,
        details: ollama.meta,
      });
    }
  }

  try {
    await verifyChainIntegrity();
    writeSecurityAudit({
      action: 'chain.verify.startup',
      status: 'allowed',
      details: { message: 'chain verification passed' },
    });
  } catch (error) {
    writeSecurityAudit({
      action: 'chain.verify.startup',
      status: 'error',
      details: { message: error instanceof Error ? error.message : 'chain verification failed' },
    });
    throw new MemphisExitError(
      EXIT_CODES.ERR_CORRUPTION,
      `chain integrity verification failed: ${error instanceof Error ? error.message : 'unknown error'}`,
      error,
    );
  }

  // Soul system: ensure manifest exists on disk before any MCP tool or system prompt reads it
  try {
    const soulManifest = ensureSoulManifest();
    writeSecurityAudit({
      action: 'soul.manifest.boot',
      status: 'allowed',
      details: {
        agentName: soulManifest.identity.agentName,
        generatedAt: soulManifest.generatedAt,
      },
    });
  } catch (error) {
    writeSecurityAudit({
      action: 'soul.manifest.boot',
      status: 'error',
      details: {
        message: error instanceof Error ? error.message : 'soul manifest generation failed',
      },
    });
    // Soul manifest failure is non-fatal — runtime continues without it
  }

  // ISKRA: generate soul identity prompt from manifest + memory
  try {
    ensureIskra();
  } catch {
    // ISKRA generation is non-fatal
  }

  // PULSE: write boot event + start heartbeat watchdog
  try {
    writeBootPulse();
    void appendBlock('system', {
      type: 'boot',
      source: 'bootstrap',
      schemaVersion: 1,
      content: `Memphis boot: provider=${config.DEFAULT_PROVIDER}`,
      tags: ['system', 'boot'],
    }).catch(() => undefined);
  } catch {
    // PULSE write is non-fatal
  }

  // Start heartbeat watchdog (periodic health monitoring)
  const watchdog = new HeartbeatWatchdog({
    onStateChange: (from, to, heartbeat) => {
      void appendBlock('system', {
        type: 'health_state_change',
        source: 'heartbeat-watchdog',
        schemaVersion: 1,
        content: `Health state changed to ${to}`,
        tags: ['system', 'health', to],
        checks: heartbeat.checks,
        uptimeSeconds: heartbeat.uptimeSeconds,
      }).catch(() => undefined);

      // Auto-restart on sustained unhealthy state (opt-in via env)
      const autoRestart =
        (process.env.MEMPHIS_WATCHDOG_AUTO_RESTART ?? '').toLowerCase() === 'true';
      if (autoRestart && from === 'degraded' && to === 'unhealthy') {
        bootstrapLog.error(
          { from, to, checks: heartbeat.checks },
          'watchdog: unhealthy state detected — scheduling auto-restart in 5s',
        );
        setTimeout(() => process.exit(1), 5000);
      }
    },
  });
  watchdog.start();

  const container = createAppContainer(config);
  await resumeRecoveredQueueTasksOnStartup(container, config, process.env);
  const app = createHttpServer(config, container.orchestration, {
    sessionRepository: container.sessionRepository,
    generationEventRepository: container.generationEventRepository,
    evolveSessionRepository: container.evolveSessionRepository,
    toolPermissionRepository: container.toolPermissionRepository,
    dualApprovalRepository: container.dualApprovalRepository,
    taskQueue: container.taskQueue,
    operatorChatSessionRepository: container.operatorChatSessionRepository,
    conversationContextService: container.conversationContextService,
    workPollingService: container.workPollingService,
  });

  await app.listen({ host: config.HOST, port: config.PORT });

  // ── Optional channel gateway ────────────────────────────────────
  await startChannelGateway({
    orchestration: container.orchestration,
    evolveSessionRepository: container.evolveSessionRepository,
    operatorChatSessionRepository: container.operatorChatSessionRepository,
    toolPermissionRepository: container.toolPermissionRepository,
  });

  startLocalWorkerIfEnabled(container);

  startReflectionLoop({ rawEnv: process.env });

  // Closes deferred item #5 — operators can opt into scheduled rotation
  // via MEMPHIS_CHAIN_ROTATE_INTERVAL_MS. Default (env unset) is no-op.
  const chainRotationHandle = startChainRotationLoop({ rawEnv: process.env });

  // Phase 1.2 production sprint — scheduled backup + restore-drill.
  // Operators opt in via MEMPHIS_BACKUP_INTERVAL_MS (default 24h once
  // set). Default (env unset) is no-op. Critical for client installs:
  // the first disk failure on an unscheduled-backup host wipes the
  // chain + vault and Memphis has no recovery path.
  const scheduledBackupHandle = startScheduledBackupLoop({ rawEnv: process.env });

  // Closes deferred item #3 — OpenTelemetry overlay. Starts the SDK only
  // when MEMPHIS_OTEL_ENDPOINT is set. Unset = no-op for operators who
  // don't run a collector.
  await initOtelIfEnabled(process.env);

  // Start built-in task scheduler
  startScheduler({
    workPollingService: container.workPollingService,
    executionTarget: resolveConfiguredSchedulerExecutionTarget(process.env),
  });
  await reportSchedulerWorkerFallback(getSchedulerRuntimeStatus(process.env), process.env);

  // Phase 1.1 production sprint: graceful shutdown on SIGTERM / SIGINT.
  // Drains in-flight turns, stops background loops, flushes PULSE + OTel,
  // then exits with the right code so a supervisor (systemd / docker /
  // pm2) restarts cleanly. Without this, container kills + systemctl
  // stop dropped in-flight turns mid-execution and could leave torn
  // chain/vault writes.
  installShutdownHandlers({
    rawEnv: process.env,
    stopFns: [
      { name: 'http-server', stop: () => app.close() },
      { name: 'heartbeat-watchdog', stop: () => watchdog.stop() },
      { name: 'chain-rotation-loop', stop: () => chainRotationHandle.stop() },
      { name: 'scheduled-backup-loop', stop: () => scheduledBackupHandle.stop() },
    ],
  });

  // Phase 2.3: we made it past every risky init step. Clear the boot-
  // failure counter so the next process starts at zero. If a self-modify
  // commit was the cause of a prior crash, this resets the auto-revert
  // bookkeeping for the new (presumably-good) code.
  recordBootSuccess(process.env);
}

const bootstrapLog = createPinoLogger({ level: process.env.LOG_LEVEL ?? 'info' });

export function resolveBootstrapEnvPath(rawEnv: NodeJS.ProcessEnv = process.env): string {
  const explicitPath = rawEnv.MEMPHIS_ENV_FILE?.trim();
  return explicitPath && explicitPath.length > 0 ? explicitPath : '.env';
}

export function resolveChannelGatewayToken(rawEnv: NodeJS.ProcessEnv = process.env): string | null {
  return resolveTelegramBotToken(rawEnv);
}

export function channelGatewayEnabled(rawEnv: NodeJS.ProcessEnv = process.env): boolean {
  return resolveTelegramGatewayEnabled(rawEnv);
}

async function startChannelGateway(container?: {
  orchestration?: import('../modules/orchestration/service.js').OrchestrationService;
  evolveSessionRepository?: import('../infra/storage/sqlite/repositories/evolve-session-repository.js').SqliteEvolveSessionRepository;
  operatorChatSessionRepository?: import('../infra/storage/sqlite/repositories/operator-chat-session-repository.js').SqliteOperatorChatSessionRepository;
  toolPermissionRepository?: import('../infra/storage/sqlite/repositories/tool-permission-repository.js').SqliteToolPermissionRepository;
  conversationContextService?: import('../gateway/conversation-context-service.js').ConversationContextService;
}): Promise<GatewayHandle | null> {
  if (!channelGatewayEnabled(process.env)) {
    bootstrapLog.info('MEMPHIS_CHANNEL_GATEWAY_ENABLED not set — channel gateway disabled');
    return null;
  }

  const telegramToken = resolveChannelGatewayToken(process.env);
  if (!telegramToken) {
    bootstrapLog.info(
      'MEMPHIS_CHANNEL_GATEWAY_ENABLED=true but Telegram token not set — channel gateway disabled',
    );
    return null;
  }

  const soulProviderName = process.env.SOUL_PROVIDER;
  let provider;
  try {
    provider = container?.orchestration?.resolveRuntimeProvider(
      (soulProviderName as ProviderName | undefined) ?? 'auto',
    );
  } catch (err) {
    bootstrapLog.warn({ err }, 'no LLM provider available — channel gateway disabled');
    return null;
  }
  if (!provider) {
    bootstrapLog.warn('no orchestration runtime available — channel gateway disabled');
    return null;
  }

  const cognitiveMode = getCognitiveMode();
  const llm = providerToLlmClient(provider, {
    temperature: getCognitiveModeConfig(cognitiveMode).temperature,
  });
  const memory = createInProcessMemoryClient();
  const toolExecutor = createInProcessToolExecutor({
    evolveSessionRepository: container?.evolveSessionRepository,
    permissionRepo: container?.toolPermissionRepository,
    caseAdapter: new CaseChainAdapter(process.env),
    projectRoot: process.cwd(),
  });

  const adapters: ChannelAdapter[] = [];

  adapters.push(
    createTelegramAdapter(telegramToken, {
      onStatus: () => {
        const allowlistCount = parseTelegramAllowedUserIds(process.env).length;
        const embedStatus = getRustEmbedAdapterStatus(process.env);
        const rustBridge = embedStatus.bridgeLoaded ? 'rust-napi' : 'ts-legacy';
        const mode = getCognitiveMode();
        const modeConfig = getCognitiveModeConfig(mode);
        const surfaceLines = formatSurfaceStatusLines(getActiveSurfacesSnapshot());
        return [
          `Memphis v${getAppVersion()}`,
          `LLM: ${provider.name} (${provider.defaultModel()})`,
          `Bridge: ${rustBridge}${embedStatus.embedApiAvailable ? ' + embed' : ''}`,
          `Tools: ${toolExecutor.listTools().length} tools`,
          `Allowlist: ${allowlistCount > 0 ? `${allowlistCount} ids` : 'open'}`,
          `Cognitive mode: ${mode} (${modeConfig.name})`,
          ...surfaceLines,
        ].join('\n');
      },
      onRecall: async (userId) => {
        const actorId = resolveActorId(userId, process.env);
        const ctx = await memory.recall(actorId, 'recent conversations topics identity', 8);
        if (ctx.items.length === 0) return 'No memories stored yet.';
        return (
          'What I remember:\n' + ctx.items.map((i) => `• ${i.content.slice(0, 120)}`).join('\n')
        );
      },
      onChains: async () => {
        const CHAINS = [
          'journal',
          'decisions',
          'system',
          'reflections',
          'cases',
          'collective',
          'patterns',
        ];
        const lines: string[] = ['Chains (Rust NAPI):'];
        for (const chain of CHAINS) {
          try {
            const result = await verifyChainIntegrity(chain);
            lines.push(`  ${chain}: ${result.blockCount} blocks ${result.ok ? '✓' : '✗'}`);
          } catch {
            lines.push(`  ${chain}: error`);
          }
        }
        return lines.join('\n');
      },
      onSearch: async (query) => {
        try {
          const result = embedSearch(query, 5);
          if (result.count === 0) return `No results for: ${query}`;
          const hits = result.hits
            .map((h, i) => `${i + 1}. [${h.score.toFixed(3)}] ${h.text_preview.slice(0, 100)}`)
            .join('\n');
          return `Semantic search: "${query}" (${result.count} hits)\n${hits}`;
        } catch (err) {
          return `Search error: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
      onStartupContext: async (_userId, sessionTier) => {
        const tierLabel =
          sessionTier === 2
            ? 'tier 2 — default full companion mode (tier2 tools + URL fetch active)'
            : sessionTier === 1
              ? 'tier 1 — reduced companion mode (lowered tool surface, URL fetch disabled)'
              : 'tier 0 — safe lock-down (memory tools only; use /tier 2 to restore defaults)';
        const parts: string[] = ['<startup_context>', `Session tier: ${tierLabel}`];
        parts.push(
          'Surface design: Telegram is a companion gateway surface. The Rust TUI remains the authoritative operator cockpit for native chat, vault, memory, sessions, and system inspection.',
        );

        // Soul memory — who the operator is, active work, recent decisions
        const soulMem = loadSoulMemory();
        if (!soulMem) {
          bootstrapLog.warn(
            '[startup-context] soul memory not found — cold start (run memphis init to fix)',
          );
        }
        if (soulMem) {
          const user = soulMem.user;
          const ctx = soulMem.context;
          const self = soulMem.self;
          if (user.name) parts.push(`Operator: ${user.name}`);
          if (user.languages.length > 0) parts.push(`Languages: ${user.languages.join(', ')}`);
          if (user.expertise.length > 0) parts.push(`Expertise: ${user.expertise.join(', ')}`);
          if (user.preferences.length > 0)
            parts.push(`Preferences: ${user.preferences.join('; ')}`);
          if (ctx.activeWork) parts.push(`Active work: ${ctx.activeWork}`);
          if (ctx.recentDecisions.length > 0) {
            parts.push(
              `Recent decisions:\n${ctx.recentDecisions
                .slice(-3)
                .map((d) => `- ${d}`)
                .join('\n')}`,
            );
          }
          if (self.learnings.length > 0) {
            parts.push(
              `Known learnings:\n${self.learnings
                .slice(-3)
                .map((l) => `- ${l}`)
                .join('\n')}`,
            );
          }
        }

        // Recent journal memory via Rust NAPI HNSW
        let embedOk = false;
        try {
          const recent = embedSearch('recent session activity work', 4);
          if (recent.count > 0) {
            const entries = recent.hits.map((h) => `- ${h.text_preview.slice(0, 120)}`).join('\n');
            parts.push(`Recent memory (semantic):\n${entries}`);
          }
          embedOk = true;
        } catch (err) {
          bootstrapLog.warn(
            { err },
            '[startup-context] embed bridge unavailable — starting without semantic memory',
          );
          parts.push(
            '[EMBEDDINGS: UNAVAILABLE — NAPI bridge down. Journal recall disabled this session.]',
          );
        }

        parts.push(
          `[STARTUP: ${soulMem && embedOk ? 'FULL' : soulMem ? 'PARTIAL — no semantic memory' : 'COLD — no soul memory or embeddings'}]`,
        );
        parts.push('</startup_context>');
        return parts.join('\n');
      },
    }),
  );

  const handle = await startGateway({
    adapters,
    memory,
    llm,
    toolExecutor,
    conversationContext: container?.conversationContextService,
    sessions: container?.operatorChatSessionRepository
      ? createOperatorChatSessionStore(container.operatorChatSessionRepository)
      : undefined,
  });

  bootstrapLog.info(
    {
      provider: provider.name,
      model: provider.defaultModel(),
      tools: toolExecutor.listTools().length,
    },
    'Channel gateway started (Telegram)',
  );

  return handle;
}

export interface StartupSecurityGuardResult {
  trustRootStatus: TrustRootStartupStatus;
  revocationCacheStatus: RevocationCacheStartupStatus;
}

interface StartupSecurityGuardOptions {
  nowMs?: number;
  writeSecurityEvent?: typeof writeSecurityCriticalEvent;
}

export async function runStartupSecurityGuards(
  rawEnv: NodeJS.ProcessEnv,
  options: StartupSecurityGuardOptions = {},
): Promise<StartupSecurityGuardResult> {
  const writeSecurityEvent = options.writeSecurityEvent ?? writeSecurityCriticalEvent;

  const trustRootStatus = evaluateTrustRootStartup(rawEnv);
  setStartupTrustRootStatus(trustRootStatus);
  if (trustRootStatus.enabled && !trustRootStatus.valid) {
    const reason = trustRootStatus.reason ?? 'trust root validation failed';
    await writeSecurityEvent(
      {
        event: 'TrustRootRejected',
        reason,
        details: {
          path: trustRootStatus.path,
        },
      },
      rawEnv,
    );
    if (inStrictMode(rawEnv)) {
      throw new MemphisExitError(
        EXIT_CODES.ERR_TRUST_ROOT,
        `trust root rejected in strict mode: ${reason}`,
      );
    }
  }

  const revocationCacheStatus = evaluateRevocationCacheStartup(rawEnv, options.nowMs);
  setStartupRevocationCacheStatus(revocationCacheStatus);
  if (revocationCacheStatus.enabled && revocationCacheStatus.stale) {
    const reason = revocationCacheStatus.reason ?? 'revocation cache is stale';
    await writeSecurityEvent(
      {
        event: 'StaleRevocationCache',
        reason,
        severity: 'high',
        details: {
          maxStaleMs: revocationCacheStatus.maxStaleMs,
          lastSyncMs: revocationCacheStatus.lastSyncMs,
          ageMs: revocationCacheStatus.ageMs,
        },
      },
      rawEnv,
    );
  }

  return { trustRootStatus, revocationCacheStatus };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseProviderName(value: unknown): ProviderName | undefined {
  if (
    value === 'shared-llm' ||
    value === 'decentralized-llm' ||
    value === 'local-fallback' ||
    value === 'ollama'
  ) {
    return value;
  }
  return undefined;
}

function parseGenerateOptions(value: unknown): GenerateOptions | undefined {
  if (!isObject(value)) return undefined;
  const out: GenerateOptions = {};
  if (typeof value.temperature === 'number') out.temperature = value.temperature;
  if (typeof value.maxTokens === 'number') out.maxTokens = Math.trunc(value.maxTokens);
  if (typeof value.timeoutMs === 'number') out.timeoutMs = Math.trunc(value.timeoutMs);
  return Object.keys(out).length > 0 ? out : undefined;
}

function parseQueuedChatPayload(value: unknown):
  | (GenerateInput & {
      provider?: 'auto' | ProviderName;
    })
  | null {
  if (!isObject(value)) return null;
  if (typeof value.input !== 'string' || value.input.trim().length === 0) return null;

  const provider =
    value.provider === 'auto'
      ? 'auto'
      : value.provider === null || value.provider === undefined
        ? undefined
        : parseProviderName(value.provider);
  if (value.provider !== undefined && value.provider !== null && !provider) {
    return null;
  }

  const strategy =
    value.strategy === 'latency-aware'
      ? 'latency-aware'
      : value.strategy === 'default' || value.strategy === null || value.strategy === undefined
        ? 'default'
        : null;
  if (!strategy) return null;

  return {
    input: value.input,
    provider,
    model: typeof value.model === 'string' ? value.model : undefined,
    sessionId: typeof value.sessionId === 'string' ? value.sessionId : undefined,
    options: parseGenerateOptions(value.options),
    strategy,
  };
}

export interface StartupQueueResumeSelection {
  policy: TaskQueueResumePolicy;
  safeModeOverrideApplied: boolean;
}

type StartupQueueRedispatchTarget = 'local' | 'workers';

type StartupQueueRedispatchSelection = {
  requestedTarget: StartupQueueRedispatchTarget;
  effectiveTarget: StartupQueueRedispatchTarget;
  degradedReason?: string;
};

interface StartupQueueResumer {
  resumeRecoveredPending(input?: {
    policy?: TaskQueueResumePolicy;
    redispatch?: (
      task: QueuePendingTask,
    ) => Promise<TaskQueueStatus | void> | TaskQueueStatus | void;
  }): Promise<TaskQueueResumeResult>;
}

export function resolveStartupQueueResumePolicy(
  config: Pick<AppConfig, 'MEMPHIS_QUEUE_RESUME_POLICY'>,
  rawEnv: NodeJS.ProcessEnv,
): StartupQueueResumeSelection {
  if (safeModeEnabled(rawEnv) && config.MEMPHIS_QUEUE_RESUME_POLICY === 'redispatch') {
    return { policy: 'keep', safeModeOverrideApplied: true };
  }
  return {
    policy: config.MEMPHIS_QUEUE_RESUME_POLICY,
    safeModeOverrideApplied: false,
  };
}

export async function runStartupQueueResume(
  queue: StartupQueueResumer,
  config: Pick<AppConfig, 'MEMPHIS_QUEUE_RESUME_POLICY'>,
  rawEnv: NodeJS.ProcessEnv,
  redispatch: (task: QueuePendingTask) => Promise<TaskQueueStatus | void> | TaskQueueStatus | void,
): Promise<TaskQueueResumeResult & { safeModeOverrideApplied: boolean }> {
  const selection = resolveStartupQueueResumePolicy(config, rawEnv);
  const resumed = await queue.resumeRecoveredPending({
    policy: selection.policy,
    redispatch,
  });
  return {
    ...resumed,
    safeModeOverrideApplied: selection.safeModeOverrideApplied,
  };
}

function resolveStartupQueueRedispatchTarget(
  rawEnv: NodeJS.ProcessEnv,
  container: ReturnType<typeof createAppContainer>,
): StartupQueueRedispatchSelection {
  const requestedTarget: StartupQueueRedispatchTarget =
    rawEnv.MEMPHIS_QUEUE_REDISPATCH_TARGET?.trim() === 'workers' ? 'workers' : 'local';

  if (requestedTarget === 'workers') {
    const snapshot = container.workPollingService.snapshot();
    if (!snapshot.tokenReady) {
      const degradedReason =
        'worker session tokens are not ready; falling back to local redispatch';
      addBootstrapWarning({
        component: 'work-polling',
        message: 'Startup queue redispatch fell back to local execution',
        detail: degradedReason,
      });
      return {
        requestedTarget,
        effectiveTarget: 'local',
        degradedReason,
      };
    }
  }

  return { requestedTarget, effectiveTarget: requestedTarget };
}

async function redispatchRecoveredTask(
  task: QueuePendingTask,
  container: ReturnType<typeof createAppContainer>,
): Promise<TaskQueueStatus> {
  if (task.task.type !== 'chat.generate') {
    return 'failed';
  }

  const queuedInput = parseQueuedChatPayload(task.task.payload);
  if (!queuedInput) {
    return 'failed';
  }

  if (queuedInput.sessionId) {
    container.sessionRepository.ensureSession(queuedInput.sessionId);
  }

  const result = await container.orchestration.generate({
    input: queuedInput.input,
    provider: queuedInput.provider,
    model: queuedInput.model,
    sessionId: queuedInput.sessionId,
    options: queuedInput.options,
    strategy: queuedInput.strategy,
    execution: {
      taskId: task.taskId,
      runId: task.taskId,
      source: 'queue.redispatch',
      enableReplayDedupe: true,
    },
  });

  const requestIdFromMetadata =
    typeof task.task.metadata?.requestId === 'string' ? task.task.metadata.requestId : undefined;
  container.generationEventRepository.create({
    id: result.id || `gen_${randomUUID()}`,
    sessionId: queuedInput.sessionId,
    providerUsed: result.providerUsed,
    modelUsed: result.modelUsed,
    timingMs: result.timingMs,
    requestId: task.task.requestId ?? requestIdFromMetadata,
  });

  return 'completed';
}

async function enqueueRecoveredTaskForWorkers(
  task: QueuePendingTask,
  container: ReturnType<typeof createAppContainer>,
): Promise<TaskQueueStatus> {
  const queuedInput = parseQueuedChatPayload(task.task.payload);
  const metadata = task.task.metadata ?? {};
  const dispatch = buildChatDispatchWorkItem(
    {
      input: queuedInput?.input,
      provider: queuedInput?.provider,
      model: queuedInput?.model,
      sessionId: queuedInput?.sessionId,
      options: queuedInput?.options,
      strategy: queuedInput?.strategy,
      userId:
        typeof metadata.userId === 'string' && metadata.userId.trim().length > 0
          ? metadata.userId
          : undefined,
    },
    task.task.requestId ?? task.taskId,
    {
      queueTaskId: task.taskId,
    },
  );

  container.workPollingService.enqueueWork(dispatch.workInput);

  return 'completed';
}

function buildLocalWorkerRuntimeDeps(
  container: ReturnType<typeof createAppContainer>,
): HttpChatRuntimeDeps {
  return {
    memory: createInProcessMemoryClient(),
    toolExecutor: createInProcessToolExecutor({
      evolveSessionRepository: container.evolveSessionRepository,
      permissionRepo: container.toolPermissionRepository,
      caseAdapter: new CaseChainAdapter(process.env),
      projectRoot: process.cwd(),
    }),
    operatorChatSessionRepository: container.operatorChatSessionRepository,
    conversationContextService: container.conversationContextService,
  };
}

function localWorkerEnabled(rawEnv: NodeJS.ProcessEnv = process.env): boolean {
  return rawEnv.MEMPHIS_LOCAL_WORKER_ENABLED?.trim().toLowerCase() === 'true';
}

function parsePositiveMs(raw: string | undefined, fallback: number): number {
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.trunc(value) : fallback;
}

function startLocalWorkerIfEnabled(
  container: ReturnType<typeof createAppContainer>,
): LocalWorkerRunner | null {
  const workerId =
    process.env.MEMPHIS_LOCAL_WORKER_ID?.trim() || `local-worker:${configurableWorkerHostTag()}`;
  const capabilityScope = [...DEFAULT_LOCAL_WORKER_CAPABILITY_SCOPE];
  const tokenReady = container.workPollingService.snapshot().tokenReady;

  if (!localWorkerEnabled(process.env)) {
    setLocalWorkerRuntimeStatus({
      enabled: false,
      source: 'bootstrap',
      state: 'disabled',
      workerId,
      capabilityScope,
      tokenReady,
      lastOutcome: 'none',
      processed: {
        leased: 0,
        completed: 0,
        failed: 0,
        emptyPolls: 0,
      },
    });
    bootstrapLog.info('MEMPHIS_LOCAL_WORKER_ENABLED not set — local worker disabled');
    return null;
  }

  if (!tokenReady) {
    setLocalWorkerRuntimeStatus({
      enabled: true,
      source: 'bootstrap',
      state: 'error',
      workerId,
      capabilityScope,
      tokenReady: false,
      lastOutcome: 'none',
      lastError: 'worker session tokens are not ready',
      processed: {
        leased: 0,
        completed: 0,
        failed: 0,
        emptyPolls: 0,
      },
    });
    addBootstrapWarning({
      component: 'local-worker',
      message: 'Local worker disabled',
      detail: 'worker session tokens are not ready',
    });
    bootstrapLog.warn('Local worker disabled because worker session tokens are not ready');
    return null;
  }

  const runner = new LocalWorkerRunner(
    {
      workPollingService: container.workPollingService,
      orchestration: container.orchestration,
      runtime: buildLocalWorkerRuntimeDeps(container),
      sessionRepository: container.sessionRepository,
      generationEventRepository: container.generationEventRepository,
      operatorChatSessionRepository: container.operatorChatSessionRepository,
    },
    {
      workerId,
      waitMs: parsePositiveMs(process.env.MEMPHIS_LOCAL_WORKER_WAIT_MS, 5_000),
      refreshSkewMs: parsePositiveMs(process.env.MEMPHIS_LOCAL_WORKER_REFRESH_SKEW_MS, 15_000),
      capabilityScope,
      source: 'bootstrap',
    },
  );
  runner.start();
  const stop = () => void runner.stop();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  bootstrapLog.info({ workerId }, 'Local worker runner started');
  return runner;
}

function configurableWorkerHostTag(): string {
  return process.env.HOSTNAME?.trim() || process.pid.toString();
}

export async function resumeRecoveredQueueTasksOnStartup(
  container: ReturnType<typeof createAppContainer>,
  config: AppConfig,
  rawEnv: NodeJS.ProcessEnv,
): Promise<void> {
  const target = resolveStartupQueueRedispatchTarget(rawEnv, container);
  let workerQueued = 0;
  const resumed = await runStartupQueueResume(container.taskQueue, config, rawEnv, async (task) => {
    if (target.effectiveTarget === 'workers') {
      workerQueued += 1;
      return enqueueRecoveredTaskForWorkers(task, container);
    }
    return redispatchRecoveredTask(task, container);
  });

  setStartupQueueResumeStatus({
    policy: resumed.policy,
    safeModeOverrideApplied: resumed.safeModeOverrideApplied,
    requestedTarget: target.requestedTarget,
    effectiveTarget: target.effectiveTarget,
    degradedTargetReason: target.degradedReason,
    workerQueued,
    scanned: resumed.scanned,
    redispatched: resumed.redispatched,
    failed: resumed.failed,
    canceled: resumed.canceled,
    kept: resumed.kept,
    errors: resumed.errors,
  });

  if (resumed.scanned === 0) return;

  writeSecurityAudit({
    action: 'queue.resume.startup',
    status: resumed.errors.length > 0 ? 'error' : 'allowed',
    details: {
      policy: resumed.policy,
      safeModeOverrideApplied: resumed.safeModeOverrideApplied,
      requestedTarget: target.requestedTarget,
      effectiveTarget: target.effectiveTarget,
      degradedTargetReason: target.degradedReason,
      workerQueued,
      scanned: resumed.scanned,
      redispatched: resumed.redispatched,
      failed: resumed.failed,
      canceled: resumed.canceled,
      kept: resumed.kept,
      errors: resumed.errors,
    },
  });
}
