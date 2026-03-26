import 'dotenv/config';

import { applyConfigProfile, validateProductionSafety } from './profiles.js';
import { AppConfig, envSchema } from './schema.js';
import { resolveVaultSecrets } from './vault-resolve.js';
import { errorTemplates } from '../../core/errors.js';

function hasValue(value: string | undefined): boolean {
  return Boolean(value && value.trim().length > 0);
}

function requireConfiguredProvider(
  config: AppConfig,
  provider: AppConfig['DEFAULT_PROVIDER'],
  requiredKeys: string[],
): AppConfig | undefined {
  if (config.DEFAULT_PROVIDER !== provider) {
    return undefined;
  }

  const missing = requiredKeys.filter((key) => !hasValue(config[key as keyof AppConfig] as string));
  if (missing.length === 0) {
    return undefined;
  }

  console.warn(
    `[memphis-config] DEFAULT_PROVIDER=${provider} requires ${requiredKeys.join(' and ')}. Falling back to local-fallback.`,
  );
  return { ...config, DEFAULT_PROVIDER: 'local-fallback' };
}

function resolveDefaultProvider(config: AppConfig): AppConfig {
  return (
    requireConfiguredProvider(config, 'shared-llm', ['SHARED_LLM_API_BASE', 'SHARED_LLM_API_KEY']) ??
    requireConfiguredProvider(config, 'decentralized-llm', [
      'DECENTRALIZED_LLM_API_BASE',
      'DECENTRALIZED_LLM_API_KEY',
    ]) ??
    requireConfiguredProvider(config, 'minimax', ['MINIMAX_API_KEY']) ??
    requireConfiguredProvider(config, 'deepseek', ['DEEPSEEK_API_KEY']) ??
    requireConfiguredProvider(config, 'glm', ['GLM_API_KEY']) ??
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

export function loadConfig(rawEnv: NodeJS.ProcessEnv = process.env): AppConfig {
  // Resolve VAULT:key_name references before schema validation.
  // Uses a shallow copy so we don't mutate process.env directly.
  const envCopy = { ...rawEnv };
  const vaultResolved = resolveVaultSecrets(envCopy);
  if (vaultResolved.length > 0) {
    console.info(
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
