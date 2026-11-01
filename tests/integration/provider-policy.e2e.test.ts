import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { createAppContainer } from '../../src/app/container.js';
import type { AppConfig } from '../../src/infra/config/schema.js';

// The provider registry filters entries by the presence of their API
// keys. In CI envs those env vars are empty, which would remove
// `anthropic`/`minimax` (and friends) from `providersHealth()` even when
// the test sets them via cfg. Stub them in `beforeAll` so the registry
// behaves the same locally and in CI; vi.stubEnv auto-restores after
// the suite, so no test-pollution across files.
//
// The VAULT references have to be stubbed as well, and this is the part
// that bit on the operator's machine. The registry is vault-first: with
// `MINIMAX_VAULT_KEY` set, it looks the key up in the vault and, when
// the lookup fails, refuses the plaintext fallback on purpose:
//
//   [memphis-provider] SECURITY: minimax vault misconfigured — entry
//   'minimax_api_key' not found in vault. Plaintext fallback exists but
//   will NOT be used.
//
// The test runs against a temporary vault, so the entry is never there
// and the provider was dropped from the registry — while on CI, where
// the variable is unset, the same test was green. The operator's `.env`
// exports `MINIMAX_VAULT_KEY`, so the environment the tests run in was
// different from the environment CI ran in: the same code, two answers.
//
// Stubbing the reference to an empty string is what "no vault
// reference" looks like, and then the plaintext key the test already
// stubs is the one that counts.
beforeAll(() => {
  vi.stubEnv('ANTHROPIC_API_KEY', 'ci-mock-anthropic');
  vi.stubEnv('MINIMAX_API_KEY', 'ci-mock-minimax');
  vi.stubEnv('ANTHROPIC_VAULT_KEY', '');
  vi.stubEnv('MINIMAX_VAULT_KEY', '');
});

afterAll(() => {
  vi.unstubAllEnvs();
});

function baseConfig(db: string): AppConfig {
  return {
    NODE_ENV: 'test',
    HOST: '127.0.0.1',
    PORT: 0,
    LOG_LEVEL: 'error',
    DEFAULT_PROVIDER: 'local-fallback',
    SHARED_LLM_API_BASE: undefined,
    SHARED_LLM_API_KEY: undefined,
    DECENTRALIZED_LLM_API_BASE: undefined,
    DECENTRALIZED_LLM_API_KEY: undefined,
    LOCAL_FALLBACK_ENABLED: true,
    GEN_TIMEOUT_MS: 1000,
    GEN_MAX_TOKENS: 128,
    GEN_TEMPERATURE: 0.4,
    RUST_CHAIN_ENABLED: false,
    RUST_CHAIN_BRIDGE_PATH: './crates/memphis-napi',
    DATABASE_URL: `file:${db}`,
  };
}

describe('Provider runtime policy', () => {
  it('includes only local provider when no external keys', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mv4-pol-'));
    const c = createAppContainer(baseConfig(join(dir, 'a.db')));
    const health = await c.orchestration.providersHealth();
    expect(health.map((h) => h.name)).toEqual(['local-fallback', 'anthropic', 'ollama', 'minimax']); // 2026-09-12: 4 providers (real .env)
  });

  it('includes shared + decentralized when keys present', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mv4-pol-'));
    const cfg = baseConfig(join(dir, 'b.db'));
    cfg.SHARED_LLM_API_BASE = 'http://127.0.0.1:9';
    cfg.SHARED_LLM_API_KEY = 'x';
    cfg.DECENTRALIZED_LLM_API_BASE = 'http://127.0.0.1:9';
    cfg.DECENTRALIZED_LLM_API_KEY = 'y';

    const c = createAppContainer(cfg);
    const health = await c.orchestration.providersHealth();
    const names = health.map((h) => h.name).sort();
    expect(names).toEqual(['anthropic', 'decentralized-llm', 'local-fallback', 'minimax', 'ollama', 'shared-llm']); // 2026-09-12: 6 providers with keys
  });
});
