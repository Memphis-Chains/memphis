import type { LLMProvider } from '../core/contracts/llm-provider.js';
import type { AppConfig } from '../infra/config/schema.js';
import { createSqliteClient, runMigrations } from '../infra/storage/sqlite/client.js';
import { SqliteGenerationEventRepository } from '../infra/storage/sqlite/repositories/generation-event-repository.js';
import { SqliteSessionRepository } from '../infra/storage/sqlite/repositories/session-repository.js';
import { OrchestrationService } from '../modules/orchestration/service.js';
import { DecentralizedLlmProvider } from '../providers/decentralized-llm/adapter.js';
import { DecentralizedLlmClient } from '../providers/decentralized-llm/client.js';
import { LocalFallbackProvider } from '../providers/local-fallback/adapter.js';
import { SharedLlmProvider } from '../providers/shared-llm/adapter.js';
import { SharedLlmClient } from '../providers/shared-llm/client.js';

export function createAppContainer(config: AppConfig) {
  const db = createSqliteClient(config.DATABASE_URL);
  runMigrations(db);

  const sessionRepository = new SqliteSessionRepository(db);
  const generationEventRepository = new SqliteGenerationEventRepository(db);

  const providers: LLMProvider[] = [new LocalFallbackProvider()];

  if (config.SHARED_LLM_API_BASE && config.SHARED_LLM_API_KEY) {
    const sharedClient = new SharedLlmClient(
      config.SHARED_LLM_API_BASE,
      config.SHARED_LLM_API_KEY,
      config.GEN_TIMEOUT_MS,
    );
    providers.push(new SharedLlmProvider(sharedClient));
  }

  if (config.DECENTRALIZED_LLM_API_BASE && config.DECENTRALIZED_LLM_API_KEY) {
    const decentralizedClient = new DecentralizedLlmClient(
      config.DECENTRALIZED_LLM_API_BASE,
      config.DECENTRALIZED_LLM_API_KEY,
      config.GEN_TIMEOUT_MS,
    );
    providers.push(new DecentralizedLlmProvider(decentralizedClient));
  }

  const orchestration = new OrchestrationService({
    defaultProvider: config.DEFAULT_PROVIDER,
    fallbackProvider: 'local-fallback',
    maxRetries: 2,
    providerCooldownMs: 15_000,
    providers,
  });

  return { orchestration, sessionRepository, generationEventRepository };
}
