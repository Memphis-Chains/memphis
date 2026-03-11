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

describe('S3.2 Session APIs', () => {
  it('lists sessions and their events', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mv4-s3apis-'));
    const conf = cfg(join(dir, 's3apis.db'));
    const c = createAppContainer(conf);
    const app = createHttpServer(conf, c.orchestration, {
      sessionRepository: c.sessionRepository,
      generationEventRepository: c.generationEventRepository,
    });

    await app.inject({
      method: 'POST',
      url: '/v1/chat/generate',
      payload: { input: 's3 api', provider: 'auto', sessionId: 'sess-s3-api-1' },
    });

    const sessionsRes = await app.inject({ method: 'GET', url: '/v1/sessions' });
    expect(sessionsRes.statusCode).toBe(200);
    const sessionsBody = sessionsRes.json() as { sessions: Array<{ id: string }> };
    expect(sessionsBody.sessions.some((s) => s.id === 'sess-s3-api-1')).toBe(true);

    const eventsRes = await app.inject({ method: 'GET', url: '/v1/sessions/sess-s3-api-1/events' });
    expect(eventsRes.statusCode).toBe(200);
    const eventsBody = eventsRes.json() as { events: unknown[] };
    expect(eventsBody.events.length).toBe(1);

    await app.close();
  });
});
