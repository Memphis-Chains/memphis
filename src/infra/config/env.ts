import 'dotenv/config';

import { applyConfigProfile, validateProductionSafety } from './profiles.js';
import { AppConfig, envSchema } from './schema.js';
import { resolveVaultSecrets } from './vault-resolve.js';
import { errorTemplates } from '../../core/errors.js';

function hasValue(value: string | undefined): boolean {
  return Boolean(value && value.trim().length > 0);
}

type ProviderRequirement = string | string[];

function describeRequirement(requirement: ProviderRequirement): string {
  return Array.isArray(requirement) ? requirement.join(' or ') : requirement;
}

/**
 * Provider → required keys map used both by `requireConfiguredProvider` and
 * the cascade-pick fallback (Codex P1 fix on PR #80). When the
 * operator-set `DEFAULT_PROVIDER` is missing its credentials, we walk this
 * list in cascade order to pick the next provider that IS configured, so
 * a fresh-host setup with `DEFAULT_PROVIDER=anthropic` but only Minimax
 * keys lands on Minimax instead of collapsing straight to local-fallback
 * (and short-circuiting the operator-preferred cascade).
 */
const PROVIDER_REQUIREMENTS: Array<{
  provider: AppConfig['DEFAULT_PROVIDER'];
  keys: ProviderRequirement[];
}> = [
  { provider: 'anthropic', keys: [['ANTHROPIC_API_KEY', 'ANTHROPIC_VAULT_KEY']] },
  { provider: 'minimax', keys: [['MINIMAX_API_KEY', 'MINIMAX_VAULT_KEY']] },
  { provider: 'shared-llm', keys: ['SHARED_LLM_API_BASE', 'SHARED_LLM_API_KEY'] },
  {
    provider: 'decentralized-llm',
    keys: ['DECENTRALIZED_LLM_API_BASE', 'DECENTRALIZED_LLM_API_KEY'],
  },
  { provider: 'deepseek', keys: [['DEEPSEEK_API_KEY', 'DEEPSEEK_VAULT_KEY']] },
  { provider: 'glm', keys: [['GLM_API_KEY', 'GLM_VAULT_KEY']] },
];

function isProviderConfigured(
  config: AppConfig,
  requiredKeys: ProviderRequirement[],
): boolean {
  for (const key of requiredKeys) {
    if (Array.isArray(key)) {
      if (!key.some((option) => hasValue(config[option as keyof AppConfig] as string))) {
        return false;
      }
    } else if (!hasValue(config[key as keyof AppConfig] as string)) {
      return false;
    }
  }
  return true;
}

function pickCascadeFallback(
  config: AppConfig,
  unavailableProvider: AppConfig['DEFAULT_PROVIDER'],
): AppConfig['DEFAULT_PROVIDER'] {
  // Honor the operator's MEMPHIS_PROVIDER_CASCADE order if set; otherwise
  // use the documented default (anthropic → minimax → ollama → local-fallback).
  const cascadeRaw = (config as { MEMPHIS_PROVIDER_CASCADE?: string }).MEMPHIS_PROVIDER_CASCADE;
  const cascade = cascadeRaw
    ? cascadeRaw
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    : ['anthropic', 'minimax', 'ollama', 'local-fallback'];

  for (const candidate of cascade) {
    if (candidate === unavailableProvider) continue;
    // ollama and local-fallback don't require credentials — they're always
    // a valid "configured" target.
    if (candidate === 'ollama' || candidate === 'local-fallback') {
      return candidate as AppConfig['DEFAULT_PROVIDER'];
    }
    const entry = PROVIDER_REQUIREMENTS.find((p) => p.provider === candidate);
    if (entry && isProviderConfigured(config, entry.keys)) {
      return entry.provider;
    }
  }
  return 'local-fallback';
}

