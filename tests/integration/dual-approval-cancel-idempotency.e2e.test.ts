import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

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

describe('dual approval cancel idempotency', () => {
  afterEach(() => {
    delete process.env.MEMPHIS_API_TOKEN;
  });

  it('replays cancel requests with the same approvalRequestId without duplicate transitions', async () => {
    process.env.MEMPHIS_API_TOKEN = 'tok';

    const dir = mkdtempSync(join(tmpdir(), 'mv5-dual-approval-cancel-idem-'));
    const conf = cfg(join(dir, 'dual-approval-cancel-idem.db'));
    const c = createAppContainer(conf);
    const app = createHttpServer(conf, c.orchestration, {
      sessionRepository: c.sessionRepository,
      generationEventRepository: c.generationEventRepository,
      dualApprovalRepository: c.dualApprovalRepository,
    });

    const requestRes = await app.inject({
      method: 'POST',
      url: '/v1/admin/dual-approval/request',
      headers: { authorization: 'Bearer tok' },
      payload: {
        action: 'freeze',
        initiatorId: 'operator-a',
        ttlMs: 5 * 60 * 1000,
      },
    });
    expect(requestRes.statusCode).toBe(200);
    const created = requestRes.json() as { request: { requestId: string; stateVersion: number } };

    const cancelPayload = {
      approvalRequestId: '4b2cbe6f-6846-4da7-927f-4cad58138923',
      requestId: created.request.requestId,
      actorId: 'operator-a',
      expectedStateVersion: created.request.stateVersion,
    };

    const firstCancel = await app.inject({
      method: 'POST',
      url: '/v1/admin/dual-approval/cancel',
      headers: { authorization: 'Bearer tok' },
      payload: cancelPayload,
    });
    expect(firstCancel.statusCode).toBe(200);
    const firstBody = firstCancel.json() as {
      request: { requestId: string; state: string; stateVersion: number };
      replayed: boolean;
    };
    expect(firstBody.request.state).toBe('canceled');
    expect(firstBody.request.stateVersion).toBe(1);
    expect(firstBody.replayed).toBe(false);

    const replayCancel = await app.inject({
      method: 'POST',
      url: '/v1/admin/dual-approval/cancel',
      headers: { authorization: 'Bearer tok' },
      payload: cancelPayload,
    });
    expect(replayCancel.statusCode).toBe(200);
    const replayBody = replayCancel.json() as {
      request: { requestId: string; state: string; stateVersion: number };
      replayed: boolean;
    };
    expect(replayBody.request.requestId).toBe(created.request.requestId);
    expect(replayBody.request.state).toBe('canceled');
    expect(replayBody.request.stateVersion).toBe(1);
    expect(replayBody.replayed).toBe(true);

    const detailRes = await app.inject({
      method: 'GET',
      url: `/v1/admin/dual-approval/${created.request.requestId}`,
      headers: { authorization: 'Bearer tok' },
    });
    expect(detailRes.statusCode).toBe(200);
    const detailBody = detailRes.json() as {
      events: Array<{ toState: string }>;
    };
    expect(detailBody.events.map((event) => event.toState)).toEqual(['pending', 'canceled']);

    const metricsRes = await app.inject({
      method: 'GET',
      url: '/v1/metrics',
      headers: { authorization: 'Bearer tok' },
    });
    expect(metricsRes.statusCode).toBe(200);
    const metricsBody = metricsRes.json() as {
      dualApproval?: { transitionsTotal?: number };
    };
    expect(metricsBody.dualApproval?.transitionsTotal).toBe(2);

    await app.close();
  });
});
