type ProviderType = 'local' | 'remote';

type ProviderDefinition = {
  name: 'local-fallback' | 'ollama' | 'openai-compatible';
  type: ProviderType;
};

export type ProviderListItem = {
  name: string;
  status: 'healthy' | 'unhealthy';
  type: ProviderType;
};

export type ModelCapability = {
  supports_streaming: boolean;
  supports_vision: boolean;
  context_window: number;
};

export type ModelListItem = {
  provider: string;
  model: string;
  capabilities: ModelCapability;
};

const PROVIDERS: ProviderDefinition[] = [
  { name: 'ollama', type: 'local' },
  { name: 'openai-compatible', type: 'remote' },
  { name: 'local-fallback', type: 'local' },
];

function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
  return values.find((value) => typeof value === 'string' && value.trim().length > 0);
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (!value) return fallback;
  return value.toLowerCase() === 'true';
}

function resolveOpenAiConfig(env: NodeJS.ProcessEnv): { baseUrl: string; apiKey?: string; model: string } {
  const baseUrl = firstNonEmpty(env.OPENAI_COMPATIBLE_API_BASE, env.SHARED_LLM_API_BASE, env.DECENTRALIZED_LLM_API_BASE)
    ?? 'https://api.openai.com/v1';
  const apiKey = firstNonEmpty(env.OPENAI_COMPATIBLE_API_KEY, env.SHARED_LLM_API_KEY, env.DECENTRALIZED_LLM_API_KEY);
  const model = firstNonEmpty(env.OPENAI_COMPATIBLE_MODEL, env.SHARED_LLM_MODEL, env.DECENTRALIZED_LLM_MODEL) ?? 'gpt-4o-mini';
  return { baseUrl, apiKey, model };
}

function providerConfigured(name: ProviderDefinition['name'], env: NodeJS.ProcessEnv): boolean {
  if (name === 'local-fallback') {
    return parseBoolean(env.LOCAL_FALLBACK_ENABLED, true);
  }

  if (name === 'ollama') {
    return Boolean(firstNonEmpty(env.OLLAMA_URL, env.OLLAMA_MODEL, env.RUST_EMBED_MODE === 'ollama' ? 'enabled' : undefined));
  }

  const openAi = resolveOpenAiConfig(env);
  return Boolean(firstNonEmpty(env.OPENAI_COMPATIBLE_API_BASE, env.SHARED_LLM_API_BASE, env.DECENTRALIZED_LLM_API_BASE) || openAi.apiKey);
}

function providerHealthy(name: ProviderDefinition['name'], env: NodeJS.ProcessEnv): boolean {
  if (name === 'local-fallback') {
    return parseBoolean(env.LOCAL_FALLBACK_ENABLED, true);
  }

  if (name === 'ollama') {
    return providerConfigured(name, env);
  }

  const cfg = resolveOpenAiConfig(env);
  return cfg.baseUrl.length > 0;
}

export function listConfiguredProviders(env: NodeJS.ProcessEnv): ProviderListItem[] {
  return PROVIDERS
    .filter((provider) => providerConfigured(provider.name, env))
    .map((provider) => ({
      name: provider.name,
      type: provider.type,
      status: providerHealthy(provider.name, env) ? 'healthy' : 'unhealthy',
    }));
}

function openAiCapabilities(model: string): ModelCapability {
  const normalized = model.toLowerCase();

  let contextWindow = 8192;
  if (normalized.includes('gpt-4.1') || normalized.includes('gpt-4o') || normalized.includes('o1')) {
    contextWindow = 128000;
  } else if (normalized.includes('gpt-3.5')) {
    contextWindow = 16385;
  }

  const supportsVision =
    normalized.includes('vision') ||
    normalized.includes('gpt-4o') ||
    normalized.includes('omni') ||
    normalized.includes('claude-3') ||
    normalized.includes('llava');

  return {
    supports_streaming: true,
    supports_vision: supportsVision,
    context_window: contextWindow,
  };
}

function ollamaCapabilities(model: string): ModelCapability {
  const normalized = model.toLowerCase();
  const supportsVision = normalized.includes('llava') || normalized.includes('vision') || normalized.includes('moondream');

  return {
    supports_streaming: true,
    supports_vision: supportsVision,
    context_window: 8192,
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

async function listOpenAiModels(env: NodeJS.ProcessEnv): Promise<ModelListItem[]> {
  const cfg = resolveOpenAiConfig(env);
  const headers: Record<string, string> = {};
  if (cfg.apiKey) {
    headers.Authorization = `Bearer ${cfg.apiKey}`;
  }

  try {
    const payload = await fetchJson(`${cfg.baseUrl.replace(/\/$/, '')}/models`, { headers }, 5000) as { data?: Array<{ id?: string }> };
    const models = (payload.data ?? []).map((item) => item.id).filter((id): id is string => Boolean(id && id.trim().length > 0));
    if (models.length > 0) {
      return models.map((model) => ({
        provider: 'openai-compatible',
        model,
        capabilities: openAiCapabilities(model),
      }));
    }
  } catch {
    // fall through to defaults
  }

  return [{
    provider: 'openai-compatible',
    model: cfg.model,
    capabilities: openAiCapabilities(cfg.model),
  }];
}

async function listOllamaModels(env: NodeJS.ProcessEnv): Promise<ModelListItem[]> {
  const baseUrl = firstNonEmpty(env.OLLAMA_URL, 'http://127.0.0.1:11434') as string;
  try {
    const payload = await fetchJson(`${baseUrl.replace(/\/$/, '')}/api/tags`, undefined, 5000) as { models?: Array<{ name?: string }> };
    const names = (payload.models ?? []).map((item) => item.name).filter((name): name is string => Boolean(name && name.trim().length > 0));
    if (names.length > 0) {
      return names.map((model) => ({
        provider: 'ollama',
        model,
        capabilities: ollamaCapabilities(model),
      }));
    }
  } catch {
    // graceful timeout/failure -> default model
  }

  const fallbackModel = firstNonEmpty(env.OLLAMA_MODEL, 'qwen2.5-coder:3b') as string;
  return [{
    provider: 'ollama',
    model: fallbackModel,
    capabilities: ollamaCapabilities(fallbackModel),
  }];
}

function listLocalFallbackModels(): ModelListItem[] {
  return [{
    provider: 'local-fallback',
    model: 'local-fallback-v0',
    capabilities: {
      supports_streaming: false,
      supports_vision: false,
      context_window: 2048,
    },
  }];
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
    if (provider === 'local-fallback') {
      rows.push(...listLocalFallbackModels());
      continue;
    }

    if (provider === 'ollama') {
      rows.push(...await listOllamaModels(env));
      continue;
    }

    if (provider === 'openai-compatible') {
      rows.push(...await listOpenAiModels(env));
    }
  }

  return rows;
}
