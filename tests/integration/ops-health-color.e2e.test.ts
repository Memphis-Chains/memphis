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

describe('S4.4 ops health color', () => {
  it('returns health color in /v1/ops/status', async () => {
    process.env.MEMPHIS_API_TOKEN = 'x';
    const dir = mkdtempSync(join(tmpdir(), 'mv4-ops-color-'));
    const conf = cfg(join(dir, 'ops-color.db'));
    const c = createAppContainer(conf);
    const app = createHttpServer(conf, c.orchestration, {
      sessionRepository: c.sessionRepository,
      generationEventRepository: c.generationEventRepository,
    });

    const res = await app.inject({
      method: 'GET',
      url: '/v1/ops/status',
      headers: { authorization: 'Bearer x' },
    });
    const body = res.json() as { health?: { color?: string } };
    expect(['green', 'yellow', 'red']).toContain(body.health?.color);

    delete process.env.MEMPHIS_API_TOKEN;
    await app.close();
  });
});
