import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createHttpServer } from '../../src/infra/http/server.js';
import { createSqliteClient, runMigrations } from '../../src/infra/storage/sqlite/client.js';
import { SqliteGenerationEventRepository } from '../../src/infra/storage/sqlite/repositories/generation-event-repository.js';
import { SqliteSessionRepository } from '../../src/infra/storage/sqlite/repositories/session-repository.js';
import { TaskQueueService } from '../../src/infra/storage/task-queue-service.js';

describe('chat queue overload', () => {
  afterEach(() => {
    delete process.env.MEMPHIS_API_TOKEN;
  });

  it('returns 429 when pending tasks exceed max_pending_tasks', async () => {
    process.env.MEMPHIS_API_TOKEN = 'tok';

    const dir = mkdtempSync(join(tmpdir(), 'mv5-chat-queue-'));
    const db = createSqliteClient(`file:${join(dir, 'queue-overload.db')}`);
    runMigrations(db);
    const sessionRepository = new SqliteSessionRepository(db);
    const generationEventRepository = new SqliteGenerationEventRepository(db);
    const taskQueue = new TaskQueueService({
      walPath: join(dir, 'queue.wal'),
      mode: 'financial',
      maxPendingTasks: 1,
    });

    let releaseFirst: (() => void) | null = null;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const orchestration = {
      providersHealth: vi.fn(async () => [{ name: 'local-fallback', ok: true }]),
      generate: vi.fn(async () => {
        await firstBlocked;
        return {
          id: 'gen-1',
          providerUsed: 'local-fallback',
          output: 'ok',
          timingMs: 10,
        };
      }),
    };

    const config = {
      NODE_ENV: 'test',
      HOST: '127.0.0.1',
      PORT: 0,
      LOG_LEVEL: 'error',
      LOG_FORMAT: 'text',
      DEFAULT_PROVIDER: 'local-fallback',
      SHARED_LLM_API_BASE: undefined,
      SHARED_LLM_API_KEY: undefined,
      DECENTRALIZED_LLM_API_BASE: undefined,
      DECENTRALIZED_LLM_API_KEY: undefined,
      LOCAL_FALLBACK_ENABLED: true,
      GEN_TIMEOUT_MS: 30000,
      GEN_MAX_TOKENS: 512,
      GEN_TEMPERATURE: 0.4,
      DATABASE_URL: `file:${join(dir, 'queue-overload.db')}`,
      MEMPHIS_QUEUE_MODE: 'financial',
      MEMPHIS_QUEUE_WAL_PATH: join(dir, 'queue.wal'),
      MEMPHIS_QUEUE_WAL_MAX_BYTES: 10 * 1024 * 1024,
      MEMPHIS_MAX_PENDING_TASKS: 1,
      RUST_CHAIN_ENABLED: false,
      RUST_CHAIN_BRIDGE_PATH: './crates/memphis-napi',
      MEMPHIS_SAFE_MODE: false,
      MEMPHIS_STRICT_MODE: false,
      MEMPHIS_FAULT_INJECT: undefined,
      RUST_EMBED_MODE: 'local',
      RUST_EMBED_DIM: 32,
      RUST_EMBED_MAX_TEXT_BYTES: 4096,
      RUST_EMBED_PROVIDER_URL: undefined,
      RUST_EMBED_PROVIDER_API_KEY: undefined,
      RUST_EMBED_PROVIDER_MODEL: undefined,
      RUST_EMBED_PROVIDER_TIMEOUT_MS: 8000,
    } as const;

    const app = createHttpServer(config, orchestration as never, {
      sessionRepository,
      generationEventRepository,
      taskQueue,
    });

    const firstReq = app.inject({
      method: 'POST',
      url: '/v1/chat/generate',
      headers: { authorization: 'Bearer tok' },
      payload: { input: 'hello-1' },
    });

    for (let i = 0; i < 50 && taskQueue.snapshot().pendingTasks === 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(taskQueue.snapshot().pendingTasks).toBe(1);

    const secondReq = await app.inject({
      method: 'POST',
      url: '/v1/chat/generate',
      headers: { authorization: 'Bearer tok' },
      payload: { input: 'hello-2' },
    });
    expect(secondReq.statusCode).toBe(429);
    expect((secondReq.json() as { error?: { code?: string } }).error?.code).toBe('OVERLOAD');

    const metricsRes = await app.inject({
      method: 'GET',
      url: '/v1/metrics',
      headers: { authorization: 'Bearer tok' },
    });
    expect(metricsRes.statusCode).toBe(200);
    const metrics = metricsRes.json() as { queue?: { overloadTotal?: number } };
    expect(metrics.queue?.overloadTotal).toBe(1);

    releaseFirst?.();
    const firstRes = await firstReq;
    expect(firstRes.statusCode).toBe(200);

    await app.close();
  });
});
