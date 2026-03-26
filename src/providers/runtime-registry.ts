import { DecentralizedLlmProvider } from './decentralized-llm/adapter.js';
import { DecentralizedLlmClient } from './decentralized-llm/client.js';
import { GlmProvider } from './glm/adapter.js';
import {
  MinimaxProvider,
  OllamaProvider,
  OpenAICompatibleProvider,
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

export function createConfiguredRuntimeProviders(
  config: AppConfig,
  rawEnv: NodeJS.ProcessEnv = process.env,
): RuntimeProvider[] {
  const providers: RuntimeProvider[] = [];

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

  providers.push(
    adaptChatProvider(
      new OllamaProvider({
        url: rawEnv.OLLAMA_URL,
        model: rawEnv.OLLAMA_MODEL,
      }),
    ),
  );

  if (rawEnv.MINIMAX_API_KEY) {
    providers.push(
      adaptChatProvider(
        new MinimaxProvider({
          apiKey: rawEnv.MINIMAX_API_KEY,
          model: rawEnv.MINIMAX_MODEL,
          baseUrl: rawEnv.MINIMAX_BASE_URL,
        }),
      ),
    );
  }

  if (rawEnv.DEEPSEEK_API_KEY) {
    providers.push(
      adaptChatProvider(
        new OpenAICompatibleProvider({
          name: 'deepseek',
          baseUrl: rawEnv.DEEPSEEK_API_BASE || 'https://api.deepseek.com',
          apiKey: rawEnv.DEEPSEEK_API_KEY,
          model: rawEnv.DEEPSEEK_MODEL || 'deepseek-chat',
        }),
      ),
    );
  }

  if (rawEnv.GLM_API_KEY) {
    providers.push(
      adaptChatProvider(
        new GlmProvider({
          apiKey: rawEnv.GLM_API_KEY,
          model: rawEnv.GLM_MODEL,
          baseUrl: rawEnv.GLM_BASE_URL,
        }),
      ),
    );
  }

  return providers;
}
