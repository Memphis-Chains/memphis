import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createAppContainer } from '../../src/app/container.js';
import type { AppConfig } from '../../src/infra/config/schema.js';
import { createHttpServer } from '../../src/infra/http/server.js';
import { loadTasks, MemphisScheduler } from '../../src/infra/runtime/scheduler.js';
import { SCHEDULER_EXECUTE_WORK_CAPABILITY } from '../../src/infra/work/work-capabilities.js';

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
    MEMPHIS_API_TOKEN: 'api-token',
  };
}

describe('worker routes', () => {
  afterEach(() => {
    delete process.env.MEMPHIS_API_TOKEN;
    delete process.env.MEMPHIS_SESSION_TOKEN_SECRET;
    delete process.env.MEMPHIS_DATA_DIR;
  });

  it('uses API-token registration and worker-session tokens for work polling lifecycle', async () => {
    process.env.MEMPHIS_API_TOKEN = 'api-token';
    process.env.MEMPHIS_SESSION_TOKEN_SECRET = '0123456789abcdef0123456789abcdef';
    process.env.RUST_CHAIN_ENABLED = 'false';

    const dir = mkdtempSync(join(tmpdir(), 'memphis-worker-routes-'));
    const conf = cfg(join(dir, 'workers.db'));
    const container = createAppContainer(conf);
    const app = createHttpServer(conf, container.orchestration, {
      sessionRepository: container.sessionRepository,
      generationEventRepository: container.generationEventRepository,
      taskQueue: container.taskQueue,
      operatorChatSessionRepository: container.operatorChatSessionRepository,
      conversationContextService: container.conversationContextService,
      workPollingService: container.workPollingService,
    });

    const register = await app.inject({
      method: 'POST',
      url: '/api/workers/register',
      headers: { authorization: 'Bearer api-token' },
      payload: { workerId: 'worker-alpha', capabilityScope: ['tools:read'] },
    });
    expect(register.statusCode).toBe(200);
    const registration = register.json();
    expect(registration.ok).toBe(true);
    expect(registration.token).toEqual(expect.any(String));

    const statusBefore = await app.inject({
      method: 'GET',
      url: '/api/workers/status',
      headers: { authorization: 'Bearer api-token' },
    });
    expect(statusBefore.statusCode).toBe(200);
    expect(statusBefore.json()).toMatchObject({
      ok: true,
      snapshot: {
        tokenReady: true,
        sessions: { total: 1, active: 1, revoked: 0, expired: 0 },
      },
    });

    const pollUnauthorized = await app.inject({
      method: 'POST',
      url: '/api/workers/poll',
      payload: {},
    });
    expect(pollUnauthorized.statusCode).toBe(401);

    const enqueue = await app.inject({
      method: 'POST',
      url: '/api/workers/enqueue',
      headers: { authorization: 'Bearer api-token' },
      payload: {
        type: 'chat.generate',
        actorId: 'telegram:7',
        conversationId: 'primary::telegram:7',
        capabilityScope: ['tools:read'],
        payload: { input: 'hello' },
      },
    });
    expect(enqueue.statusCode).toBe(200);
    const workId = enqueue.json().workId as string;

    const poll = await app.inject({
      method: 'POST',
      url: '/api/workers/poll',
      headers: { authorization: `Bearer ${registration.token as string}` },
      payload: { waitMs: 1 },
    });
    expect(poll.statusCode).toBe(200);
    expect(poll.json()).toMatchObject({
      ok: true,
      work: {
        workId,
        type: 'chat.generate',
        actorId: 'telegram:7',
        conversationId: 'primary::telegram:7',
      },
    });

    const refresh = await app.inject({
      method: 'POST',
      url: '/api/workers/refresh',
      headers: { authorization: `Bearer ${registration.token as string}` },
      payload: {},
    });
    expect(refresh.statusCode).toBe(200);
    const refreshedToken = refresh.json().token as string;
    expect(refreshedToken).toEqual(expect.any(String));

    const ack = await app.inject({
      method: 'POST',
      url: '/api/workers/ack',
      headers: { authorization: `Bearer ${refreshedToken}` },
      payload: { workId },
    });
    expect(ack.statusCode).toBe(200);

    const heartbeat = await app.inject({
      method: 'POST',
      url: '/api/workers/heartbeat',
      headers: { authorization: `Bearer ${refreshedToken}` },
      payload: { workId },
    });
    expect(heartbeat.statusCode).toBe(200);

    const complete = await app.inject({
      method: 'POST',
      url: '/api/workers/complete',
      headers: { authorization: `Bearer ${refreshedToken}` },
      payload: {
        workId,
        status: 'completed',
        result: {
          id: 'gen_worker_1',
          providerUsed: 'local-fallback',
          modelUsed: 'local-fallback-v0',
          output: 'true',
          timingMs: 2,
        },
      },
    });
    expect(complete.statusCode).toBe(200);
    expect(complete.json()).toMatchObject({
      ok: true,
      workId,
      status: 'completed',
    });

    expect(container.generationEventRepository.listBySession('primary::telegram:7')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sessionId: 'primary::telegram:7',
          providerUsed: 'local-fallback',
        }),
      ]),
    );
    expect(container.operatorChatSessionRepository.listMessages('primary::telegram:7', 4)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: 'user', content: 'hello' }),
        expect.objectContaining({ role: 'assistant', content: 'true' }),
      ]),
    );

    const revoke = await app.inject({
      method: 'POST',
      url: '/api/workers/revoke',
      headers: { authorization: 'Bearer api-token' },
      payload: { sessionId: registration.sessionId },
    });
    expect(revoke.statusCode).toBe(200);
    expect(revoke.json()).toMatchObject({
      ok: true,
      sessionId: registration.sessionId,
      workerId: 'worker-alpha',
    });

    const pollAfterRevoke = await app.inject({
      method: 'POST',
      url: '/api/workers/poll',
      headers: { authorization: `Bearer ${refreshedToken}` },
      payload: { waitMs: 1 },
    });
    expect(pollAfterRevoke.statusCode).toBe(401);

    const statusAfter = await app.inject({
      method: 'GET',
      url: '/api/workers/status',
      headers: { authorization: 'Bearer api-token' },
    });
    expect(statusAfter.statusCode).toBe(200);
    expect(statusAfter.json()).toMatchObject({
      ok: true,
      snapshot: {
        sessions: { total: 1, revoked: 1 },
        work: { total: 1, completed: 1 },
      },
    });

    await app.close();
  });

  it('finalizes scheduler.execute work items through the worker completion route', async () => {
    process.env.MEMPHIS_API_TOKEN = 'api-token';
    process.env.MEMPHIS_SESSION_TOKEN_SECRET = '0123456789abcdef0123456789abcdef';
    process.env.RUST_CHAIN_ENABLED = 'false';

    const dir = mkdtempSync(join(tmpdir(), 'memphis-worker-scheduler-routes-'));
    process.env.MEMPHIS_DATA_DIR = dir;
    const conf = cfg(join(dir, 'workers.db'));
    const container = createAppContainer(conf);
    const app = createHttpServer(conf, container.orchestration, {
      sessionRepository: container.sessionRepository,
      generationEventRepository: container.generationEventRepository,
      taskQueue: container.taskQueue,
      operatorChatSessionRepository: container.operatorChatSessionRepository,
      conversationContextService: container.conversationContextService,
      workPollingService: container.workPollingService,
    });

    const scheduler = new MemphisScheduler();
    const task = scheduler.addTask({
      id: 'task-worker-route-scheduler',
      cron: '* * * * *',
      name: 'Route scheduler task',
      command: { type: 'shell', script: 'printf route-scheduler-ok' },
      enabled: true,
    });
    const taskState = loadTasks().find((entry) => entry.id === task.id);
    expect(taskState?.nextRun).toEqual(expect.any(String));

    const register = await app.inject({
      method: 'POST',
      url: '/api/workers/register',
      headers: { authorization: 'Bearer api-token' },
      payload: {
        workerId: 'worker-scheduler',
        capabilityScope: [SCHEDULER_EXECUTE_WORK_CAPABILITY],
      },
    });
    expect(register.statusCode).toBe(200);
    const registration = register.json();

    const enqueue = await app.inject({
      method: 'POST',
      url: '/api/workers/enqueue',
      headers: { authorization: 'Bearer api-token' },
      payload: {
        type: 'scheduler.execute',
        actorId: 'system:scheduler',
        conversationId: 'system::scheduler',
        capabilityScope: [SCHEDULER_EXECUTE_WORK_CAPABILITY],
        payload: {
          taskId: task.id,
          taskName: task.name,
          command: task.command,
          nextRun: taskState?.nextRun,
          triggeredAt: new Date().toISOString(),
          source: 'test.worker-route',
        },
      },
    });
    expect(enqueue.statusCode).toBe(200);
    const workId = enqueue.json().workId as string;

    const poll = await app.inject({
      method: 'POST',
      url: '/api/workers/poll',
      headers: { authorization: `Bearer ${registration.token as string}` },
      payload: { waitMs: 1 },
    });
    expect(poll.statusCode).toBe(200);

    const ack = await app.inject({
      method: 'POST',
      url: '/api/workers/ack',
      headers: { authorization: `Bearer ${registration.token as string}` },
      payload: { workId },
    });
    expect(ack.statusCode).toBe(200);

    const complete = await app.inject({
      method: 'POST',
      url: '/api/workers/complete',
      headers: { authorization: `Bearer ${registration.token as string}` },
      payload: {
        workId,
        status: 'completed',
        result: {
          taskId: task.id,
          success: true,
          output: 'route-scheduler-ok',
          durationMs: 1,
        },
      },
    });
    expect(complete.statusCode).toBe(200);

    expect(loadTasks()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: task.id,
          lastStatus: 'success',
          runCount: 1,
        }),
      ]),
    );

    await app.close();
  });
});
