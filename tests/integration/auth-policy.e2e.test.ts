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

describe('S4.1 Auth hardening', () => {
  it('blocks protected endpoint without token when MEMPHIS_API_TOKEN is set', async () => {
    process.env.MEMPHIS_API_TOKEN = 'secret-token';
    const savedRustChain = process.env.RUST_CHAIN_ENABLED;
    process.env.RUST_CHAIN_ENABLED = 'false';

    const dir = mkdtempSync(join(tmpdir(), 'mv4-auth-'));
    const conf = cfg(join(dir, 'auth.db'));
    const c = createAppContainer(conf);
    const app = createHttpServer(conf, c.orchestration, {
      sessionRepository: c.sessionRepository,
      generationEventRepository: c.generationEventRepository,
    });

    const res = await app.inject({ method: 'GET', url: '/v1/metrics' });
    expect(res.statusCode).toBe(401);

    const bad = await app.inject({
      method: 'GET',
      url: '/v1/metrics',
      headers: { authorization: 'Bearer wrong-token' },
    });
    expect(bad.statusCode).toBe(401);

    const journal = await app.inject({
      method: 'POST',
      url: '/api/journal',
      payload: { content: 'auth test' },
    });
    expect(journal.statusCode).toBe(401);

    const dispatch = await app.inject({
      method: 'POST',
      url: '/v1/chat/dispatch',
      payload: { input: 'auth test' },
    });
    expect(dispatch.statusCode).toBe(401);

    const dispatchStatus = await app.inject({
      method: 'GET',
      url: '/v1/chat/dispatch/work-1',
    });
    expect(dispatchStatus.statusCode).toBe(401);

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
    if (savedRustChain === undefined) delete process.env.RUST_CHAIN_ENABLED;
    else process.env.RUST_CHAIN_ENABLED = savedRustChain;
    await app.close();
  });

  it('keeps dashboard status routes public even when API auth is enabled', async () => {
    process.env.MEMPHIS_API_TOKEN = 'secret-token';
    const savedRustChain = process.env.RUST_CHAIN_ENABLED;
    process.env.RUST_CHAIN_ENABLED = 'false';

    const dir = mkdtempSync(join(tmpdir(), 'mv4-auth-dashboard-'));
    const conf = cfg(join(dir, 'auth-dashboard.db'));
    const c = createAppContainer(conf);
    const app = createHttpServer(conf, c.orchestration, {
      sessionRepository: c.sessionRepository,
      generationEventRepository: c.generationEventRepository,
    });

    const statusRes = await app.inject({ method: 'GET', url: '/api/status' });
    expect(statusRes.statusCode).toBe(200);
    expect(statusRes.json()).toMatchObject({
      ok: true,
      uptimeSec: expect.any(Number),
      localWorker: null,
      scheduler: expect.objectContaining({
        configuredTarget: 'local',
        effectiveTarget: 'local',
      }),
      surfacePolicies: expect.arrayContaining([
        expect.objectContaining({ surface: 'telegram' }),
        expect.objectContaining({ surface: 'cli.chat' }),
      ]),
    });

    const dashboardRes = await app.inject({ method: 'GET', url: '/dashboard' });
    expect(dashboardRes.statusCode).toBe(200);
    expect(dashboardRes.body).toContain("fetch('/api/status')");
    expect(dashboardRes.body).toContain('rustBridgeLoaded ?? chain.bridgeLoaded ?? chain.loaded');

    delete process.env.MEMPHIS_API_TOKEN;
    if (savedRustChain === undefined) delete process.env.RUST_CHAIN_ENABLED;
    else process.env.RUST_CHAIN_ENABLED = savedRustChain;
    await app.close();
  });
});
