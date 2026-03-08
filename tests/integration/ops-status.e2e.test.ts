import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAppContainer } from '../../src/app/container.js';
import { createHttpServer } from '../../src/infra/http/server.js';
import type { AppConfig } from '../../src/infra/config/schema.js';

function cfg(db: string): AppConfig {
  return {
    NODE_ENV: 'test', HOST: '127.0.0.1', PORT: 0, LOG_LEVEL: 'error',
    DEFAULT_PROVIDER: 'local-fallback',
    SHARED_LLM_API_BASE: undefined, SHARED_LLM_API_KEY: undefined,
    DECENTRALIZED_LLM_API_BASE: undefined, DECENTRALIZED_LLM_API_KEY: undefined,
    LOCAL_FALLBACK_ENABLED: true,
    GEN_TIMEOUT_MS: 30000, GEN_MAX_TOKENS: 512, GEN_TEMPERATURE: 0.4,
    RUST_CHAIN_ENABLED: false,
    RUST_CHAIN_BRIDGE_PATH: "./crates/memphis-napi",
    DATABASE_URL: `file:${db}`,
  };
}

describe('S3.4 Ops status endpoint', () => {
  it('returns combined runtime status', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mv4-s3ops-'));
    const conf = cfg(join(dir, 'ops.db'));
    const c = createAppContainer(conf);
    const app = createHttpServer(conf, c.orchestration, {
      sessionRepository: c.sessionRepository,
      generationEventRepository: c.generationEventRepository,
    });

    const res = await app.inject({ method: 'GET', url: '/v1/ops/status' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      service: string;
      providers: unknown[];
      metrics: { providers: unknown[] };
      uptimeSec: number;
      adapters: {
        chain: { backend: string };
        vault: { rustEnabled: boolean; vaultApiAvailable: boolean };
      };
    };
    expect(body.service).toBe('memphis-v4');
    expect(Array.isArray(body.providers)).toBe(true);
    expect(Array.isArray(body.metrics.providers)).toBe(true);
    expect(body.uptimeSec >= 0).toBe(true);
    expect(body.adapters.chain.backend).toBe('ts-legacy');
    expect(body.adapters.vault.rustEnabled).toBe(false);
    expect(body.adapters.vault.vaultApiAvailable).toBe(false);

    await app.close();
  });
});
