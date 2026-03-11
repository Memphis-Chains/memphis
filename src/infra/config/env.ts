import 'dotenv/config';
import { errorTemplates } from '../../core/errors.js';
import { envSchema, type AppConfig } from './schema.js';
import { applyConfigProfile, validateProductionSafety } from './profiles.js';

function hasValue(value: string | undefined): boolean {
  return Boolean(value && value.trim().length > 0);
}

function resolveDefaultProvider(config: AppConfig): AppConfig {
  const original = config.DEFAULT_PROVIDER;

  if (original === 'shared-llm' && (!hasValue(config.SHARED_LLM_API_BASE) || !hasValue(config.SHARED_LLM_API_KEY))) {
    console.warn(
      '[memphis-config] DEFAULT_PROVIDER=shared-llm requires SHARED_LLM_API_BASE and SHARED_LLM_API_KEY. Falling back to local-fallback.',
    );
    return { ...config, DEFAULT_PROVIDER: 'local-fallback' };
  }

  if (
    original === 'decentralized-llm' &&
    (!hasValue(config.DECENTRALIZED_LLM_API_BASE) || !hasValue(config.DECENTRALIZED_LLM_API_KEY))
  ) {
    console.warn(
      '[memphis-config] DEFAULT_PROVIDER=decentralized-llm requires DECENTRALIZED_LLM_API_BASE and DECENTRALIZED_LLM_API_KEY. Falling back to local-fallback.',
    );
    return { ...config, DEFAULT_PROVIDER: 'local-fallback' };
  }

  if (original === 'ollama') {
    console.warn(
      '[memphis-config] DEFAULT_PROVIDER=ollama selected. Ollama is used for local embeddings; text generation will gracefully fall back to local-fallback unless an Ollama LLM provider is configured.',
    );
    return { ...config, DEFAULT_PROVIDER: 'local-fallback' };
  }

  return config;
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
  const parsed = envSchema.safeParse(rawEnv);

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
