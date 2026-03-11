import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createAppContainer } from '../../src/app/container.js';
import type { AppConfig } from '../../src/infra/config/schema.js';
import { createHttpServer } from '../../src/infra/http/server.js';

function cfg(db: string): AppConfig {
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
    GEN_TIMEOUT_MS: 30000,
    GEN_MAX_TOKENS: 512,
    GEN_TEMPERATURE: 0.4,
    RUST_CHAIN_ENABLED: false,
    RUST_CHAIN_BRIDGE_PATH: './crates/memphis-napi',
    DATABASE_URL: `file:${db}`,
  };
}

describe('Metrics e2e', () => {
  it('exposes provider metrics after chat call', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mv4-metrics-'));
    const container = createAppContainer(cfg(join(dir, 'm.db')));
    const app = createHttpServer(cfg(join(dir, 'm.db')), container.orchestration, {
      sessionRepository: container.sessionRepository,
      generationEventRepository: container.generationEventRepository,
    });

    await app.inject({
      method: 'POST',
      url: '/v1/chat/generate',
      payload: { input: 'metrics hello', provider: 'auto' },
    });

    const res = await app.inject({ method: 'GET', url: '/v1/metrics' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { providers: Array<{ provider: string; calls: number }> };
    const local = body.providers.find((p) => p.provider === 'local-fallback');
    expect((local?.calls ?? 0) > 0).toBe(true);

    await app.close();
  });
});
