import { parseBool } from '../../core/env.js';
import type { ProviderName } from '../../core/types.js';
import { resolveModelCapabilitySnapshot } from '../../providers/model-capabilities.js';

type ProviderType = 'local' | 'remote';

type ProviderDefinition = {
  name: ProviderName;
  type: ProviderType;
};

type RemoteProviderConfig = {
  baseUrl?: string;
  apiKey?: string;
  model: string;
};

export type ProviderListItem = {
  name: ProviderName;
  status: 'healthy' | 'unhealthy';
  type: ProviderType;
};

export type ModelCapability = {
  supports_streaming: boolean;
  supports_vision: boolean;
  context_window: number;
};

export type ModelListItem = {
  provider: ProviderName;
  model: string;
  capabilities: ModelCapability;
};

const PROVIDERS: ProviderDefinition[] = [
  { name: 'local-fallback', type: 'local' },
  { name: 'ollama', type: 'local' },
  { name: 'anthropic', type: 'remote' },
  { name: 'shared-llm', type: 'remote' },
  { name: 'decentralized-llm', type: 'remote' },
  { name: 'minimax', type: 'remote' },
  { name: 'deepseek', type: 'remote' },
  { name: 'glm', type: 'remote' },
];

function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
  return values.find((value) => typeof value === 'string' && value.trim().length > 0)?.trim();
}

function resolveRemoteProviderConfig(
  provider: ProviderName,
  env: NodeJS.ProcessEnv,
): RemoteProviderConfig {
  switch (provider) {
    case 'anthropic':
      return {
        baseUrl: firstNonEmpty(env.ANTHROPIC_BASE_URL, 'https://api.anthropic.com'),
        apiKey: firstNonEmpty(env.ANTHROPIC_API_KEY),
        model: firstNonEmpty(env.ANTHROPIC_MODEL) ?? 'claude-sonnet-4-6',
      };
    case 'shared-llm':
      return {
        baseUrl: firstNonEmpty(env.SHARED_LLM_API_BASE, env.OPENAI_COMPATIBLE_API_BASE),
        apiKey: firstNonEmpty(env.SHARED_LLM_API_KEY, env.OPENAI_COMPATIBLE_API_KEY),
        model: firstNonEmpty(env.SHARED_LLM_MODEL, env.OPENAI_COMPATIBLE_MODEL) ?? 'shared-llm',
      };
    case 'decentralized-llm':
      return {
        baseUrl: firstNonEmpty(env.DECENTRALIZED_LLM_API_BASE),
        apiKey: firstNonEmpty(env.DECENTRALIZED_LLM_API_KEY),
        model: firstNonEmpty(env.DECENTRALIZED_LLM_MODEL) ?? 'decentralized-llm',
      };
    case 'minimax':
      return {
        baseUrl: firstNonEmpty(env.MINIMAX_BASE_URL, 'https://api.minimax.io/v1'),
        apiKey: firstNonEmpty(env.MINIMAX_API_KEY),
        model: firstNonEmpty(env.MINIMAX_MODEL) ?? 'MiniMax-M2.7',
      };
    case 'deepseek':
      return {
        baseUrl: firstNonEmpty(
          env.DEEPSEEK_API_BASE,
          env.DEEPSEEK_BASE_URL,
          'https://api.deepseek.com',
        ),
        apiKey: firstNonEmpty(env.DEEPSEEK_API_KEY),
        model: firstNonEmpty(env.DEEPSEEK_MODEL) ?? 'deepseek-chat',
      };
    case 'glm':
      return {
        baseUrl: firstNonEmpty(env.GLM_BASE_URL, 'https://open.bigmodel.cn/api/paas/v4'),
        apiKey: firstNonEmpty(env.GLM_API_KEY),
        model: firstNonEmpty(env.GLM_MODEL) ?? 'glm-4-flash',
      };
    default:
      return {
        model: provider,
      };
  }
}

function providerConfigured(name: ProviderName, env: NodeJS.ProcessEnv): boolean {
  switch (name) {
    case 'local-fallback':
      return parseBool(env.LOCAL_FALLBACK_ENABLED, true);
    case 'ollama':
      return true;
    case 'shared-llm':
    case 'decentralized-llm':
      return Boolean(
        resolveRemoteProviderConfig(name, env).baseUrl &&
        resolveRemoteProviderConfig(name, env).apiKey,
      );
    case 'anthropic':
      return Boolean(
        resolveRemoteProviderConfig(name, env).apiKey ||
        firstNonEmpty(env.ANTHROPIC_VAULT_KEY) ||
        (env.ANTHROPIC_OAUTH_CLIENT_ID && env.ANTHROPIC_OAUTH_CLIENT_SECRET),
      );
    case 'minimax':
      return Boolean(
        resolveRemoteProviderConfig(name, env).apiKey || firstNonEmpty(env.MINIMAX_VAULT_KEY),
      );
    case 'deepseek':
      return Boolean(
        resolveRemoteProviderConfig(name, env).apiKey || firstNonEmpty(env.DEEPSEEK_VAULT_KEY),
      );
    case 'glm':
      return Boolean(
        resolveRemoteProviderConfig(name, env).apiKey || firstNonEmpty(env.GLM_VAULT_KEY),
      );
  }
}

