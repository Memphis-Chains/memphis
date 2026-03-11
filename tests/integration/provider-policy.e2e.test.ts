import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createAppContainer } from '../../src/app/container.js';
import type { AppConfig } from '../../src/infra/config/schema.js';

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
    expect(health.map((h) => h.name)).toEqual(['local-fallback']);
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
    expect(names).toEqual(['decentralized-llm', 'local-fallback', 'shared-llm']);
  });
});
