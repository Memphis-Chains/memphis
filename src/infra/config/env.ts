import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

import dotenv from 'dotenv';

import { applyConfigProfile, validateProductionSafety } from './profiles.js';
import { AppConfig, envSchema } from './schema.js';
import { resolveVaultSecrets } from './vault-resolve.js';
import { errorTemplates } from '../../core/errors.js';
import { resolveInstallRoot } from '../runtime/install-root.js';

/**
 * Load `.env` at module import time. Replaces the old
 * `import 'dotenv/config'` side-effect that loaded from
 * `process.cwd()` — running `memphis` from anywhere outside the
 * source checkout picked up an empty env, including a missing
 * `MEMPHIS_VAULT_PEPPER`, which made the Rust operator fail vault
 * decryption on every chat turn (operator reported as "vault: failed
 * to decrypt vault state" after swapping into the TUI from
 * `$HOME`).
 *
 * Resolution is entirely via `resolveDotEnvPath`:
 *   1. `MEMPHIS_ENV_FILE` explicit override
 *   2. `<installRoot>/.env` via `resolveInstallRoot`
 *   3. `./env` relative to cwd (inside `resolveDotEnvPath`'s own fallback)
 *
 * If the resolved path exists and `dotenv.config({ path, quiet })` succeeds,
 * the path is returned. If the path doesn't exist, or dotenv reports
 * a parse/read error, the loader returns `null` — deliberately does
 * NOT silently re-fall-back to `dotenv.config()` (no path), because
 * that reintroduces cwd-dependence and can silently pull an unrelated
 * `.env` from the operator's shell working directory (Codex P1).
 *
 * Operators can still force a specific file via `MEMPHIS_ENV_FILE`;
 * absence of a `.env` anywhere is valid (everything via env vars).
 */
export function loadDotEnvFromInstallRoot(
  rawEnv: NodeJS.ProcessEnv = process.env,
): string | null {
  // DELIBERATELY NOT routing through `resolveDotEnvPath` here:
  // that helper catches install-root discovery errors and returns
  // `resolve('.env')` so config writes have SOMEWHERE to go, but
  // for module-load-time read we need the opposite policy — if
  // install-root can't be found, we must NOT silently read
  // `./env` from cwd (that's the exact cwd-dependence bug the
  // whole refactor is trying to close). Resolve the two branches
  // explicitly.
  const explicit = rawEnv.MEMPHIS_ENV_FILE?.trim();
  if (explicit && explicit.length > 0) {
    return loadIfValid(resolve(explicit));
  }
  let envPath: string;
  try {
    envPath = join(resolveInstallRoot({ rawEnv }), '.env');
  } catch {
    // No install-root discoverable + no explicit override → no .env.
    // Operators using env-vars-only deployments still work (env is
    // already populated by the time this runs); they just miss the
    // file load, which is correct.
    return null;
  }
  return loadIfValid(envPath);
}

function loadIfValid(envPath: string): string | null {
  if (!existsSync(envPath)) {
    return null;
  }
  // `quiet: true` suppresses dotenv v17+'s stdout banner
  // (`◇ injected env (N) from .env …`). That banner would otherwise
  // glue onto the JSON emitted by scripts like
  // `scripts/drill-guard-failures.mts --json`, breaking
  // `JSON.parse(result.stdout)` in the ops gate tests.
  const result = dotenv.config({ path: envPath, quiet: true });
  if (result.error) {
    // Parse or permission failure on the resolved file — surface it
    // on stderr so the operator notices, and return null so callers
    // don't think env was loaded. (Codex P2 on #225.)
    console.warn(
      `[memphis-config] Failed to load ${envPath}: ${result.error.message}`,
    );
    return null;
  }
  return envPath;
}

loadDotEnvFromInstallRoot();

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
 *
 * Codex P2 (Round 3): entries now support a `check(config)` predicate for
 * providers whose "configured" state doesn't reduce to a flat list of
 * alternative keys. Anthropic uses this to mirror runtime-registry's
 * requirement: (API_KEY direct OR vault) OR (OAuth pair: CLIENT_ID AND
 * (CLIENT_SECRET direct OR vault)). Previously a single OAuth field was
 * enough to mark Anthropic as configured, which let the cascade pick it
 * even when no Anthropic client could actually be built.
 */
