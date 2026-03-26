import type { AppConfig } from './schema.js';

export type RuntimeProfile = 'development' | 'production' | 'test';

export function applyConfigProfile(config: AppConfig): AppConfig {
  const profile = config.NODE_ENV as RuntimeProfile;

  if (profile === 'production') {
    return {
      ...config,
      LOG_LEVEL: config.LOG_LEVEL === 'debug' ? 'info' : config.LOG_LEVEL,
      GEN_TIMEOUT_MS: Math.min(config.GEN_TIMEOUT_MS, 20_000),
      GEN_MAX_TOKENS: Math.min(config.GEN_MAX_TOKENS, 1024),
    };
  }

  if (profile === 'development') {
    return {
      ...config,
      LOG_LEVEL: config.LOG_LEVEL,
      GEN_TIMEOUT_MS: config.GEN_TIMEOUT_MS,
      GEN_MAX_TOKENS: config.GEN_MAX_TOKENS,
    };
  }

  // test
  return {
    ...config,
    LOG_LEVEL: config.LOG_LEVEL === 'debug' ? 'error' : config.LOG_LEVEL,
  };
}

export function validateProductionSafety(config: AppConfig): void {
  if (config.NODE_ENV !== 'production') return;

  if (!process.env.MEMPHIS_API_TOKEN) {
    throw new Error('Production safety check failed: MEMPHIS_API_TOKEN is required in production');
  }

  const providerRequirements = [
    { provider: 'shared-llm', keys: ['SHARED_LLM_API_BASE', 'SHARED_LLM_API_KEY'] },
    {
      provider: 'decentralized-llm',
      keys: ['DECENTRALIZED_LLM_API_BASE', 'DECENTRALIZED_LLM_API_KEY'],
    },
    { provider: 'minimax', keys: ['MINIMAX_API_KEY'] },
    { provider: 'deepseek', keys: ['DEEPSEEK_API_KEY'] },
    { provider: 'glm', keys: ['GLM_API_KEY'] },
  ] as const;

  for (const requirement of providerRequirements) {
    if (config.DEFAULT_PROVIDER !== requirement.provider) {
      continue;
    }

    const missing = requirement.keys.filter(
      (key) => !String(config[key as keyof AppConfig] ?? '').trim(),
    );
    if (missing.length === 0) {
      return;
    }

    throw new Error(
      `Production safety check failed: ${requirement.provider} requires ${requirement.keys.join(' and ')}`,
    );
  }
}
