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

describe('S4.1 Auth hardening', () => {
  it('blocks protected endpoint without token when MEMPHIS_API_TOKEN is set', async () => {
    process.env.MEMPHIS_API_TOKEN = 'secret-token';

    const dir = mkdtempSync(join(tmpdir(), 'mv4-auth-'));
    const conf = cfg(join(dir, 'auth.db'));
    const c = createAppContainer(conf);
    const app = createHttpServer(conf, c.orchestration, {
      sessionRepository: c.sessionRepository,
      generationEventRepository: c.generationEventRepository,
    });

    const res = await app.inject({ method: 'GET', url: '/v1/metrics' });
    expect(res.statusCode).toBe(401);

    const ok = await app.inject({
      method: 'GET',
      url: '/v1/metrics',
      headers: { authorization: 'Bearer secret-token' },
    });
    expect(ok.statusCode).toBe(200);

    const vaultRes = await app.inject({
      method: 'POST',
      url: '/v1/vault/init',
      payload: {
        passphrase: 'VeryStrongPassphrase!123',
        recovery_question: 'pet?',
        recovery_answer: 'nori',
      },
    });
    expect(vaultRes.statusCode).toBe(401);

    const vaultWithToken = await app.inject({
      method: 'POST',
      url: '/v1/vault/init',
      headers: { authorization: 'Bearer secret-token' },
      payload: {
        passphrase: 'VeryStrongPassphrase!123',
        recovery_question: 'pet?',
        recovery_answer: 'nori',
      },
    });
    expect(vaultWithToken.statusCode).toBe(503);

    delete process.env.MEMPHIS_API_TOKEN;
    await app.close();
  });
});
