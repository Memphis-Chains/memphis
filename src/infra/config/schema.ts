import { z } from 'zod';

const boolFromString = z.preprocess((v) => {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') return v.toLowerCase() === 'true';
  return v;
}, z.boolean());

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  LOG_FORMAT: z.enum(['text', 'json']).default('text'),

  DEFAULT_PROVIDER: z
    .enum(['shared-llm', 'decentralized-llm', 'local-fallback', 'ollama'])
    .optional()
    .default('ollama'),

  SHARED_LLM_API_BASE: z.string().optional(),
  SHARED_LLM_API_KEY: z.string().optional(),
  DECENTRALIZED_LLM_API_BASE: z.string().optional(),
  DECENTRALIZED_LLM_API_KEY: z.string().optional(),
  LOCAL_FALLBACK_ENABLED: boolFromString.default(true),

  GEN_TIMEOUT_MS: z.coerce.number().int().min(100).max(120000).default(30000),
  GEN_MAX_TOKENS: z.coerce.number().int().min(1).max(32768).default(512),
  GEN_TEMPERATURE: z.coerce.number().min(0).max(2).default(0.4),

  DATABASE_URL: z.string().default('file:./data/memphis-v5.db'),
  MEMPHIS_QUEUE_MODE: z.enum(['financial', 'standard']).default('financial'),
  MEMPHIS_QUEUE_RESUME_POLICY: z.enum(['keep', 'fail', 'redispatch']).default('keep'),
  MEMPHIS_QUEUE_WAL_PATH: z.string().optional(),
  MEMPHIS_QUEUE_WAL_MAX_BYTES: z.coerce.number().int().min(1024).max(1073741824).default(10485760),
  MEMPHIS_MAX_PENDING_TASKS: z.coerce.number().int().min(1).max(100000).default(100),

  RUST_CHAIN_ENABLED: boolFromString.default(false),
  RUST_CHAIN_BRIDGE_PATH: z.string().default('./crates/memphis-napi'),
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
    .default('local'),
  RUST_EMBED_DIM: z.coerce.number().int().min(1).max(4096).default(32),
  RUST_EMBED_MAX_TEXT_BYTES: z.coerce.number().int().min(64).max(1000000).default(4096),
  RUST_EMBED_PROVIDER_URL: z.string().optional(),
  RUST_EMBED_PROVIDER_API_KEY: z.string().optional(),
  RUST_EMBED_PROVIDER_MODEL: z.string().optional(),
  RUST_EMBED_PROVIDER_TIMEOUT_MS: z.coerce.number().int().min(100).max(60000).default(8000),
});

export type AppConfig = z.infer<typeof envSchema>;
