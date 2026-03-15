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

describe('revocation cache fail-closed guard', () => {
  afterEach(() => {
    delete process.env.MEMPHIS_REVOCATION_CACHE_REQUIRED;
    delete process.env.MEMPHIS_REVOCATION_CACHE_MAX_STALE_MS;
    delete process.env.MEMPHIS_REVOCATION_CACHE_LAST_SYNC_MS;
    delete process.env.MEMPHIS_API_TOKEN;
    delete process.env.MEMPHIS_SAFE_MODE;
  });

  it('blocks high-risk routes when revocation cache is stale', async () => {
    process.env.MEMPHIS_API_TOKEN = 'test-token';
    const dir = mkdtempSync(join(tmpdir(), 'mv5-revocation-guard-stale-'));
    const conf = cfg(join(dir, 'guard-stale.db'));
    const c = createAppContainer(conf);
    const app = createHttpServer(conf, c.orchestration, {
      sessionRepository: c.sessionRepository,
      generationEventRepository: c.generationEventRepository,
      dualApprovalRepository: c.dualApprovalRepository,
      taskQueue: c.taskQueue,
    });

    process.env.MEMPHIS_REVOCATION_CACHE_REQUIRED = 'true';
    process.env.MEMPHIS_REVOCATION_CACHE_MAX_STALE_MS = '30000';
    process.env.MEMPHIS_REVOCATION_CACHE_LAST_SYNC_MS = String(Date.now() - 120_000);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/admin/dual-approval/request',
      headers: { authorization: 'Bearer test-token' },
      payload: {
        action: 'freeze',
        initiatorId: 'operator-a',
      },
    });

    expect(res.statusCode).toBe(503);
    const body = res.json() as {
      error?: { code?: string; message?: string; details?: { route?: string; method?: string } };
    };
    expect(body.error?.code).toBe('SERVICE_UNAVAILABLE');
    expect(body.error?.message).toContain('revocation cache stale');
    expect(body.error?.details).toMatchObject({
      route: '/v1/admin/dual-approval/request',
      method: 'POST',
    });

    await app.close();
  });

  it('allows high-risk routes when revocation cache is fresh', async () => {
    process.env.MEMPHIS_API_TOKEN = 'test-token';
    const dir = mkdtempSync(join(tmpdir(), 'mv5-revocation-guard-fresh-'));
    const conf = cfg(join(dir, 'guard-fresh.db'));
    const c = createAppContainer(conf);
    const app = createHttpServer(conf, c.orchestration, {
      sessionRepository: c.sessionRepository,
      generationEventRepository: c.generationEventRepository,
      dualApprovalRepository: c.dualApprovalRepository,
      taskQueue: c.taskQueue,
    });

    process.env.MEMPHIS_REVOCATION_CACHE_REQUIRED = 'true';
    process.env.MEMPHIS_REVOCATION_CACHE_MAX_STALE_MS = '30000';
    process.env.MEMPHIS_REVOCATION_CACHE_LAST_SYNC_MS = String(Date.now());

    const res = await app.inject({
      method: 'POST',
      url: '/v1/admin/dual-approval/request',
      headers: { authorization: 'Bearer test-token' },
      payload: {
        action: 'freeze',
        initiatorId: 'operator-a',
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { ok?: boolean; request?: { state?: string } };
    expect(body.ok).toBe(true);
    expect(body.request?.state).toBe('pending');

    await app.close();
  });

  it('re-evaluates revocation guard state when env freshness changes at runtime', async () => {
    process.env.MEMPHIS_API_TOKEN = 'test-token';
    const dir = mkdtempSync(join(tmpdir(), 'mv5-revocation-guard-runtime-toggle-'));
    const conf = cfg(join(dir, 'guard-runtime-toggle.db'));
    const c = createAppContainer(conf);
    const app = createHttpServer(conf, c.orchestration, {
      sessionRepository: c.sessionRepository,
      generationEventRepository: c.generationEventRepository,
      dualApprovalRepository: c.dualApprovalRepository,
      taskQueue: c.taskQueue,
    });

    process.env.MEMPHIS_REVOCATION_CACHE_REQUIRED = 'true';
    process.env.MEMPHIS_REVOCATION_CACHE_MAX_STALE_MS = '30000';
    process.env.MEMPHIS_REVOCATION_CACHE_LAST_SYNC_MS = String(Date.now() - 120_000);

    const blocked = await app.inject({
      method: 'POST',
      url: '/v1/admin/dual-approval/request',
      headers: { authorization: 'Bearer test-token' },
      payload: {
        action: 'freeze',
        initiatorId: 'operator-a',
      },
    });
    expect(blocked.statusCode).toBe(503);

    process.env.MEMPHIS_REVOCATION_CACHE_LAST_SYNC_MS = String(Date.now());

    const allowed = await app.inject({
      method: 'POST',
      url: '/v1/admin/dual-approval/request',
      headers: { authorization: 'Bearer test-token' },
      payload: {
        action: 'freeze',
        initiatorId: 'operator-a',
      },
    });
    expect(allowed.statusCode).toBe(200);

    await app.close();
  });

  it('prioritizes safe-mode denial before revocation fail-closed checks', async () => {
    process.env.MEMPHIS_API_TOKEN = 'test-token';
    const dir = mkdtempSync(join(tmpdir(), 'mv5-revocation-guard-safe-mode-precedence-'));
    const conf = cfg(join(dir, 'guard-safe-mode-precedence.db'));
    const c = createAppContainer(conf);
    const app = createHttpServer(conf, c.orchestration, {
      sessionRepository: c.sessionRepository,
      generationEventRepository: c.generationEventRepository,
      dualApprovalRepository: c.dualApprovalRepository,
      taskQueue: c.taskQueue,
    });

    process.env.MEMPHIS_SAFE_MODE = 'true';
    process.env.MEMPHIS_REVOCATION_CACHE_REQUIRED = 'true';
    process.env.MEMPHIS_REVOCATION_CACHE_MAX_STALE_MS = '30000';
    process.env.MEMPHIS_REVOCATION_CACHE_LAST_SYNC_MS = String(Date.now() - 120_000);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/admin/dual-approval/request',
      headers: { authorization: 'Bearer test-token' },
      payload: {
        action: 'freeze',
        initiatorId: 'operator-a',
      },
    });

    expect(res.statusCode).toBe(403);
    const body = res.json() as { error?: { code?: string; message?: string } };
    expect(body.error?.code).toBe('PERMISSION_DENIED');
    expect(body.error?.message).toContain('forbidden in safe mode');

    await app.close();
  });
});
