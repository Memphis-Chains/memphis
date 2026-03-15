import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createAppContainer } from '../../src/app/container.js';
import type { AppConfig } from '../../src/infra/config/schema.js';
import { createHttpServer } from '../../src/infra/http/server.js';

function makeConfig(): AppConfig {
  const dir = mkdtempSync(join(tmpdir(), 'memphis-v5-e2e-'));
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
    DATABASE_URL: `file:${join(dir, 'e2e.db')}`,
  };
}

describe('HTTP e2e', () => {
  it.skip('accepts model-d proposal payload and returns deterministic vote', async () => {
    process.env.MEMPHIS_API_TOKEN = 'test-token';
    const config = makeConfig();
    const container = createAppContainer(config);
    const app = createHttpServer(config, container.orchestration, {
      sessionRepository: container.sessionRepository,
      generationEventRepository: container.generationEventRepository,
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/model-d/proposals',
      headers: { authorization: 'Bearer test-token' },
      payload: {
        protocol: 'memphis-model-d/v1',
        from: { id: 'peer-agent-a', name: 'Peer A' },
        proposal: {
          id: 'proposal-sec-1',
          title: 'Run security hardening sweep',
          description: 'Increase audit coverage and tighten access controls.',
          proposer: 'peer-agent-a',
          type: 'strategic',
          status: 'voting',
          createdAt: new Date().toISOString(),
        },
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.ok).toBe(true);
    expect(body.protocol).toBe('memphis-model-d/v1');
    expect(body.vote.choice).toBe('approve');
    expect(typeof body.vote.reason).toBe('string');

    await app.close();
  });

  it.skip('rejects invalid model-d proposal payload', async () => {
    process.env.MEMPHIS_API_TOKEN = 'test-token';
    const config = makeConfig();
    const container = createAppContainer(config);
    const app = createHttpServer(config, container.orchestration, {
      sessionRepository: container.sessionRepository,
      generationEventRepository: container.generationEventRepository,
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/model-d/proposals',
      headers: { authorization: 'Bearer test-token' },
      payload: {
        protocol: 'wrong-protocol',
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ ok: false });

    await app.close();
  });

  it.skip('rejects model-d proposal targeted to a different local agent id', async () => {
    process.env.MEMPHIS_API_TOKEN = 'test-token';
    process.env.MEMPHIS_MODEL_D_AGENT_ID = 'local-agent-1';
    const config = makeConfig();
    const container = createAppContainer(config);
    const app = createHttpServer(config, container.orchestration, {
      sessionRepository: container.sessionRepository,
      generationEventRepository: container.generationEventRepository,
    });
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/model-d/proposals',
        headers: { authorization: 'Bearer test-token' },
        payload: {
          protocol: 'memphis-model-d/v1',
          from: { id: 'peer-agent-a' },
          to: { id: 'some-other-agent' },
          proposal: {
            id: 'proposal-routing-1',
            title: 'Operational sync',
            description: 'Apply routine operations sync.',
            proposer: 'peer-agent-a',
            type: 'operational',
            status: 'voting',
            createdAt: new Date().toISOString(),
          },
        },
      });

      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ ok: false });
    } finally {
      await app.close();
      delete process.env.MEMPHIS_MODEL_D_AGENT_ID;
    }
  });

  it('rejects traversal-style chain names on /api/journal', async () => {
    process.env.MEMPHIS_API_TOKEN = 'test-token';
    const config = makeConfig();
    const container = createAppContainer(config);
    const app = createHttpServer(config, container.orchestration, {
      sessionRepository: container.sessionRepository,
      generationEventRepository: container.generationEventRepository,
    });

    const traversal = await app.inject({
      method: 'POST',
      url: '/api/journal',
      headers: { authorization: 'Bearer test-token' },
      payload: { content: 'x', chain: '../../tmp/pwn' },
    });
    expect(traversal.statusCode).toBe(400);
    expect(traversal.json()).toMatchObject({ ok: false, error: 'invalid chain name' });

    const absolute = await app.inject({
      method: 'POST',
      url: '/api/journal',
      headers: { authorization: 'Bearer test-token' },
      payload: { content: 'x', chain: '/tmp/pwn' },
    });
    expect(absolute.statusCode).toBe(400);

    const nullByte = await app.inject({
      method: 'POST',
      url: '/api/journal',
      headers: { authorization: 'Bearer test-token' },
      payload: { content: 'x', chain: `journal\u0000evil` },
    });
    expect(nullByte.statusCode).toBe(400);

    await app.close();
  });

  it('serves health and providers health', async () => {
    const config = makeConfig();
    const container = createAppContainer(config);
    const app = createHttpServer(config, container.orchestration, {
      sessionRepository: container.sessionRepository,
      generationEventRepository: container.generationEventRepository,
    });

    const health = await app.inject({ method: 'GET', url: '/health' });
    // Health may return 503 in CI if rust bridge isn't compiled
    expect([200, 503]).toContain(health.statusCode);
    const healthBody = health.json();
    expect(['healthy', 'unhealthy']).toContain(healthBody.status);
    expect(typeof healthBody.uptime_seconds).toBe('number');

    const providers = await app.inject({ method: 'GET', url: '/v1/providers/health' });
    expect(providers.statusCode).toBe(200);
    const body = providers.json();
    expect(body.defaultProvider).toBe('local-fallback');

    await app.close();
  });

  it('returns 503 when database is inaccessible', async () => {
    const config = {
      ...makeConfig(),
      DATABASE_URL: 'file:/proc/memphis-v5-health.db',
    };
    const container = createAppContainer(makeConfig());
    const app = createHttpServer(config, container.orchestration, {
      sessionRepository: container.sessionRepository,
      generationEventRepository: container.generationEventRepository,
    });

    const health = await app.inject({ method: 'GET', url: '/health' });
    expect(health.statusCode).toBe(503);
    const healthBody = health.json();
    expect(healthBody.status).toBe('unhealthy');
    expect(healthBody.checks.database.status).toBe('fail');

    await app.close();
  });

  it('generates and persists metadata', async () => {
    process.env.MEMPHIS_API_TOKEN = 'test-token';
    const config = makeConfig();
    const container = createAppContainer(config);
    const app = createHttpServer(config, container.orchestration, {
      sessionRepository: container.sessionRepository,
      generationEventRepository: container.generationEventRepository,
    });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/generate',
      payload: { input: 'e2e hi', provider: 'auto', sessionId: 'sess-e2e-1' },
      headers: { 'x-request-id': 'req-e2e-1', authorization: 'Bearer test-token' },
    });

    expect(res.statusCode).toBe(200);
    const events = container.generationEventRepository.listBySession('sess-e2e-1');
    expect(events.length).toBe(1);
    expect(events[0]?.requestId).toBe('req-e2e-1');

    await app.close();
  });
});
