import { describe, expect, it } from 'vitest';
import { applyConfigProfile, validateProductionSafety } from '../../src/infra/config/profiles.js';
import type { AppConfig } from '../../src/infra/config/schema.js';

function base(): AppConfig {
  return {
    NODE_ENV: 'development',
    HOST: '127.0.0.1',
    PORT: 3000,
    LOG_LEVEL: 'debug',
    LOG_FORMAT: 'text',
    DEFAULT_PROVIDER: 'local-fallback',
    SHARED_LLM_API_BASE: undefined,
    SHARED_LLM_API_KEY: undefined,
    DECENTRALIZED_LLM_API_BASE: undefined,
    DECENTRALIZED_LLM_API_KEY: undefined,
    LOCAL_FALLBACK_ENABLED: true,
    GEN_TIMEOUT_MS: 30000,
    GEN_MAX_TOKENS: 4096,
    GEN_TEMPERATURE: 0.4,
    RUST_CHAIN_ENABLED: false,
    RUST_CHAIN_BRIDGE_PATH: "./crates/memphis-napi",
    DATABASE_URL: 'file:./data/test.db',
  };
}

describe('config profiles', () => {
  it('applies production caps', () => {
    const cfg = { ...base(), NODE_ENV: 'production' as const };
    const out = applyConfigProfile(cfg);
    expect(out.GEN_TIMEOUT_MS).toBeLessThanOrEqual(20000);
    expect(out.GEN_MAX_TOKENS).toBeLessThanOrEqual(1024);
    expect(out.LOG_LEVEL).toBe('info');
  });

  it('requires api token in production', () => {
    const cfg = { ...base(), NODE_ENV: 'production' as const };
    delete process.env.MEMPHIS_API_TOKEN;
    expect(() => validateProductionSafety(cfg)).toThrow(/MEMPHIS_API_TOKEN/);
  });
});
