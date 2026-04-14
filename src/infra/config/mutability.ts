/**
 * Field mutability taxonomy for on-the-fly config reload (Sprint 6).
 *
 * Each env key known to `envSchema` is classified into one of four tiers:
 *
 * - **hot**    — swap at runtime, no restart, no subsystem wake-up needed.
 *                Consumers read `process.env` fresh on each use (or the value
 *                reaches them via a runtime code path that can observe the
 *                new value on the next turn).
 * - **warm**   — swap at runtime but requires owning subsystem to notice.
 *                Today we accept the swap but log a note that the next-tier
 *                caller may still see the cached value until its own reload.
 * - **cold**   — must not swap at runtime. `/v1/ops/config/reload` returns
 *                HTTP 409 listing any cold field an operator tries to mutate.
 * - **secret** — sensitive material (API keys, bot tokens, vault identifiers).
 *                Writes require tier-3 elevation. Never echoed back in diffs.
 *
 * Keys not listed here default to `warm` — safer than failing to reload.
 */

import { envSchema } from './schema.js';

export type MutabilityTier = 'hot' | 'warm' | 'cold' | 'secret';

/**
 * Fixed mapping — every currently-defined key in `envSchema` is listed.
 * Keep in lockstep with `src/infra/config/schema.ts`.
 */
export const FIELD_MUTABILITY: Record<string, MutabilityTier> = {
  // ── Process/runtime — cold (restart-bound) ──
  NODE_ENV: 'cold',
  HOST: 'cold',
  PORT: 'cold',
  MCP_PORT: 'cold',
  DATABASE_URL: 'cold',
  RUST_CHAIN_BRIDGE_PATH: 'cold',
  RUST_CHAIN_ENABLED: 'cold',
  MEMPHIS_QUEUE_MODE: 'cold',
  MEMPHIS_QUEUE_RESUME_POLICY: 'cold',
  MEMPHIS_QUEUE_WAL_PATH: 'cold',

  // ── Generation tunables — hot (read per call) ──
  GEN_TIMEOUT_MS: 'hot',
  GEN_MAX_TOKENS: 'hot',
  GEN_TEMPERATURE: 'hot',

  // ── Cognitive / autonomy — hot (file-backed, read fresh) ──
  MEMPHIS_AUTONOMY_MODE: 'hot',
  MEMPHIS_SAFE_MODE: 'hot',
  MEMPHIS_STRICT_MODE: 'hot',
  MEMPHIS_FAULT_INJECT: 'hot',
  MEMPHIS_REFLECTION_ENABLED: 'warm',
  MEMPHIS_REFLECTION_INTERVAL_MS: 'warm',

  // ── Provider selection ──
  // DEFAULT_PROVIDER: hot via the post-apply hook registered at bootstrap
  // (see src/app/bootstrap.ts). MEMPHIS_PROVIDER_CASCADE has always been hot
  // because the cascade list is re-read per request inside OrchestrationService.
  DEFAULT_PROVIDER: 'hot',
  MEMPHIS_PROVIDER_CASCADE: 'hot',

  // ── Anthropic ──
  ANTHROPIC_MODEL: 'hot',
  ANTHROPIC_BASE_URL: 'hot',
  ANTHROPIC_API_KEY: 'secret',
  ANTHROPIC_VAULT_KEY: 'warm',
  ANTHROPIC_OAUTH_CLIENT_ID: 'secret',
  ANTHROPIC_OAUTH_CLIENT_SECRET: 'secret',
  ANTHROPIC_OAUTH_TOKEN_URL: 'hot',
  ANTHROPIC_OAUTH_SECRET_VAULT_KEY: 'warm',

  // ── OpenAI-compat / Shared-LLM / Decentralized-LLM ──
  OPENAI_COMPATIBLE_API_BASE: 'hot',
  OPENAI_COMPATIBLE_API_KEY: 'secret',
  OPENAI_COMPATIBLE_MODEL: 'hot',
  SHARED_LLM_API_BASE: 'hot',
  SHARED_LLM_API_KEY: 'secret',
  SHARED_LLM_MODEL: 'hot',
  DECENTRALIZED_LLM_API_BASE: 'hot',
  DECENTRALIZED_LLM_API_KEY: 'secret',
  DECENTRALIZED_LLM_MODEL: 'hot',

  // ── Ollama ──
  OLLAMA_URL: 'hot',
  OLLAMA_MODEL: 'hot',
  OLLAMA_NUM_CTX: 'hot',
  OLLAMA_TEMPERATURE: 'hot',
  OLLAMA_TOP_P: 'hot',
  OLLAMA_TOP_K: 'hot',
  OLLAMA_REPEAT_PENALTY: 'hot',
  OLLAMA_NUM_PREDICT_OFFLINE: 'hot',
  OLLAMA_REQUEST_TIMEOUT_MS: 'hot',

  // ── Minimax / DeepSeek / GLM ──
  MINIMAX_API_KEY: 'secret',
  MINIMAX_MODEL: 'hot',
  MINIMAX_BASE_URL: 'hot',
  MINIMAX_VAULT_KEY: 'warm',
  DEEPSEEK_API_KEY: 'secret',
  DEEPSEEK_VAULT_KEY: 'warm',
  DEEPSEEK_MODEL: 'hot',
  DEEPSEEK_API_BASE: 'hot',
  DEEPSEEK_BASE_URL: 'hot',
  GLM_API_KEY: 'secret',
  GLM_VAULT_KEY: 'warm',
  GLM_MODEL: 'hot',
  GLM_BASE_URL: 'hot',
  LOCAL_FALLBACK_ENABLED: 'warm',

  // ── Rust embed ──
  RUST_EMBED_MODE: 'warm',
  RUST_EMBED_DIM: 'cold',
  RUST_EMBED_MAX_TEXT_BYTES: 'warm',
  RUST_EMBED_PROVIDER_URL: 'warm',
  RUST_EMBED_PROVIDER_API_KEY: 'secret',
  RUST_EMBED_PROVIDER_MODEL: 'warm',
  RUST_EMBED_PROVIDER_TIMEOUT_MS: 'warm',
  RUST_EMBED_PERSIST_ENABLED: 'cold',
  RUST_EMBED_PERSIST_PATH: 'cold',

  // ── Secrets: API tokens, vault pepper, signer allowlist ──
  MEMPHIS_API_TOKEN: 'secret',
  MEMPHIS_VAULT_PEPPER: 'secret',
  RUST_CHAIN_SIGNER_ALLOWLIST: 'warm',

  // ── Logging ──
  LOG_LEVEL: 'warm',
  LOG_FORMAT: 'warm',

  // ── Channels ──
  MEMPHIS_CHANNEL_GATEWAY_ENABLED: 'cold',
  MEMPHIS_TELEGRAM_BOT_TOKEN: 'secret',
  MEMPHIS_TELEGRAM_TOKEN_OVERRIDE: 'secret',
  MEMPHIS_TELEGRAM_ALLOWED_USER_IDS: 'hot',
  MEMPHIS_MATRIX_ENABLED: 'cold',
  MEMPHIS_MATRIX_HOMESERVER: 'cold',
  MEMPHIS_MATRIX_ACCESS_TOKEN: 'secret',
  MEMPHIS_MATRIX_ADMIN_USER: 'warm',
  MEMPHIS_MATRIX_SERVER_NAME: 'warm',
  MEMPHIS_MATRIX_TRUST_MODE: 'warm',

  // ── Identity ──
  MEMPHIS_AGENT_NAME: 'warm',
  MEMPHIS_OWNER_NAME: 'warm',

  // ── Operational thresholds ──
  MEMPHIS_CHAIN_ROTATION_THRESHOLD_BYTES: 'warm',
  MEMPHIS_CHAIN_ROTATION_MIN_KEEP_BLOCKS: 'warm',
  MEMPHIS_SNAPSHOT_MAX_AGE_MS: 'warm',
  MEMPHIS_SNAPSHOT_MIN_KEEP: 'warm',
  MEMPHIS_HEARTBEAT_INTERVAL_MS: 'warm',
  MEMPHIS_MEMORY_WARN_THRESHOLD: 'hot',
  MEMPHIS_FEATURES: 'warm',
  MEMPHIS_SKILLS_DIR: 'warm',
  MEMPHIS_QUEUE_WAL_MAX_BYTES: 'warm',
  MEMPHIS_MAX_PENDING_TASKS: 'warm',

  // ── Rate limits — hot via post-apply hook in src/infra/http/rate-limit.ts ──
  MEMPHIS_RATE_LIMIT_GLOBAL_MAX: 'hot',
  MEMPHIS_RATE_LIMIT_SENSITIVE_MAX: 'hot',

  // ── Frame buffer (Sprint 11) ──
  MEMPHIS_FRAME_BUFFER_SIZE: 'hot',

  // ── Chain integrity (Sprint 12) ──
  MEMPHIS_CHAIN_GC_ENABLED: 'warm',
  MEMPHIS_CHAIN_GC_KEEP_ARCHIVES: 'warm',
  MEMPHIS_CHAIN_SNAPSHOT_ON_ROTATION: 'warm',
  MEMPHIS_CHAIN_SNAPSHOT_TAIL_BLOCKS: 'warm',

  // ── Voice (Sprint 9) ──
  MEMPHIS_TTS_DAILY_CHAT_LIMIT: 'hot',

  // ── Self-restart ──
  MEMPHIS_RESTART_DRAIN_TIMEOUT_MS: 'hot',
  MEMPHIS_RESTART_ALLOW_SUICIDE: 'warm',
};

