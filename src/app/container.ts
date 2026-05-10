/* eslint-disable no-restricted-syntax */
//
// Config-source / threading file — reads process.env directly for
// dynamic-key operations or to pass rawEnv into typed helpers that
// themselves use env-registry. Per Sprint ι policy, file-level
// disable instead of accessor-bloat.
//
import { dirname, join } from 'node:path';

import { ConversationContextService } from '../gateway/conversation-context-service.js';
import { registerPostApplyHook } from '../infra/config/post-apply-hooks.js';
import type { AppConfig } from '../infra/config/schema.js';
import { createSqliteClient, runMigrations } from '../infra/storage/sqlite/client.js';
import { SqliteAgentPeerRepository } from '../infra/storage/sqlite/repositories/agent-peer-repository.js';
import { SqliteConversationCompactionRepository } from '../infra/storage/sqlite/repositories/conversation-compaction-repository.js';
import { SqliteDualApprovalRepository } from '../infra/storage/sqlite/repositories/dual-approval-repository.js';
import { SqliteEvolveSessionRepository } from '../infra/storage/sqlite/repositories/evolve-session-repository.js';
import { SqliteGenerationEventRepository } from '../infra/storage/sqlite/repositories/generation-event-repository.js';
import { SqliteOperatorChatSessionRepository } from '../infra/storage/sqlite/repositories/operator-chat-session-repository.js';
import { SeenProposalRepository } from '../infra/storage/sqlite/repositories/seen-proposal-repository.js';
import { SqliteSessionMemoryRepository } from '../infra/storage/sqlite/repositories/session-memory-repository.js';
import { SqliteSessionRepository } from '../infra/storage/sqlite/repositories/session-repository.js';
import { SqliteToolPermissionRepository } from '../infra/storage/sqlite/repositories/tool-permission-repository.js';
import { SqliteWebhookEventRepository } from '../infra/storage/sqlite/repositories/webhook-event-repository.js';
import { SqliteWorkItemRepository } from '../infra/storage/sqlite/repositories/work-item-repository.js';
import { SqliteWorkerSessionRepository } from '../infra/storage/sqlite/repositories/worker-session-repository.js';
import { TaskQueueService } from '../infra/storage/task-queue-service.js';
import { CapacityWake } from '../infra/work/capacity-wake.js';
import { SessionTokenService } from '../infra/work/session-token-service.js';
import { WorkPollingService } from '../infra/work/work-polling-service.js';
import { OrchestrationService, parseCascadeOrder } from '../modules/orchestration/service.js';
import { reportProviderKeyConflicts } from '../providers/conflict-detection.js';
import { createConfiguredRuntimeProviders } from '../providers/runtime-registry.js';

function defaultWalPath(databaseUrl: string): string {
  if (!databaseUrl.startsWith('file:')) {
    return './data/queue.wal';
  }
  const dbPath = databaseUrl.replace(/^file:/, '');
  return join(dirname(dbPath), 'queue.wal');
}

