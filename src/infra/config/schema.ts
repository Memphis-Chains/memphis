import { z } from 'zod';

import { PROVIDER_NAMES } from '../../core/types.js';

const boolFromString = z.preprocess((v) => {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') return v.toLowerCase() === 'true';
  return v;
}, z.boolean());

export const cognitiveSchema = z.object({
  COGNITIVE_MODEL_A_AUTO_CAPTURE: z.boolean().optional(),
  COGNITIVE_MODEL_A_CAPTURE_LEVEL: z.enum(['minimal', 'normal', 'verbose']).optional(),
  COGNITIVE_MODEL_A_REQUIRE_CONFIRMATION: z.boolean().optional(),
  COGNITIVE_MODEL_B_GIT_WATCH_ENABLED: z.boolean().optional(),
  COGNITIVE_MODEL_B_FILE_WATCH_ENABLED: z.boolean().optional(),
  COGNITIVE_MODEL_B_REPO_PATH: z.string().optional(),
  COGNITIVE_MODEL_B_SINCE_DAYS: z.number().optional(),
  COGNITIVE_MODEL_B_MAX_COMMITS: z.number().optional(),
  COGNITIVE_MODEL_B_ACTIVITY_WINDOW_SIZE: z.number().optional(),
  COGNITIVE_MODEL_B_CONFIDENCE_THRESHOLD: z.number().optional(),
  COGNITIVE_MODEL_B_INCLUDE_MERGES: z.boolean().optional(),
  COGNITIVE_MODEL_C_PATTERN_MIN_OCCURRENCES: z.number().optional(),
  COGNITIVE_MODEL_C_CONFIDENCE_CAP: z.number().optional(),
  COGNITIVE_MODEL_C_CONTEXT_SIMILARITY_THRESHOLD: z.number().optional(),
  COGNITIVE_MODEL_C_RECENCY_BOOST: z.number().optional(),
  COGNITIVE_MODEL_C_ACCURACY_WEIGHT: z.number().optional(),
  COGNITIVE_MODEL_D_CONSENSUS_THRESHOLD: z.number().optional(),
  COGNITIVE_MODEL_D_VOTING_TIMEOUT_MS: z.number().optional(),
  COGNITIVE_MODEL_E_REFLECTION_SCHEDULE: z.enum(['daily', 'weekly', 'both']).optional(),
  COGNITIVE_MODEL_E_DEEP_ANALYSIS_DAY: z.number().optional(),
  COGNITIVE_MODEL_E_CONTRADICTION_DETECTION: z.boolean().optional(),
  COGNITIVE_MODEL_E_BLIND_SPOT_ANALYSIS: z.boolean().optional(),
});

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  MCP_PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  LOG_FORMAT: z.enum(['text', 'json']).default('text'),
  MEMPHIS_AGENT_NAME: z.string().default('Memphis Agent'),
  MEMPHIS_OWNER_NAME: z.string().default('local operator'),

  DEFAULT_PROVIDER: z.enum(PROVIDER_NAMES).optional().default('anthropic'),

  /**
   * Comma-separated cascade order for provider fallback.
   * Example: `anthropic,minimax,ollama,local-fallback`
   * Each name must match PROVIDER_NAMES; unknown names throw at startup.
   * Omit to use DEFAULT_PROVIDER_CASCADE (anthropic → minimax → ollama → local-fallback).
   */
  MEMPHIS_PROVIDER_CASCADE: z.string().optional(),

  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_MODEL: z.string().optional(),
  ANTHROPIC_BASE_URL: z.string().optional(),
  ANTHROPIC_VAULT_KEY: z.string().optional(),
  ANTHROPIC_OAUTH_CLIENT_ID: z.string().optional(),
  ANTHROPIC_OAUTH_CLIENT_SECRET: z.string().optional(),
  ANTHROPIC_OAUTH_TOKEN_URL: z.string().optional(),
  ANTHROPIC_OAUTH_SECRET_VAULT_KEY: z.string().optional(),
  OPENAI_COMPATIBLE_API_BASE: z.string().optional(),
  OPENAI_COMPATIBLE_API_KEY: z.string().optional(),
  OPENAI_COMPATIBLE_MODEL: z.string().optional(),
  SHARED_LLM_API_BASE: z.string().optional(),
  SHARED_LLM_API_KEY: z.string().optional(),
  SHARED_LLM_MODEL: z.string().optional(),
  DECENTRALIZED_LLM_API_BASE: z.string().optional(),
  DECENTRALIZED_LLM_API_KEY: z.string().optional(),
  DECENTRALIZED_LLM_MODEL: z.string().optional(),
  OLLAMA_URL: z.string().optional(),
  OLLAMA_MODEL: z.string().optional(),

  // ── Ollama tuning (slow-but-eventual offline answers) ───────────────────
  // Rationale: when the cascade reaches Ollama we're already offline or in
  // triage mode. Remove hidden short timeouts, set deterministic defaults so
  // the model doesn't wander, and give it a long-but-finite ceiling so the
  // cascade never hangs forever.
  OLLAMA_NUM_CTX: z.coerce.number().int().min(512).max(131072).optional(),
  OLLAMA_TEMPERATURE: z.coerce.number().min(0).max(2).optional(),
  OLLAMA_TOP_P: z.coerce.number().min(0).max(1).optional(),
  OLLAMA_TOP_K: z.coerce.number().int().min(1).max(1000).optional(),
  OLLAMA_REPEAT_PENALTY: z.coerce.number().min(0.5).max(5).optional(),
  OLLAMA_NUM_PREDICT_OFFLINE: z.coerce.number().int().min(64).max(32768).optional(),
  OLLAMA_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(1000).max(3_600_000).optional(),
  MINIMAX_API_KEY: z.string().optional(),
  MINIMAX_MODEL: z.string().optional(),
  MINIMAX_BASE_URL: z.string().optional(),
  MINIMAX_VAULT_KEY: z.string().optional(),
  DEEPSEEK_API_KEY: z.string().optional(),
  DEEPSEEK_VAULT_KEY: z.string().optional(),
  DEEPSEEK_MODEL: z.string().optional(),
  DEEPSEEK_API_BASE: z.string().optional(),
  DEEPSEEK_BASE_URL: z.string().optional(),
  GLM_API_KEY: z.string().optional(),
  GLM_VAULT_KEY: z.string().optional(),
  GLM_MODEL: z.string().optional(),
  GLM_BASE_URL: z.string().optional(),
  LOCAL_FALLBACK_ENABLED: boolFromString.default(true),

  GEN_TIMEOUT_MS: z.coerce.number().int().min(100).max(120000).default(90000),
  GEN_MAX_TOKENS: z.coerce.number().int().min(1).max(32768).default(4096),
  GEN_TEMPERATURE: z.coerce.number().min(0).max(2).default(0.4),

  DATABASE_URL: z.string().default('file:./data/memphis.db'),
  MEMPHIS_QUEUE_MODE: z.enum(['financial', 'standard']).default('financial'),
  MEMPHIS_QUEUE_RESUME_POLICY: z.enum(['keep', 'fail', 'redispatch']).default('keep'),
  MEMPHIS_QUEUE_WAL_PATH: z.string().optional(),
  MEMPHIS_QUEUE_WAL_MAX_BYTES: z.coerce.number().int().min(1024).max(1073741824).default(10485760),
  MEMPHIS_MAX_PENDING_TASKS: z.coerce.number().int().min(1).max(100000).default(1000),

  RUST_CHAIN_ENABLED: boolFromString.default(true),
  RUST_CHAIN_BRIDGE_PATH: z.string().default('./crates/memphis-napi'),
  RUST_CHAIN_SIGNER_ALLOWLIST: z.string().optional(),
  MEMPHIS_API_TOKEN: z.string().optional(),
  MEMPHIS_VAULT_PEPPER: z
    .string()
    .optional()
    .refine((v) => !v || v.length >= 12, {
      message: 'MEMPHIS_VAULT_PEPPER must be at least 12 characters',
    }),
  MEMPHIS_CHANNEL_GATEWAY_ENABLED: boolFromString.default(false),
  MEMPHIS_TELEGRAM_BOT_TOKEN: z.string().optional(),
  MEMPHIS_MATRIX_ENABLED: boolFromString.default(false),
  MEMPHIS_MATRIX_HOMESERVER: z.string().optional(),
  MEMPHIS_MATRIX_ACCESS_TOKEN: z.string().optional(),
  MEMPHIS_MATRIX_ADMIN_USER: z.string().optional(),
  MEMPHIS_MATRIX_SERVER_NAME: z.string().optional(),
  MEMPHIS_MATRIX_TRUST_MODE: z
    .enum(['trusted-pilot', 'public-deferred', 'public', 'untrusted'])
    .optional(),
  MEMPHIS_AUTONOMY_MODE: z.enum(['full', 'quiet', 'balanced', 'paranoid']).optional(),
  MEMPHIS_SAFE_MODE: boolFromString.default(false),
  MEMPHIS_STRICT_MODE: boolFromString.default(false),
  MEMPHIS_FAULT_INJECT: z.string().optional(),
  RUST_EMBED_MODE: z
    .enum([
      'local',
      'openai-compatible',
      'provider',
      'ollama',
      'cohere',
      'voyage',
      'jina',
      'mistral',
      'together',
      'nvidia',
      'mixedbread',
    ])
    .default('ollama'),
  RUST_EMBED_DIM: z.coerce.number().int().min(1).max(4096).default(768),
  RUST_EMBED_MAX_TEXT_BYTES: z.coerce.number().int().min(64).max(1000000).default(4096),
  RUST_EMBED_PROVIDER_URL: z.string().optional(),
  RUST_EMBED_PROVIDER_API_KEY: z.string().optional(),
  RUST_EMBED_PROVIDER_MODEL: z.string().optional(),
  RUST_EMBED_PROVIDER_TIMEOUT_MS: z.coerce.number().int().min(100).max(60000).default(8000),
  RUST_EMBED_PERSIST_ENABLED: boolFromString.default(true),
  RUST_EMBED_PERSIST_PATH: z.string().optional(),

  // ── Operational thresholds (all optional, defaults match prior hardcoded values) ──
  MEMPHIS_CHAIN_ROTATION_THRESHOLD_BYTES: z.coerce
    .number()
    .int()
    .min(1048576)
    .max(1073741824)
    .optional(),
  MEMPHIS_CHAIN_ROTATION_MIN_KEEP_BLOCKS: z.coerce.number().int().min(1).max(10000).optional(),
  MEMPHIS_CHAIN_GC_ENABLED: boolFromString.default(false),
  MEMPHIS_CHAIN_GC_KEEP_ARCHIVES: z.coerce.number().int().min(1).max(1000).optional(),
  MEMPHIS_CHAIN_SNAPSHOT_ON_ROTATION: boolFromString.default(true),
  MEMPHIS_CHAIN_SNAPSHOT_TAIL_BLOCKS: z.coerce.number().int().min(1).max(100000).optional(),
  MEMPHIS_SNAPSHOT_MAX_AGE_MS: z.coerce.number().int().min(3600000).max(2592000000).optional(),
  MEMPHIS_SNAPSHOT_MIN_KEEP: z.coerce.number().int().min(1).max(1000).optional(),
  MEMPHIS_HEARTBEAT_INTERVAL_MS: z.coerce.number().int().min(5000).max(3600000).optional(),
  MEMPHIS_MEMORY_WARN_THRESHOLD: z.coerce.number().min(0.5).max(0.99).optional(),
  MEMPHIS_FEATURES: z.string().optional(),
  MEMPHIS_SKILLS_DIR: z.string().optional(),
  MEMPHIS_REFLECTION_ENABLED: boolFromString.default(true),
  MEMPHIS_REFLECTION_INTERVAL_MS: z.coerce.number().int().min(3600000).optional(),
  MEMPHIS_RATE_LIMIT_GLOBAL_MAX: z.coerce.number().int().min(1).max(100000).default(600),
  MEMPHIS_RATE_LIMIT_SENSITIVE_MAX: z.coerce.number().int().min(1).max(10000).default(60),
  MEMPHIS_TELEGRAM_TOKEN_OVERRIDE: z.string().optional(),
  MEMPHIS_TELEGRAM_ALLOWED_USER_IDS: z.string().optional(),

  COGNITIVE: cognitiveSchema.partial().optional(),
});

export type AppConfig = z.infer<typeof envSchema>;
