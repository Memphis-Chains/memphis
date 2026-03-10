import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/infra/config/env.js';

describe('loadConfig', () => {
  it('loads valid local-fallback config', () => {
    const cfg = loadConfig({
      NODE_ENV: 'development',
      HOST: '127.0.0.1',
      PORT: '3000',
      LOG_LEVEL: 'debug',
      DEFAULT_PROVIDER: 'local-fallback',
      LOCAL_FALLBACK_ENABLED: 'true',
      GEN_TIMEOUT_MS: '30000',
      GEN_MAX_TOKENS: '512',
      GEN_TEMPERATURE: '0.4',
      RUST_CHAIN_ENABLED: false,
    RUST_CHAIN_BRIDGE_PATH: "./crates/memphis-napi",
    DATABASE_URL: 'file:./data/test.db',
    });

    expect(cfg.DEFAULT_PROVIDER).toBe('local-fallback');
    expect(cfg.PORT).toBe(3000);
    expect(cfg.LOG_FORMAT).toBe('text');
  });

  it('fails when shared provider missing required keys', () => {
    expect(() =>
      loadConfig({
        NODE_ENV: 'development',
        HOST: '127.0.0.1',
        PORT: '3000',
        LOG_LEVEL: 'debug',
        DEFAULT_PROVIDER: 'shared-llm',
        GEN_TIMEOUT_MS: '30000',
        GEN_MAX_TOKENS: '512',
        GEN_TEMPERATURE: '0.4',
        RUST_CHAIN_ENABLED: false,
        RUST_CHAIN_BRIDGE_PATH: './crates/memphis-napi',
        DATABASE_URL: 'file:./data/test.db',
      }),
    ).toThrow(/SHARED_LLM_API_BASE|SHARED_LLM_API_KEY/);
  });

  it('accepts extended embedding provider modes', () => {
    const cfg = loadConfig({
      NODE_ENV: 'development',
      HOST: '127.0.0.1',
      PORT: '3000',
      LOG_LEVEL: 'debug',
      DEFAULT_PROVIDER: 'local-fallback',
      LOCAL_FALLBACK_ENABLED: 'true',
      GEN_TIMEOUT_MS: '30000',
      GEN_MAX_TOKENS: '512',
      GEN_TEMPERATURE: '0.4',
      RUST_CHAIN_ENABLED: true,
      RUST_CHAIN_BRIDGE_PATH: './crates/memphis-napi',
      RUST_EMBED_MODE: 'voyage',
      DATABASE_URL: 'file:./data/test.db',
    });

    expect(cfg.RUST_EMBED_MODE).toBe('voyage');
  });
});
