import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createAppContainer } from '../../src/app/container.js';
import { createInProcessMemoryClient } from '../../src/gateway/memory-client.js';
import { createInProcessToolExecutor } from '../../src/gateway/tool-executor.js';
import type { AppConfig } from '../../src/infra/config/schema.js';
import { resetLocalWorkerRuntimeStatusForTests } from '../../src/infra/runtime/local-worker-state.js';
import { loadTasks, MemphisScheduler, saveTasks } from '../../src/infra/runtime/scheduler.js';
import { CaseChainAdapter } from '../../src/infra/storage/case-chain-adapter.js';
import { LocalWorkerRunner } from '../../src/infra/work/local-worker-runner.js';
import { DEFAULT_LOCAL_WORKER_CAPABILITY_SCOPE } from '../../src/infra/work/work-capabilities.js';

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
    GEN_TIMEOUT_MS: 30_000,
    GEN_MAX_TOKENS: 512,
    GEN_TEMPERATURE: 0.4,
    RUST_CHAIN_ENABLED: false,
    RUST_CHAIN_BRIDGE_PATH: './crates/memphis-napi',
    DATABASE_URL: `file:${db}`,
  };
}

function buildRuntime(container: ReturnType<typeof createAppContainer>) {
  return {
    memory: createInProcessMemoryClient(),
    toolExecutor: createInProcessToolExecutor({
      evolveSessionRepository: container.evolveSessionRepository,
      permissionRepo: container.toolPermissionRepository,
      caseAdapter: new CaseChainAdapter(process.env),
      projectRoot: process.cwd(),
    }),
    operatorChatSessionRepository: container.operatorChatSessionRepository,
    conversationContextService: container.conversationContextService,
  };
}

afterEach(() => {
  delete process.env.MEMPHIS_SESSION_TOKEN_SECRET;
  delete process.env.MEMPHIS_DATA_DIR;
  delete process.env.RUST_CHAIN_ENABLED;
  resetLocalWorkerRuntimeStatusForTests();
});

describe('scheduler worker dispatch', () => {
  it('enqueues due tasks into worker lane and finalizes them through the local worker', async () => {
    process.env.MEMPHIS_SESSION_TOKEN_SECRET = '0123456789abcdef0123456789abcdef';
    process.env.RUST_CHAIN_ENABLED = 'false';

    const dir = mkdtempSync(join(tmpdir(), 'memphis-scheduler-worker-'));
    process.env.MEMPHIS_DATA_DIR = dir;
    const container = createAppContainer(cfg(join(dir, 'runtime.db')));
    const scheduler = new MemphisScheduler(30_000, {
      workPollingService: container.workPollingService,
      executionTarget: 'workers',
    });

    const task = scheduler.addTask({
      id: 'task-worker-dispatch',
      cron: '* * * * *',
      name: 'Worker shell task',
      command: { type: 'shell', script: 'printf scheduler-worker-ok' },
      enabled: true,
    });
    const tasks = loadTasks();
    tasks[0].nextRun = new Date(Date.now() - 60_000).toISOString();
    saveTasks(tasks);

    await scheduler.tick();

    expect(container.workPollingService.snapshot()).toMatchObject({
      work: {
        total: 1,
        pending: 1,
        completed: 0,
      },
    });

    const runner = new LocalWorkerRunner(
      {
        workPollingService: container.workPollingService,
        orchestration: container.orchestration,
        runtime: buildRuntime(container),
        sessionRepository: container.sessionRepository,
        generationEventRepository: container.generationEventRepository,
        operatorChatSessionRepository: container.operatorChatSessionRepository,
      },
      {
        workerId: 'test-scheduler-worker',
        capabilityScope: [...DEFAULT_LOCAL_WORKER_CAPABILITY_SCOPE],
        waitMs: 1,
      },
    );

    const outcome = await runner.runOnce();

    expect(outcome).toMatchObject({
      worked: true,
      status: 'completed',
    });
    expect(container.workPollingService.snapshot()).toMatchObject({
      work: {
        total: 1,
        pending: 0,
        completed: 1,
      },
    });
    expect(loadTasks()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: task.id,
          lastStatus: 'success',
          runCount: 1,
        }),
      ]),
    );
  });
});
