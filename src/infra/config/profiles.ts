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

/**
 * Provider key requirement entry. A bare string means "this exact key
 * must be set". An array means "any one of these alternatives is enough"
 * — used so a vault-managed setup (`MINIMAX_VAULT_KEY=minimax_api_key`)
 * is accepted in place of plaintext `MINIMAX_API_KEY`. Without this
 * either-of shape the daemon would crashloop in production whenever
 * the operator stored their provider key in vault and removed the
 * plaintext from .env (the recommended hardening — observed downstream
 * 2026-04-29 when an operator's MiniMax setup ran fine on every CLI
 * command but `systemctl --user start memphis` died with
 * "Production safety check failed: minimax requires MINIMAX_API_KEY"
 * even though the vault-resolved value populated MINIMAX_API_KEY at
 * runtime).
 */
type KeyRequirement = string | readonly string[];

function isRequirementSatisfied(config: AppConfig, requirement: KeyRequirement): boolean {
  if (typeof requirement === 'string') {
    return Boolean(String(config[requirement as keyof AppConfig] ?? '').trim());
  }
  return requirement.some((alt) =>
    Boolean(String(config[alt as keyof AppConfig] ?? '').trim()),
  );
}

function describeRequirement(requirement: KeyRequirement): string {
  return typeof requirement === 'string' ? requirement : requirement.join(' or ');
}

export function validateProductionSafety(config: AppConfig): void {
  if (config.NODE_ENV !== 'production') return;

  if (!process.env.MEMPHIS_API_TOKEN) {
    throw new Error('Production safety check failed: MEMPHIS_API_TOKEN is required in production');
  }

  const providerRequirements: ReadonlyArray<{
    provider: string;
    keys: ReadonlyArray<KeyRequirement>;
  }> = [
    { provider: 'shared-llm', keys: ['SHARED_LLM_API_BASE', 'SHARED_LLM_API_KEY'] },
    {
      provider: 'decentralized-llm',
      keys: ['DECENTRALIZED_LLM_API_BASE', 'DECENTRALIZED_LLM_API_KEY'],
    },
    // Mirror src/infra/config/env.ts:resolveDefaultProvider — vault-key
    // alternatives are equally valid because vault-resolve runs before
    // the runtime opens any provider connection.
    { provider: 'minimax', keys: [['MINIMAX_API_KEY', 'MINIMAX_VAULT_KEY']] },
    { provider: 'deepseek', keys: [['DEEPSEEK_API_KEY', 'DEEPSEEK_VAULT_KEY']] },
    { provider: 'glm', keys: [['GLM_API_KEY', 'GLM_VAULT_KEY']] },
  ] as const;

  for (const requirement of providerRequirements) {
    if (config.DEFAULT_PROVIDER !== requirement.provider) {
      continue;
    }

    const missing = requirement.keys.filter((key) => !isRequirementSatisfied(config, key));
    if (missing.length === 0) {
      return;
    }

    throw new Error(
      `Production safety check failed: ${requirement.provider} requires ${missing
        .map(describeRequirement)
        .join(' and ')}`,
    );
  }
}