function providerHealthy(name: ProviderName, env: NodeJS.ProcessEnv): boolean {
  if (name === 'local-fallback') {
    return parseBool(env.LOCAL_FALLBACK_ENABLED, true);
  }

  if (name === 'ollama') {
    return true;
  }

  return providerConfigured(name, env);
}

export function listConfiguredProviders(env: NodeJS.ProcessEnv): ProviderListItem[] {
  return PROVIDERS.filter((provider) => providerConfigured(provider.name, env)).map((provider) => ({
    name: provider.name,
    type: provider.type,
    status: providerHealthy(provider.name, env) ? 'healthy' : 'unhealthy',
  }));
}

function toCliCapability(provider: ProviderName, model: string): ModelCapability {
  const snapshot = resolveModelCapabilitySnapshot(provider, model);
  return {
    supports_streaming: snapshot?.supportsStreaming ?? true,
    supports_vision: snapshot?.supportsVision ?? false,
    context_window: snapshot?.contextWindowTokens ?? 8192,
  };
}

async function fetchJson(url: string, init?: RequestInit, timeoutMs = 5000): Promise<unknown> {
  const response = await fetch(url, {
    ...init,
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!response.ok) {
    throw new Error(`HTTP_${response.status}`);
  }

  return response.json();
}

async function listRemoteModels(
  provider: Extract<
    ProviderName,
    'shared-llm' | 'decentralized-llm' | 'minimax' | 'deepseek' | 'glm'
  >,
  env: NodeJS.ProcessEnv,
): Promise<ModelListItem[]> {
  const cfg = resolveRemoteProviderConfig(provider, env);
  const headers: Record<string, string> = {};
  if (cfg.apiKey) {
    headers.Authorization = `Bearer ${cfg.apiKey}`;
  }

  if (cfg.baseUrl) {
    try {
      const payload = (await fetchJson(
        `${cfg.baseUrl.replace(/\/$/, '')}/models`,
        { headers },
        5000,
      )) as { data?: Array<{ id?: string }> };
      const models = (payload.data ?? [])
        .map((item) => item.id)
        .filter((id): id is string => Boolean(id && id.trim().length > 0));
      if (models.length > 0) {
        return models.map((model) => ({
          provider,
          model,
          capabilities: toCliCapability(provider, model),
        }));
      }
    } catch {
      // graceful timeout/failure -> fallback default model
    }
  }

  return [
    {
      provider,
      model: cfg.model,
      capabilities: toCliCapability(provider, cfg.model),
    },
  ];
}

async function listOllamaModels(env: NodeJS.ProcessEnv): Promise<ModelListItem[]> {
  const baseUrl = firstNonEmpty(env.OLLAMA_URL, 'http://127.0.0.1:11434') as string;
  try {
    const payload = (await fetchJson(
      `${baseUrl.replace(/\/$/, '')}/api/tags`,
      undefined,
      5000,
    )) as { models?: Array<{ name?: string }> };
    const names = (payload.models ?? [])
      .map((item) => item.name)
      .filter((name): name is string => Boolean(name && name.trim().length > 0));
    if (names.length > 0) {
      return names.map((model) => ({
        provider: 'ollama',
        model,
        capabilities: toCliCapability('ollama', model),
      }));
    }
  } catch {
    // graceful timeout/failure -> default model
  }

  const fallbackModel = firstNonEmpty(env.OLLAMA_MODEL, 'qwen2.5-coder:3b') as string;
  return [
    {
      provider: 'ollama',
      model: fallbackModel,
      capabilities: toCliCapability('ollama', fallbackModel),
    },
  ];
}

function listLocalFallbackModels(): ModelListItem[] {
  return [
    {
      provider: 'local-fallback',
      model: 'local-fallback-v0',
      capabilities: toCliCapability('local-fallback', 'local-fallback-v0'),
    },
  ];
}

/**
 * Capability matrix extension guide:
 * 1) Add provider metadata to PROVIDERS and configuration detection in providerConfigured/providerHealthy.
 * 2) Add a dedicated listXModels() resolver with fallback defaults and <=5s timeout for network calls.
 * 3) Add static/heuristic capability mapper returning supports_streaming/supports_vision/context_window.
 */
export async function listModelsWithCapabilities(env: NodeJS.ProcessEnv): Promise<ModelListItem[]> {
  const configured = listConfiguredProviders(env).map((provider) => provider.name);
  const rows: ModelListItem[] = [];

  for (const provider of configured) {
    switch (provider) {
      case 'local-fallback':
        rows.push(...listLocalFallbackModels());
        break;
      case 'ollama':
        rows.push(...(await listOllamaModels(env)));
        break;
      case 'shared-llm':
      case 'decentralized-llm':
      case 'minimax':
      case 'deepseek':
      case 'glm':
        rows.push(...(await listRemoteModels(provider, env)));
        break;
    }
  }

  return rows;
}
