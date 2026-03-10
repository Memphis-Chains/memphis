import { z } from 'zod';

const boolFromString = z.preprocess((v) => {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') return v.toLowerCase() === 'true';
  return v;
}, z.boolean());

export const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    HOST: z.string().default('0.0.0.0'),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
    LOG_FORMAT: z.enum(['text', 'json']).default('text'),

    DEFAULT_PROVIDER: z
      .enum(['shared-llm', 'decentralized-llm', 'local-fallback'])
      .default('shared-llm'),

    SHARED_LLM_API_BASE: z.string().optional(),
    SHARED_LLM_API_KEY: z.string().optional(),
    DECENTRALIZED_LLM_API_BASE: z.string().optional(),
    DECENTRALIZED_LLM_API_KEY: z.string().optional(),
    LOCAL_FALLBACK_ENABLED: boolFromString.default(true),

    GEN_TIMEOUT_MS: z.coerce.number().int().min(100).max(120000).default(30000),
    GEN_MAX_TOKENS: z.coerce.number().int().min(1).max(32768).default(512),
    GEN_TEMPERATURE: z.coerce.number().min(0).max(2).default(0.4),

    DATABASE_URL: z.string().default('file:./data/memphis-v4.db'),

    RUST_CHAIN_ENABLED: boolFromString.default(false),
    RUST_CHAIN_BRIDGE_PATH: z.string().default('./crates/memphis-napi'),
    RUST_EMBED_MODE: z
      .enum(['local', 'openai-compatible', 'provider', 'ollama', 'cohere', 'voyage', 'jina', 'mistral', 'together', 'nvidia', 'mixedbread'])
      .default('local'),
    RUST_EMBED_DIM: z.coerce.number().int().min(1).max(4096).default(32),
    RUST_EMBED_MAX_TEXT_BYTES: z.coerce.number().int().min(64).max(1000000).default(4096),
    RUST_EMBED_PROVIDER_URL: z.string().optional(),
    RUST_EMBED_PROVIDER_API_KEY: z.string().optional(),
    RUST_EMBED_PROVIDER_MODEL: z.string().optional(),
    RUST_EMBED_PROVIDER_TIMEOUT_MS: z.coerce.number().int().min(100).max(60000).default(8000),
  })
  .superRefine((cfg, ctx) => {
    if (cfg.DEFAULT_PROVIDER === 'shared-llm') {
      if (!cfg.SHARED_LLM_API_BASE) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['SHARED_LLM_API_BASE'],
          message: 'Required when DEFAULT_PROVIDER=shared-llm',
        });
      }
      if (!cfg.SHARED_LLM_API_KEY) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['SHARED_LLM_API_KEY'],
          message: 'Required when DEFAULT_PROVIDER=shared-llm',
        });
      }
    }

    if (cfg.DEFAULT_PROVIDER === 'decentralized-llm') {
      if (!cfg.DECENTRALIZED_LLM_API_BASE) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['DECENTRALIZED_LLM_API_BASE'],
          message: 'Required when DEFAULT_PROVIDER=decentralized-llm',
        });
      }
      if (!cfg.DECENTRALIZED_LLM_API_KEY) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['DECENTRALIZED_LLM_API_KEY'],
          message: 'Required when DEFAULT_PROVIDER=decentralized-llm',
        });
      }
    }
  });

export type AppConfig = z.infer<typeof envSchema>;
