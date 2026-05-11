/* eslint-disable no-restricted-syntax */
//
// rawEnv-threading default parameter or single-call config-source
// pattern. File-level disable per Sprint ι policy — accessor would
// add registry weight without consumer benefit.
//
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

/**
 * Result of the production-safety probe.
 *
 * BEFORE 2026-05-11: this function returned void and threw on any
 * missing-secret condition, killing the daemon process before HTTP
 * came up. Operator hit it as a 63-restart crash loop after a
 * pepper-rotate left the vault unreadable — the daemon couldn't
 * boot in degraded mode, couldn't surface the cause on /health,
 * and operator had no recovery path that didn't involve manual
 * .env surgery.
 *
 * AFTER 2026-05-11 (this PR): we collect the missing-secret reasons,
 * warn on each, and return them so the bootstrap path can surface
 * them via /health.degradedConfig and the bootstrap-warning channel.
 * Operator-facing copy + recovery is documented in
 * docs/operator/VAULT-RECOVERY-RUNBOOK.md.
 *
 * Escape hatch: set `MEMPHIS_STRICT_PRODUCTION_SAFETY=1` to restore
 * the original hard-throw behavior at the end of this function. The
 * pepper-not-set boundary (security gate) is enforced upstream in
 * env.ts:resolveVaultSecrets() regardless of this flag.
 */
export interface ProductionSafetyResult {
  degradedReasons: string[];
}

export function validateProductionSafety(config: AppConfig): ProductionSafetyResult {
  const degradedReasons: string[] = [];
  if (config.NODE_ENV !== 'production') return { degradedReasons };

  if (!process.env.MEMPHIS_API_TOKEN) {
    degradedReasons.push('MEMPHIS_API_TOKEN missing — HTTP auth gates disabled');
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
    // Memphis production deployment 2026-05-11+ runs on Anthropic
    // (OAuth-flow or API key). Without this entry the daemon currently
    // crashes on FIRST TURN when the adapter tries to use auth instead
    // of fail-fast/degrade at boot. The OAuth client id is an alternative
    // path that bypasses raw API key — operator authorizes via browser
    // flow handled by src/providers/anthropic/oauth-flow.ts.
    {
      provider: 'anthropic',
      keys: [['ANTHROPIC_API_KEY', 'ANTHROPIC_VAULT_KEY', 'ANTHROPIC_OAUTH_CLIENT_ID']],
    },
  ] as const;

  for (const requirement of providerRequirements) {
    if (config.DEFAULT_PROVIDER !== requirement.provider) {
      continue;
    }

    const missing = requirement.keys.filter((key) => !isRequirementSatisfied(config, key));
    if (missing.length === 0) {
      break;
    }

    degradedReasons.push(
      `${requirement.provider} provider missing credentials: ${missing
        .map(describeRequirement)
        .join(' and ')}`,
    );
    break;
  }

  for (const reason of degradedReasons) {
    console.warn(`[memphis-config] degraded: ${reason}`);
  }

  if (process.env.MEMPHIS_STRICT_PRODUCTION_SAFETY === '1' && degradedReasons.length > 0) {
    // Opt-in escape hatch for CI / paranoid prod deployments that
    // preferred the pre-2026-05-11 hard-throw behavior. Operator-
    // confirmed: default is degraded-by-default, strict mode is opt-in.
    throw new Error(
      `Production safety check failed (strict mode): ${degradedReasons.join('; ')}`,
    );
  }

  return { degradedReasons };
}
