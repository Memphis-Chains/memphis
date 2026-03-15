import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { resumeRecoveredQueueTasksOnStartup } from '../../src/app/bootstrap.js';
import { createAppContainer } from '../../src/app/container.js';
import type { AppConfig } from '../../src/infra/config/schema.js';
import { createHttpServer } from '../../src/infra/http/server.js';
import { resetStartupRuntimeStateForTests } from '../../src/infra/runtime/startup-state.js';

function cfg(dir: string, dbName: string): AppConfig {
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
    DATABASE_URL: `file:${join(dir, dbName)}`,
    MEMPHIS_QUEUE_WAL_PATH: join(dir, 'queue.wal'),
    MEMPHIS_QUEUE_MODE: 'financial',
    MEMPHIS_QUEUE_RESUME_POLICY: 'redispatch',
    MEMPHIS_QUEUE_WAL_MAX_BYTES: 10 * 1024 * 1024,
    MEMPHIS_MAX_PENDING_TASKS: 100,
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
  };
}

describe('bootstrap queue resume startup audit', () => {
  afterEach(() => {
    delete process.env.MEMPHIS_SECURITY_AUDIT_LOG_PATH;
    delete process.env.MEMPHIS_SAFE_MODE;
    resetStartupRuntimeStateForTests();
  });

  it('writes queue.resume.startup audit details with safe-mode redispatch override', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mv5-bootstrap-queue-resume-'));
    const config = cfg(dir, 'bootstrap-resume.db');
    const auditPath = join(dir, 'security-audit.jsonl');
    process.env.MEMPHIS_SECURITY_AUDIT_LOG_PATH = auditPath;

    const beforeRestart = createAppContainer(config);
    beforeRestart.taskQueue.enqueue({
      type: 'chat.generate',
      requestId: 'req-startup-1',
      payload: { input: 'hello', provider: 'auto', strategy: 'default' },
    });

    const afterRestart = createAppContainer(config);
    process.env.MEMPHIS_SAFE_MODE = 'true';
    await resumeRecoveredQueueTasksOnStartup(afterRestart, config, process.env);

    const auditLines = readFileSync(auditPath, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map(
        (line) =>
          JSON.parse(line) as { action: string; status: string; details?: Record<string, unknown> },
      );

    const startupResume = auditLines.find((line) => line.action === 'queue.resume.startup');
    expect(startupResume).toBeDefined();
    expect(startupResume?.status).toBe('allowed');
    expect(startupResume?.details).toMatchObject({
      policy: 'keep',
      safeModeOverrideApplied: true,
      scanned: 1,
      redispatched: 0,
      failed: 0,
      canceled: 0,
      kept: 1,
      errors: [],
    });

    const snapshot = afterRestart.taskQueue.snapshot();
    expect(snapshot.pendingTasks).toBe(1);
    expect(snapshot.lastResume?.policy).toBe('keep');
    expect(snapshot.lastResume?.kept).toBe(1);

    const app = createHttpServer(config, afterRestart.orchestration, {
      sessionRepository: afterRestart.sessionRepository,
      generationEventRepository: afterRestart.generationEventRepository,
      dualApprovalRepository: afterRestart.dualApprovalRepository,
      taskQueue: afterRestart.taskQueue,
    });
    const opsStatus = await app.inject({ method: 'GET', url: '/v1/ops/status' });
    expect(opsStatus.statusCode).toBe(200);
    const opsBody = opsStatus.json() as {
      startup?: {
        queueResume?: {
          policy?: string;
          safeModeOverrideApplied?: boolean;
          scanned?: number;
          kept?: number;
        } | null;
      };
    };
    expect(opsBody.startup?.queueResume).toMatchObject({
      policy: 'keep',
      safeModeOverrideApplied: true,
      scanned: 1,
      kept: 1,
    });
    await app.close();
  });
});
