import { dirname, join } from 'node:path';

import { ConversationContextService } from '../gateway/conversation-context-service.js';
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
import { OrchestrationService } from '../modules/orchestration/service.js';
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

  const orchestration = new OrchestrationService({
    defaultProvider: config.DEFAULT_PROVIDER,
    fallbackProvider: 'local-fallback',
    maxRetries: 2,
    providerCooldownMs: 15_000,
    providers,
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
