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

  if (
    config.DEFAULT_PROVIDER === 'shared-llm' &&
    (!config.SHARED_LLM_API_BASE || !config.SHARED_LLM_API_KEY)
  ) {
    throw new Error(
      'Production safety check failed: shared-llm requires SHARED_LLM_API_BASE and SHARED_LLM_API_KEY',
    );
  }

  if (
    config.DEFAULT_PROVIDER === 'decentralized-llm' &&
    (!config.DECENTRALIZED_LLM_API_BASE || !config.DECENTRALIZED_LLM_API_KEY)
  ) {
    throw new Error(
      'Production safety check failed: decentralized-llm requires DECENTRALIZED_LLM_API_BASE and DECENTRALIZED_LLM_API_KEY',
    );
  }
}
