import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createAppContainer } from '../../src/app/container.js';
import { createInProcessMemoryClient } from '../../src/gateway/memory-client.js';
import { createInProcessToolExecutor } from '../../src/gateway/tool-executor.js';
import type { AppConfig } from '../../src/infra/config/schema.js';
import {
  getLocalWorkerRuntimeStatus,
  resetLocalWorkerRuntimeStatusForTests,
} from '../../src/infra/runtime/local-worker-state.js';
import { CaseChainAdapter } from '../../src/infra/storage/case-chain-adapter.js';
import { buildChatDispatchWorkItem } from '../../src/infra/work/chat-work.js';
import { LocalWorkerRunner } from '../../src/infra/work/local-worker-runner.js';

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

afterEach(() => {
  delete process.env.MEMPHIS_SESSION_TOKEN_SECRET;
  delete process.env.RUST_CHAIN_ENABLED;
  resetLocalWorkerRuntimeStatusForTests();
});

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

describe('LocalWorkerRunner', () => {
  it('executes canonical chat.generate work and finalizes canonical side effects', async () => {
    process.env.MEMPHIS_SESSION_TOKEN_SECRET = '0123456789abcdef0123456789abcdef';
    process.env.RUST_CHAIN_ENABLED = 'false';

    const dir = mkdtempSync(join(tmpdir(), 'memphis-local-worker-'));
    const container = createAppContainer(cfg(join(dir, 'runtime.db')));
    const dispatch = buildChatDispatchWorkItem(
      {
        input: 'local worker hello',
        userId: 'telegram:7',
        provider: 'auto',
      },
      'req-local-worker-1',
    );
    const enqueued = container.workPollingService.enqueueWork(dispatch.workInput);

    const runner = new LocalWorkerRunner(
      {
        workPollingService: container.workPollingService,
        orchestration: container.orchestration,
        runtime: buildRuntime(container),
        sessionRepository: container.sessionRepository,
        generationEventRepository: container.generationEventRepository,
        operatorChatSessionRepository: container.operatorChatSessionRepository,
      },
      { workerId: 'test-local-worker', waitMs: 1 },
    );

    const outcome = await runner.runOnce();

    expect(outcome).toMatchObject({
      worked: true,
      workId: enqueued.workId,
      status: 'completed',
    });
    expect(container.workPollingService.getWorkItem(enqueued.workId)).toMatchObject({
      workId: enqueued.workId,
      status: 'completed',
      actorId: 'telegram:7',
      conversationId: 'primary::telegram:7',
      result: expect.objectContaining({
        providerUsed: 'local-fallback',
        output: expect.any(String),
      }),
    });
    expect(container.generationEventRepository.listBySession('primary::telegram:7')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sessionId: 'primary::telegram:7',
          providerUsed: 'local-fallback',
        }),
      ]),
    );
    const messages = container.operatorChatSessionRepository.listMessages('primary::telegram:7', 4);
    expect(messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: 'user',
          content: 'local worker hello',
        }),
        expect.objectContaining({
          role: 'assistant',
          content: expect.any(String),
        }),
      ]),
    );
    expect(getLocalWorkerRuntimeStatus()).toMatchObject({
      enabled: true,
      state: 'idle',
      workerId: 'test-local-worker',
      lastOutcome: 'completed',
      lastWorkId: enqueued.workId,
      processed: {
        leased: 1,
        completed: 1,
        failed: 0,
      },
    });
  });

  it('fails closed for invalid work payloads', async () => {
    process.env.MEMPHIS_SESSION_TOKEN_SECRET = '0123456789abcdef0123456789abcdef';
    process.env.RUST_CHAIN_ENABLED = 'false';

    const dir = mkdtempSync(join(tmpdir(), 'memphis-local-worker-invalid-'));
    const container = createAppContainer(cfg(join(dir, 'runtime.db')));
    const enqueued = container.workPollingService.enqueueWork({
      type: 'chat.generate',
      capabilityScope: ['task:chat.generate'],
      payload: { nope: true },
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
      { workerId: 'test-local-worker-invalid', waitMs: 1 },
    );

    const outcome = await runner.runOnce();

    expect(outcome).toMatchObject({
      worked: true,
      workId: enqueued.workId,
      status: 'failed',
    });
    expect(container.workPollingService.getWorkItem(enqueued.workId)).toMatchObject({
      workId: enqueued.workId,
      status: 'failed',
      result: expect.objectContaining({
        code: 'INVALID_WORK_ITEM',
      }),
    });
    expect(container.generationEventRepository.listBySession('primary::telegram:7')).toEqual([]);
    expect(getLocalWorkerRuntimeStatus()).toMatchObject({
      enabled: true,
      state: 'idle',
      workerId: 'test-local-worker-invalid',
      lastOutcome: 'failed',
      lastWorkId: enqueued.workId,
      processed: {
        leased: 1,
        completed: 0,
        failed: 1,
      },
    });
  });
});