type ProviderCheck = (config: AppConfig) => boolean;

const PROVIDER_REQUIREMENTS: Array<{
  provider: AppConfig['DEFAULT_PROVIDER'];
  keys: ProviderRequirement[];
  check?: ProviderCheck;
}> = [
  {
    provider: 'anthropic',
    // Displayed in the `requireConfiguredProvider` warning message; the
    // actual gating is done by `check` below.
    keys: [
      [
        'ANTHROPIC_API_KEY',
        'ANTHROPIC_VAULT_KEY',
        'ANTHROPIC_OAUTH_CLIENT_ID + ANTHROPIC_OAUTH_CLIENT_SECRET',
      ],
    ],
    check: (config) => {
      const hasApiKey =
        hasValue(config.ANTHROPIC_API_KEY as string | undefined) ||
        hasValue(config.ANTHROPIC_VAULT_KEY as string | undefined);
      if (hasApiKey) return true;
      // OAuth path needs the FULL pair: client id plus a source for the
      // secret (direct env or vault-referenced secret).
      const hasOauthId = hasValue(config.ANTHROPIC_OAUTH_CLIENT_ID as string | undefined);
      const hasOauthSecret =
        hasValue(config.ANTHROPIC_OAUTH_CLIENT_SECRET as string | undefined) ||
        hasValue(config.ANTHROPIC_OAUTH_SECRET_VAULT_KEY as string | undefined);
      return hasOauthId && hasOauthSecret;
    },
  },
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
  entry: { keys: ProviderRequirement[]; check?: ProviderCheck },
): boolean {
  if (entry.check) return entry.check(config);
  for (const key of entry.keys) {
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
  // use the documented default (ollama → anthropic → minimax → local-fallback).
  const cascadeRaw = (config as { MEMPHIS_PROVIDER_CASCADE?: string }).MEMPHIS_PROVIDER_CASCADE;
  const cascade = cascadeRaw
    ? cascadeRaw
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    : ['ollama', 'anthropic', 'minimax', 'local-fallback'];

  for (const candidate of cascade) {
    if (candidate === unavailableProvider) continue;
    // local-fallback is always safe (in-process fallback, no daemon).
    if (candidate === 'local-fallback') {
      return 'local-fallback';
    }
    // Codex P1 (Round 2): ollama requires a running daemon we can't verify
    // synchronously at config-load. Treating it as always-configured made
    // `DEFAULT_PROVIDER=shared-llm` with no keys silently land on ollama
    // even when no daemon was running, so chat requests failed instead of
    // degrading to the always-available local-fallback. Only accept ollama
    // when OLLAMA_URL is explicitly set (operator opted in).
    if (candidate === 'ollama') {
      if (hasValue(config.OLLAMA_URL as string | undefined)) {
        return 'ollama';
      }
      continue;
    }
    const entry = PROVIDER_REQUIREMENTS.find((p) => p.provider === candidate);
    if (entry && isProviderConfigured(config, entry)) {
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
    requireConfiguredProvider(config, 'anthropic', [
      ['ANTHROPIC_API_KEY', 'ANTHROPIC_VAULT_KEY'],
    ]) ??
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
  const { resolved: vaultResolved, failed: vaultFailed } = resolveVaultSecrets(envCopy);
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
  if (vaultFailed.length > 0) {
    // Mirror the resolved-side propagation: clear the rawEnv copy so
    // downstream code that reads process.env directly sees the same
    // "absent" state envCopy now reflects. Without this, process.env
    // could still hold the original `VAULT:<key>` literal even though
    // envCopy (Zod's input) has been cleaned — telegram-readiness etc.
    // would still see the literal and produce inconsistent diagnostics.
    for (const key of vaultFailed) {
      delete rawEnv[key];
    }
    emitConfigInfo(
      `[memphis-config] Vault decrypt FAILED for ${vaultFailed.length} ref(s): ${vaultFailed.join(', ')}. ` +
        `These env vars were cleared; subsequent schema validation will treat them as unset.`,
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
