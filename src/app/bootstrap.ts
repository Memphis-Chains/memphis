import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';

import pino from 'pino';

import { createAppContainer } from './container.js';
import { AppError, errorTemplates } from '../core/errors.js';
import type { GenerateInput, GenerateOptions, ProviderName } from '../core/types.js';
import { createTelegramAdapter } from '../gateway/channels/telegram.js';
import { startGateway, type GatewayHandle } from '../gateway/chat-loop.js';
import type { ChannelAdapter } from '../gateway/chat-types.js';
import { createInProcessMemoryClient } from '../gateway/memory-client.js';
import { providerToLlmClient } from '../gateway/provider-adapter.js';
import { createInProcessToolExecutor } from '../gateway/tool-executor.js';
import { checkOllama, checkRustToolchain } from '../infra/cli/utils/dependencies.js';
import { loadConfig } from '../infra/config/env.js';
import type { AppConfig } from '../infra/config/schema.js';
import { createHttpServer } from '../infra/http/server.js';
import { startAlertSuppressionFlushLoop } from '../infra/logging/alert-runtime.js';
import { writeSecurityAudit } from '../infra/logging/security-audit.js';
import { inStrictMode } from '../infra/runtime/emergency-log.js';
import { EXIT_CODES, MemphisExitError } from '../infra/runtime/exit-codes.js';
import { enforceSafeModeNoEgress, safeModeEnabled } from '../infra/runtime/safe-mode.js';
import { writeSecurityCriticalEvent } from '../infra/runtime/security-critical.js';
import {
  evaluateRevocationCacheStartup,
  evaluateTrustRootStartup,
  type RevocationCacheStartupStatus,
  type TrustRootStartupStatus,
} from '../infra/runtime/startup-guards.js';
import {
  setStartupRevocationCacheStatus,
  setStartupQueueResumeStatus,
  setStartupSafeModeNetworkStatus,
  setStartupTrustRootStatus,
} from '../infra/runtime/startup-state.js';
import { appendBlock, verifyChainIntegrity } from '../infra/storage/chain-adapter.js';
import type {
  QueuePendingTask,
  TaskQueueResumeResult,
  TaskQueueResumePolicy,
  TaskQueueStatus,
} from '../infra/storage/task-queue-service.js';
import { resolveProvider, defaultProviderConfig } from '../providers/index.js';
import { ReflectionEngine } from '../reflection/engine.js';
import { isSoulBootNeeded } from '../soul/boot.js';
import { ensureSoulManifest } from '../soul/manifest.js';
import { seedSoulIdentity } from '../soul/seed.js';

export async function bootstrap(): Promise<void> {
  if (!existsSync('.env')) {
    const isTTY = process.stdin.isTTY && process.stdout.isTTY;
    if (isTTY) {
      console.log('\n  Memphis has not been initialized yet.\n');
      console.log('  Run:  memphis init\n');
      console.log('  This will set up your .env, vault, and provider configuration.\n');
    }
    throw errorTemplates.missingEnv();
  }

  const rust = checkRustToolchain();
  if (!rust.ok && rust.required) {
    throw new AppError('CONFIG_ERROR', rust.detail, 500, rust.meta, rust.fix);
  }

  const config = loadConfig();
  startAlertSuppressionFlushLoop(process.env);

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

  // Soul seeding: write foundational journal + case entries on first boot
  try {
    if (isSoulBootNeeded()) {
      const seedResult = await seedSoulIdentity();
      if (seedResult.seeded) {
        bootstrapLog.info(
          {
            journalEntries: seedResult.journalEntries,
            caseEntries: seedResult.caseEntries,
          },
          'soul identity seeded on first boot',
        );
      }
    }
  } catch (error) {
    const msg = 'soul seed failed (non-fatal)';
    bootstrapLog.warn({ err: error instanceof Error ? error.message : String(error) }, msg);
  }

  const container = createAppContainer(config);
  await resumeRecoveredQueueTasksOnStartup(container, config, process.env);
  const app = createHttpServer(config, container.orchestration, {
    sessionRepository: container.sessionRepository,
    generationEventRepository: container.generationEventRepository,
    dualApprovalRepository: container.dualApprovalRepository,
    taskQueue: container.taskQueue,
  });

  await app.listen({ host: config.HOST, port: config.PORT });

  // ── Optional channel gateway ────────────────────────────────────
  await startChannelGateway(container);

  // Schedule daily self-reflection (every 24h)
  scheduleReflection();
}

const bootstrapLog = pino({ level: process.env.LOG_LEVEL ?? 'info' });

