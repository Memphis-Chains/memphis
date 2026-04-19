import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { MemphisScheduler } from '../../src/infra/runtime/scheduler.js';
import { runCliResult } from '../helpers/cli.js';

describe('CLI schedule runtime dispatch', () => {
  afterEach(() => {
    delete process.env.MEMPHIS_DATA_DIR;
    delete process.env.MEMPHIS_SESSION_TOKEN_SECRET;
    delete process.env.RUST_CHAIN_ENABLED;
  });

  it('enqueues scheduled tasks through worker runtime when --runtime is used', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'memphis-cli-schedule-runtime-'));
    process.env.MEMPHIS_DATA_DIR = dir;

    const scheduler = new MemphisScheduler();
    const task = scheduler.addTask({
      id: 'cli-schedule-runtime',
      cron: '* * * * *',
      name: 'CLI runtime schedule task',
      command: { type: 'shell', script: 'printf cli-runtime' },
      enabled: true,
    });

    const db = join(dir, 'runtime.db');
    const env = {
      DATABASE_URL: `file:${db}`,
      MEMPHIS_DATA_DIR: dir,
      MEMPHIS_SESSION_TOKEN_SECRET: '0123456789abcdef0123456789abcdef',
      RUST_CHAIN_ENABLED: 'false',
      LOG_LEVEL: 'error',
    };

    const result = await runCliResult(['schedule', 'run', '--id', task.id, '--runtime', '--json'], {
      env,
    });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: true,
      mode: 'schedule.run.runtime',
      taskId: task.id,
      status: 'pending',
      capabilityScope: ['task:scheduler.execute'],
    });
  });
});
