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

  console.warn(
    `[memphis-config] DEFAULT_PROVIDER=${provider} requires ${missing.map(describeRequirement).join(' and ')}. Falling back to local-fallback.`,
  );
  return { ...config, DEFAULT_PROVIDER: 'local-fallback' };
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
