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
      RUST_CHAIN_BRIDGE_PATH: './crates/memphis-napi',
      DATABASE_URL: 'file:./data/test.db',
    });

    expect(cfg.DEFAULT_PROVIDER).toBe('local-fallback');
    expect(cfg.PORT).toBe(3000);
    expect(cfg.MCP_PORT).toBe(3001);
    expect(cfg.LOG_FORMAT).toBe('text');
  });

  it('falls back to local-fallback when shared provider keys are missing', () => {
    const cfg = loadConfig({
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
    });

    expect(cfg.DEFAULT_PROVIDER).toBe('local-fallback');
  });

  it('keeps ollama as the default provider when explicitly selected', () => {
    const cfg = loadConfig({
      NODE_ENV: 'development',
      HOST: '127.0.0.1',
      PORT: '3000',
      LOG_LEVEL: 'debug',
      DEFAULT_PROVIDER: 'ollama',
      RUST_CHAIN_ENABLED: false,
      RUST_CHAIN_BRIDGE_PATH: './crates/memphis-napi',
      DATABASE_URL: 'file:./data/test.db',
    });

    expect(cfg.DEFAULT_PROVIDER).toBe('ollama');
  });

  it('accepts extended remote default providers when required keys are present', () => {
    const cfg = loadConfig({
      NODE_ENV: 'development',
      HOST: '127.0.0.1',
      PORT: '3000',
      LOG_LEVEL: 'debug',
      DEFAULT_PROVIDER: 'deepseek',
      DEEPSEEK_API_KEY: 'deepseek-key',
      RUST_CHAIN_ENABLED: false,
      RUST_CHAIN_BRIDGE_PATH: './crates/memphis-napi',
      DATABASE_URL: 'file:./data/test.db',
    });

    expect(cfg.DEFAULT_PROVIDER).toBe('deepseek');
  });

  it('accepts vault-backed deepseek config and normalizes legacy base-url alias', () => {
    const cfg = loadConfig({
      NODE_ENV: 'development',
      HOST: '127.0.0.1',
      PORT: '3000',
      LOG_LEVEL: 'debug',
      DEFAULT_PROVIDER: 'deepseek',
      DEEPSEEK_VAULT_KEY: 'deepseek_api_key',
      DEEPSEEK_BASE_URL: 'https://api.deepseek.com',
      RUST_CHAIN_ENABLED: false,
      RUST_CHAIN_BRIDGE_PATH: './crates/memphis-napi',
      DATABASE_URL: 'file:./data/test.db',
    });

    expect(cfg.DEFAULT_PROVIDER).toBe('deepseek');
    expect(cfg.DEEPSEEK_API_BASE).toBe('https://api.deepseek.com');
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
