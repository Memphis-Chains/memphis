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
    RUST_CHAIN_BRIDGE_PATH: './crates/memphis-napi',
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

  it('passes development config through unchanged', () => {
    const cfg = base();
    const out = applyConfigProfile(cfg);
    expect(out.LOG_LEVEL).toBe('debug');
    expect(out.GEN_TIMEOUT_MS).toBe(30000);
    expect(out.GEN_MAX_TOKENS).toBe(4096);
  });

  it('suppresses debug logs in test profile', () => {
    const cfg = { ...base(), NODE_ENV: 'test' as const };
    const out = applyConfigProfile(cfg);
    expect(out.LOG_LEVEL).toBe('error');
  });

  it('keeps info level in test profile', () => {
    const cfg = { ...base(), NODE_ENV: 'test' as const, LOG_LEVEL: 'info' as const };
    const out = applyConfigProfile(cfg);
    expect(out.LOG_LEVEL).toBe('info');
  });

  it('requires api token in production', () => {
    const cfg = { ...base(), NODE_ENV: 'production' as const };
    delete process.env.MEMPHIS_API_TOKEN;
    expect(() => validateProductionSafety(cfg)).toThrow(/MEMPHIS_API_TOKEN/);
  });

  it('passes production safety with API token and local-fallback', () => {
    process.env.MEMPHIS_API_TOKEN = 'token-123';
    const cfg = {
      ...base(),
      NODE_ENV: 'production' as const,
    };
    expect(() => validateProductionSafety(cfg)).not.toThrow();
    delete process.env.MEMPHIS_API_TOKEN;
  });

  it('does not validate production safety in development', () => {
    const cfg = base();
    expect(() => validateProductionSafety(cfg)).not.toThrow();
  });

  it('accepts MINIMAX_VAULT_KEY in place of plaintext MINIMAX_API_KEY in production', () => {
    process.env.MEMPHIS_API_TOKEN = 'token-123';
    const cfg = {
      ...base(),
      NODE_ENV: 'production' as const,
      DEFAULT_PROVIDER: 'minimax' as const,
      MINIMAX_VAULT_KEY: 'minimax_api_key',
      // No MINIMAX_API_KEY — the vault reference is enough.
    };
    expect(() => validateProductionSafety(cfg)).not.toThrow();
    delete process.env.MEMPHIS_API_TOKEN;
  });

  it('accepts DEEPSEEK_VAULT_KEY in place of plaintext DEEPSEEK_API_KEY in production', () => {
    process.env.MEMPHIS_API_TOKEN = 'token-123';
    const cfg = {
      ...base(),
      NODE_ENV: 'production' as const,
      DEFAULT_PROVIDER: 'deepseek' as const,
      DEEPSEEK_VAULT_KEY: 'deepseek_api_key',
    };
    expect(() => validateProductionSafety(cfg)).not.toThrow();
    delete process.env.MEMPHIS_API_TOKEN;
  });

  it('still throws when neither plaintext nor vault key is present', () => {
    process.env.MEMPHIS_API_TOKEN = 'token-123';
    const cfg = {
      ...base(),
      NODE_ENV: 'production' as const,
      DEFAULT_PROVIDER: 'minimax' as const,
      // No MINIMAX_API_KEY, no MINIMAX_VAULT_KEY
    };
    expect(() => validateProductionSafety(cfg)).toThrow(/MINIMAX_API_KEY or MINIMAX_VAULT_KEY/);
    delete process.env.MEMPHIS_API_TOKEN;
  });
});
