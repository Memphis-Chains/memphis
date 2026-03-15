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

describe('S3.1 Ask->Persist->Recall', () => {
  it('returns stored events by session id', async () => {
    process.env.MEMPHIS_API_TOKEN = 'test-token';
    const dir = mkdtempSync(join(tmpdir(), 'mv4-s3recall-'));
    const conf = cfg(join(dir, 's3.db'));
    const c = createAppContainer(conf);
    const app = createHttpServer(conf, c.orchestration, {
      sessionRepository: c.sessionRepository,
      generationEventRepository: c.generationEventRepository,
    });

    await app.inject({
      method: 'POST',
      url: '/v1/chat/generate',
      payload: { input: 'hello s3', provider: 'auto', sessionId: 'sess-s3-1' },
      headers: { 'x-request-id': 'req-s3-1', authorization: 'Bearer test-token' },
    });

    const res = await app.inject({ method: 'GET', url: '/v1/sessions/sess-s3-1/events', headers: { authorization: 'Bearer test-token' } });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { sessionId: string; events: Array<{ requestId?: string }> };
    expect(body.sessionId).toBe('sess-s3-1');
    expect(body.events.length).toBe(1);
    expect(body.events[0]?.requestId).toBe('req-s3-1');

    await app.close();
  });
});