export const DEFAULT_TIER_FOR_UNKNOWN: MutabilityTier = 'warm';

export function classifyField(key: string): MutabilityTier {
  return FIELD_MUTABILITY[key] ?? DEFAULT_TIER_FOR_UNKNOWN;
}

/** True when the field can be freely hot-swapped (hot or warm). */
export function isMutableAtRuntime(key: string): boolean {
  const tier = classifyField(key);
  return tier === 'hot' || tier === 'warm';
}

/** True when the field is a secret and requires tier-3 elevation to change. */
export function requiresElevatedTier(key: string): boolean {
  return classifyField(key) === 'secret';
}

/** True when the field cannot be hot-swapped at all (restart required). */
export function requiresRestart(key: string): boolean {
  return classifyField(key) === 'cold';
}

/**
 * Return all currently known env keys with their classification.
 *
 * Codex P2 (Round 2): the whitelist source used by /config show, MCP
 * `config_set`, Telegram `/config set`, and HTTP `/v1/ops/config/reload`
 * MUST be derived from `envSchema` rather than FIELD_MUTABILITY. Otherwise
 * a key added to envSchema but forgotten in FIELD_MUTABILITY silently drops
 * off the whitelist — surfaces would then reject valid writes for no
 * visible reason. With envSchema as the source, unknown-to-FIELD_MUTABILITY
 * keys fall through to `DEFAULT_TIER_FOR_UNKNOWN` (warm) and remain
 * operator-visible.
 */
export function listKnownFields(): Array<{ key: string; tier: MutabilityTier }> {
  const schemaKeys = Object.keys(envSchema.shape);
  return schemaKeys
    .map((key) => ({ key, tier: classifyField(key) }))
    .sort((a, b) => a.key.localeCompare(b.key));
}