export function resolveChannelGatewayToken(rawEnv: NodeJS.ProcessEnv = process.env): string | null {
  const override = rawEnv.MEMPHIS_TELEGRAM_TOKEN_OVERRIDE?.trim();
  if (override && override.length > 0) {
    return override;
  }
  const token = rawEnv.MEMPHIS_TELEGRAM_BOT_TOKEN ?? rawEnv.TELEGRAM_BOT_TOKEN;
  const trimmed = token?.trim() ?? '';
  return trimmed.length > 0 ? trimmed : null;
}

export function channelGatewayEnabled(rawEnv: NodeJS.ProcessEnv = process.env): boolean {
  return (rawEnv.MEMPHIS_CHANNEL_GATEWAY_ENABLED ?? '').toLowerCase() === 'true';
}

async function startChannelGateway(container?: {
  evolveSessionRepository?: import('../infra/storage/sqlite/repositories/evolve-session-repository.js').SqliteEvolveSessionRepository;
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

  // Resolve LLM provider — prefer SOUL_PROVIDER if set, otherwise use priority chain
  const soulProviderName = process.env.SOUL_PROVIDER;
  let provider;
  try {
    if (soulProviderName) {
      const config = defaultProviderConfig();
      const match = config.providers.find((p) => p.name === soulProviderName);
      if (match) {
        // Move the preferred provider to top priority
        config.providers = [
          { ...match, priority: 0 },
          ...config.providers.filter((p) => p.name !== soulProviderName),
        ];
      }
      provider = await resolveProvider(config);
    } else {
      provider = await resolveProvider(defaultProviderConfig());
    }
  } catch (err) {
    bootstrapLog.warn({ err }, 'no LLM provider available — channel gateway disabled');
    return null;
  }

  const llm = providerToLlmClient(provider);
  const memory = createInProcessMemoryClient();
  const toolExecutor = createInProcessToolExecutor({
    evolveSessionRepository: container?.evolveSessionRepository,
    projectRoot: process.cwd(),
  });

  const adapters: ChannelAdapter[] = [];

  adapters.push(
    createTelegramAdapter(telegramToken, {
      onStatus: () =>
        [
          '🟢 Soul — online',
          `LLM: ${provider.name} (${provider.defaultModel()})`,
          'Memory: Memphis (in-process)',
          `Tools: ${toolExecutor.listTools().length} tools`,
          'Gateway: Memphis direct',
        ].join('\n'),
      onRecall: async (userId) => {
        const ctx = await memory.recall(userId, 'recent conversations topics identity', 8);
        if (ctx.items.length === 0) return 'No memories stored yet.';
        return (
          'What I remember:\n' + ctx.items.map((i) => `• ${i.content.slice(0, 120)}`).join('\n')
        );
      },
    }),
  );

  const handle = await startGateway({
    adapters,
    memory,
    llm,
    toolExecutor,
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

export async function resumeRecoveredQueueTasksOnStartup(
  container: ReturnType<typeof createAppContainer>,
  config: AppConfig,
  rawEnv: NodeJS.ProcessEnv,
): Promise<void> {
  const resumed = await runStartupQueueResume(container.taskQueue, config, rawEnv, async (task) =>
    redispatchRecoveredTask(task, container),
  );

  setStartupQueueResumeStatus({
    policy: resumed.policy,
    safeModeOverrideApplied: resumed.safeModeOverrideApplied,
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
      scanned: resumed.scanned,
      redispatched: resumed.redispatched,
      failed: resumed.failed,
      canceled: resumed.canceled,
      kept: resumed.kept,
      errors: resumed.errors,
    },
  });
}

const REFLECTION_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

function scheduleReflection(): void {
  const engine = new ReflectionEngine();

  async function runReflection(): Promise<void> {
    try {
      const reflections = await engine.reflectDaily('scheduled', new Map());
      await appendBlock('reflections', {
        type: 'reflection_report',
        source: 'scheduled',
        content: `Scheduled reflection: ${reflections.length} reflections generated`,
        tags: ['reflection', 'scheduled', 'daily'],
        report: {
          generatedAt: new Date().toISOString(),
          count: reflections.length,
          reflections: reflections.slice(0, 20).map((r) => ({
            ...r,
            context: Object.fromEntries(r.context.entries()),
            timestamp: r.timestamp.toISOString(),
          })),
        },
      });
    } catch {
      // Reflection is best-effort — don't crash the server
    }
  }

  // Run first reflection 5 minutes after startup, then every 24h
  setTimeout(
    () => {
      void runReflection();
      setInterval(() => void runReflection(), REFLECTION_INTERVAL_MS);
    },
    5 * 60 * 1000,
  );
}