export function createAppContainer(
  config: AppConfig,
  sqliteDb?: ReturnType<typeof createSqliteClient>,
) {
  const db = sqliteDb ?? createSqliteClient(config.DATABASE_URL);
  if (!sqliteDb) runMigrations(db);

  const sessionRepository = new SqliteSessionRepository(db);
  const operatorChatSessionRepository = new SqliteOperatorChatSessionRepository(db);
  const generationEventRepository = new SqliteGenerationEventRepository(db);
  const sessionMemoryRepository = new SqliteSessionMemoryRepository(db);
  const conversationCompactionRepository = new SqliteConversationCompactionRepository(db);
  const dualApprovalRepository = new SqliteDualApprovalRepository(db);
  const evolveSessionRepository = new SqliteEvolveSessionRepository(db);
  const toolPermissionRepository = new SqliteToolPermissionRepository(db);
  const seenProposalRepository = new SeenProposalRepository(db);
  const webhookEventRepository = new SqliteWebhookEventRepository(db);
  const agentPeerRepository = new SqliteAgentPeerRepository(db);
  const workerSessionRepository = new SqliteWorkerSessionRepository(db);
  const workItemRepository = new SqliteWorkItemRepository(db);
  const taskQueue = new TaskQueueService({
    walPath: config.MEMPHIS_QUEUE_WAL_PATH ?? defaultWalPath(config.DATABASE_URL),
    mode: config.MEMPHIS_QUEUE_MODE ?? 'financial',
    resumePolicy: config.MEMPHIS_QUEUE_RESUME_POLICY ?? 'keep',
    maxPendingTasks: config.MEMPHIS_MAX_PENDING_TASKS ?? 100,
    maxWalBytes: config.MEMPHIS_QUEUE_WAL_MAX_BYTES,
    faultInject: config.MEMPHIS_FAULT_INJECT,
  });

  const { providers, checks } = createConfiguredRuntimeProviders(config, process.env);

  for (const check of checks) {
    if (check.resolution.source === 'conflict') {
      console.warn(
        `[memphis-provider] SECURITY: ${check.provider} vault misconfigured — ` +
          `${check.resolution.vaultError}. Plaintext fallback exists but will NOT be used. ` +
          `Fix: run 'memphis provider add ${check.provider} --api-key <key>' to re-store in vault.`,
      );
    }
  }

  const conflictOutcome = reportProviderKeyConflicts(process.env);
  if (conflictOutcome.shouldExit) {
    process.exit(1);
  }

  // `fallbackProvider` is the SINGLE next-attempt provider when the
  // primary throws (any error — 400/4xx/5xx). It used to be set to
  // `local-fallback` (deterministic stub from
  // `src/providers/local-fallback/adapter.ts`), so when operator hit
  // Anthropic 400 "Your credit balance is too low" on 2026-05-10 the
  // bot's fallback reply was the stub's templated response — garbage
  // from operator's view, hence "bot się zwiesił na braku tokenów".
  // Switch to `ollama` (local cogito:3b via Ollama daemon) so the
  // fallback is a REAL LLM that produces usable replies even when the
  // cloud primary 4xx's. `local-fallback` stays as the cascade tail
  // (`cascadeOrder`) — invoked only when ollama itself fails.
  //
  // Trade-off: ollama on CPU is ~5x slower than cloud Anthropic, so
  // fallback turns may run 30-60s instead of 3-10s. Acceptable —
  // slow real reply > instant garbage reply.
  const orchestration = new OrchestrationService({
    defaultProvider: config.DEFAULT_PROVIDER,
    fallbackProvider: 'ollama',
    maxRetries: 2,
    providerCooldownMs: 15_000,
    providers,
    cascadeOrder: parseCascadeOrder(config.MEMPHIS_PROVIDER_CASCADE),
  });

  // Hot-swap: when the operator changes DEFAULT_PROVIDER via /config set,
  // the post-apply hook (Sprint: provider hot-swap) updates the live cache
  // so the very next turn lands on the new default. Without this hook the
  // env value would update but OrchestrationService would keep its
  // construction-time default until restart.
  registerPostApplyHook('DEFAULT_PROVIDER', 'orchestration.setDefaultProvider', (ctx) => {
    if (!ctx.nextValue) return;
    orchestration.setDefaultProvider(ctx.nextValue);
  });
  const sessionTokenService = new SessionTokenService(
    process.env.MEMPHIS_SESSION_TOKEN_SECRET ??
      config.MEMPHIS_API_TOKEN ??
      process.env.MEMPHIS_API_TOKEN,
  );
  const capacityWake = new CapacityWake();
  const conversationContextService = new ConversationContextService(
    operatorChatSessionRepository,
    sessionMemoryRepository,
    conversationCompactionRepository,
  );
  const workPollingService = new WorkPollingService(
    workerSessionRepository,
    workItemRepository,
    sessionTokenService,
    capacityWake,
  );

  return {
    orchestration,
    sessionRepository,
    operatorChatSessionRepository,
    generationEventRepository,
    sessionMemoryRepository,
    conversationCompactionRepository,
    conversationContextService,
    dualApprovalRepository,
    evolveSessionRepository,
    toolPermissionRepository,
    seenProposalRepository,
    webhookEventRepository,
    agentPeerRepository,
    workerSessionRepository,
    workItemRepository,
    sessionTokenService,
    capacityWake,
    workPollingService,
    taskQueue,
  };
}