function requireConfiguredProvider(
  config: AppConfig,
  provider: AppConfig['DEFAULT_PROVIDER'],
  requiredKeys: ProviderRequirement[],
): AppConfig | undefined {
  if (config.DEFAULT_PROVIDER !== provider) {
    return undefined;
  }

  const missing = requiredKeys.filter((key) => {
    if (Array.isArray(key)) {
      return !key.some((option) => hasValue(config[option as keyof AppConfig] as string));
    }
    return !hasValue(config[key as keyof AppConfig] as string);
  });
  if (missing.length === 0) {
    return undefined;
  }

  // Codex P1 fix (PR #80): walk the cascade to pick the next configured
  // provider instead of collapsing to local-fallback. Without this, a
  // fresh setup with DEFAULT_PROVIDER=anthropic and minimax credentials
  // (the documented common path) lands on local-fallback, never reaching
  // the configured minimax/ollama tiers — exactly the misbehavior the
  // cascade was meant to prevent.
  const fallback = pickCascadeFallback(config, provider);
  console.warn(
    `[memphis-config] DEFAULT_PROVIDER=${provider} requires ${missing
      .map(describeRequirement)
      .join(' and ')}. Walking cascade → ${fallback}.`,
  );
  return { ...config, DEFAULT_PROVIDER: fallback };
}

function normalizeConfigAliases(rawEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const envCopy = { ...rawEnv };
  if (!hasValue(envCopy.DEEPSEEK_API_BASE) && hasValue(envCopy.DEEPSEEK_BASE_URL)) {
    envCopy.DEEPSEEK_API_BASE = envCopy.DEEPSEEK_BASE_URL;
  }
  return envCopy;
}

function resolveDefaultProvider(config: AppConfig): AppConfig {
  return (
    requireConfiguredProvider(config, 'shared-llm', [
      'SHARED_LLM_API_BASE',
      'SHARED_LLM_API_KEY',
    ]) ??
    requireConfiguredProvider(config, 'decentralized-llm', [
      'DECENTRALIZED_LLM_API_BASE',
      'DECENTRALIZED_LLM_API_KEY',
    ]) ??
    requireConfiguredProvider(config, 'minimax', [['MINIMAX_API_KEY', 'MINIMAX_VAULT_KEY']]) ??
    requireConfiguredProvider(config, 'deepseek', [['DEEPSEEK_API_KEY', 'DEEPSEEK_VAULT_KEY']]) ??
    requireConfiguredProvider(config, 'glm', [['GLM_API_KEY', 'GLM_VAULT_KEY']]) ??
    requireConfiguredProvider(config, 'anthropic', [['ANTHROPIC_API_KEY', 'ANTHROPIC_VAULT_KEY']]) ??
    config
  );
}

function formatIssues(issues: Array<{ path: PropertyKey[]; message: string }>): string {
  return issues
    .map((issue) => {
      const key = issue.path.length > 0 ? issue.path.map(String).join('.') : 'env';
      return `- ${key}: ${issue.message}`;
    })
    .join('\n');
}

function emitConfigInfo(message: string): void {
  process.stderr.write(`${message}\n`);
}

export function loadConfig(rawEnv: NodeJS.ProcessEnv = process.env): AppConfig {
  // Resolve VAULT:key_name references before schema validation.
  // Uses a shallow copy so we don't mutate process.env directly.
  const envCopy = normalizeConfigAliases(rawEnv);
  const vaultResolved = resolveVaultSecrets(envCopy);
  if (vaultResolved.length > 0) {
    // Propagate resolved vault secrets back to process.env so that
    // downstream code reading process.env directly (e.g. Telegram adapter)
    // sees the plaintext values instead of the VAULT: prefix.
    for (const key of vaultResolved) {
      if (envCopy[key] !== undefined) {
        rawEnv[key] = envCopy[key];
      }
    }
    emitConfigInfo(
      `[memphis-config] Resolved ${vaultResolved.length} secret(s) from vault: ${vaultResolved.join(', ')}`,
    );
  }

  const parsed = envSchema.safeParse(envCopy);

  if (!parsed.success) {
    const details = formatIssues(parsed.error.issues);
    throw errorTemplates.missingEnv({
      missingKeys: parsed.error.issues.map((issue) => issue.path.join('.')).filter(Boolean),
      message: `Invalid configuration:\n${details}`,
      details: { issues: parsed.error.issues },
    });
  }

  const normalized = resolveDefaultProvider(parsed.data);
  const profiled = applyConfigProfile(normalized);
  try {
    validateProductionSafety(profiled);
  } catch (error) {
    throw errorTemplates.missingEnv({
      message: error instanceof Error ? error.message : String(error),
      cause: error,
    });
  }
  return profiled;
}
