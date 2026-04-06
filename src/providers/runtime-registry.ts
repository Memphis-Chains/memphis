import { AnthropicProvider } from './anthropic/adapter.js';
import { DecentralizedLlmProvider } from './decentralized-llm/adapter.js';
import { DecentralizedLlmClient } from './decentralized-llm/client.js';
import { GlmProvider } from './glm/adapter.js';
import {
  MinimaxProvider,
  OllamaProvider,
  OpenAICompatibleProvider,
  resolveProviderKeyResult,
  type ProviderKeyResolution,
} from './index.js';
import { LocalFallbackProvider } from './local-fallback/adapter.js';
import {
  adaptChatProvider,
  adaptGenerateProvider,
  type RuntimeProvider,
} from './runtime.js';
import { SharedLlmProvider } from './shared-llm/adapter.js';
import { SharedLlmClient } from './shared-llm/client.js';
import type { AppConfig } from '../infra/config/schema.js';

function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
  return values.find((value) => typeof value === 'string' && value.trim().length > 0)?.trim();
}

export type ProviderCheck =
  | { provider: string; resolution: ProviderKeyResolution };

export function createConfiguredRuntimeProviders(
  config: AppConfig,
  rawEnv: NodeJS.ProcessEnv = process.env,
): { providers: RuntimeProvider[]; checks: ProviderCheck[] } {
  const providers: RuntimeProvider[] = [];
  const checks: ProviderCheck[] = [];

  if (config.LOCAL_FALLBACK_ENABLED) {
    providers.push(
      adaptGenerateProvider(new LocalFallbackProvider(), {
        defaultModel: 'local-fallback-v0',
        listModels: ['local-fallback-v0'],
        configured: true,
      }),
    );
  }

  if (config.SHARED_LLM_API_BASE && config.SHARED_LLM_API_KEY) {
    const client = new SharedLlmClient(
      config.SHARED_LLM_API_BASE,
      config.SHARED_LLM_API_KEY,
      config.GEN_TIMEOUT_MS,
    );
    providers.push(
      adaptGenerateProvider(new SharedLlmProvider(client), {
        defaultModel: firstNonEmpty(rawEnv.SHARED_LLM_MODEL, rawEnv.OPENAI_COMPATIBLE_MODEL) ?? 'shared-llm',
        configured: true,
      }),
    );
  }

  if (config.DECENTRALIZED_LLM_API_BASE && config.DECENTRALIZED_LLM_API_KEY) {
    const client = new DecentralizedLlmClient(
      config.DECENTRALIZED_LLM_API_BASE,
      config.DECENTRALIZED_LLM_API_KEY,
      config.GEN_TIMEOUT_MS,
    );
    providers.push(
      adaptGenerateProvider(new DecentralizedLlmProvider(client), {
        defaultModel: rawEnv.DECENTRALIZED_LLM_MODEL ?? 'decentralized-llm',
        configured: true,
      }),
    );
  }

  // Anthropic: OAuth (preferred) or API key fallback.
  const oauthClientId = rawEnv.ANTHROPIC_OAUTH_CLIENT_ID;
  const oauthClientSecret =
    resolveProviderKeyResult('anthropic_oauth_secret', rawEnv).source === 'vault'
      ? (resolveProviderKeyResult('anthropic_oauth_secret', rawEnv) as { key: string }).key
      : rawEnv.ANTHROPIC_OAUTH_CLIENT_SECRET;
  const anthropicResult = resolveProviderKeyResult('anthropic', rawEnv);

  if (oauthClientId && oauthClientSecret) {
    // OAuth path — no API key needed.
    providers.push(
      adaptChatProvider(
        new AnthropicProvider({
          model: rawEnv.ANTHROPIC_MODEL,
          baseUrl: rawEnv.ANTHROPIC_BASE_URL,
          oauthClientId,
          oauthClientSecret,
          oauthTokenUrl: rawEnv.ANTHROPIC_OAUTH_TOKEN_URL,
        }),
      ),
    );
  } else if (anthropicResult.source === 'conflict') {
    checks.push({ provider: 'anthropic', resolution: anthropicResult });
  } else if (anthropicResult.source === 'vault' || anthropicResult.source === 'plaintext') {
    checks.push({ provider: 'anthropic', resolution: anthropicResult });
    providers.push(
      adaptChatProvider(
        new AnthropicProvider({
          apiKey: anthropicResult.key,
          model: rawEnv.ANTHROPIC_MODEL,
          baseUrl: rawEnv.ANTHROPIC_BASE_URL,
        }),
      ),
    );
  }

  providers.push(
    adaptChatProvider(
      new OllamaProvider({
        url: rawEnv.OLLAMA_URL,
        model: rawEnv.OLLAMA_MODEL,
      }),
    ),
  );

  const minimaxResult = resolveProviderKeyResult('minimax', rawEnv);
  if (minimaxResult.source === 'conflict') {
    checks.push({ provider: 'minimax', resolution: minimaxResult });
  } else if (minimaxResult.source === 'vault' || minimaxResult.source === 'plaintext') {
    checks.push({ provider: 'minimax', resolution: minimaxResult });
    providers.push(
      adaptChatProvider(
        new MinimaxProvider({
          apiKey: minimaxResult.key,
          model: rawEnv.MINIMAX_MODEL,
          baseUrl: rawEnv.MINIMAX_BASE_URL,
        }),
      ),
    );
  }

  const deepseekResult = resolveProviderKeyResult('deepseek', rawEnv);
  if (deepseekResult.source === 'conflict') {
    checks.push({ provider: 'deepseek', resolution: deepseekResult });
  } else if (deepseekResult.source === 'vault' || deepseekResult.source === 'plaintext') {
    checks.push({ provider: 'deepseek', resolution: deepseekResult });
    providers.push(
      adaptChatProvider(
        new OpenAICompatibleProvider({
          name: 'deepseek',
          baseUrl: rawEnv.DEEPSEEK_API_BASE || 'https://api.deepseek.com',
          apiKey: deepseekResult.key,
          model: rawEnv.DEEPSEEK_MODEL || 'deepseek-chat',
        }),
      ),
    );
  }

  const glmResult = resolveProviderKeyResult('glm', rawEnv);
  if (glmResult.source === 'conflict') {
    checks.push({ provider: 'glm', resolution: glmResult });
  } else if (glmResult.source === 'vault' || glmResult.source === 'plaintext') {
    checks.push({ provider: 'glm', resolution: glmResult });
    providers.push(
      adaptChatProvider(
        new GlmProvider({
          apiKey: glmResult.key,
          model: rawEnv.GLM_MODEL,
          baseUrl: rawEnv.GLM_BASE_URL,
        }),
      ),
    );
  }

  return { providers, checks };
}
