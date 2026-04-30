import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { runDoctorChecksV2 } from '../../src/infra/cli/utils/doctor-v2.js';

describe('doctor t6-cron-tasks check (S4-4)', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    vi.restoreAllMocks();
    process.env = { ...originalEnv };
  });

  it('omits the cron check when tasks.json does not exist', async () => {
    const memphisDir = mkdtempSync(join(tmpdir(), 'memphis-cron-doctor-'));
    process.env = {
      ...originalEnv,
      NODE_ENV: 'test',
      MEMPHIS_DATA_DIR: memphisDir,
      RUST_CHAIN_ENABLED: 'false',
    };

    const report = await runDoctorChecksV2();
    const cronCheck = report.checks.find((c) => c.id === 't6-cron-tasks');
    expect(cronCheck).toBeUndefined();
  });

  it('passes when all enabled tasks have lastStatus !== failed', async () => {
    const memphisDir = mkdtempSync(join(tmpdir(), 'memphis-cron-doctor-'));
    const schedulerDir = join(memphisDir, 'config', 'scheduler');
    mkdirSync(schedulerDir, { recursive: true });
    writeFileSync(
      join(schedulerDir, 'tasks.json'),
      JSON.stringify([
        {
          id: 'morning-raport-wodzu',
          name: 'Morning report',
          cron: '0 6 * * *',
          command: { type: 'shell', script: 'echo hi' },
          enabled: true,
          lastRun: new Date().toISOString(),
          nextRun: null,
          lastStatus: 'success',
          createdAt: new Date().toISOString(),
          runCount: 5,
        },
      ]),
    );

    process.env = {
      ...originalEnv,
      NODE_ENV: 'test',
      MEMPHIS_DATA_DIR: memphisDir,
      RUST_CHAIN_ENABLED: 'false',
    };

    const report = await runDoctorChecksV2();
    const cronCheck = report.checks.find((c) => c.id === 't6-cron-tasks');
    expect(cronCheck?.level).toBe('pass');
    expect(cronCheck?.detail).toContain('1 enabled task(s)');
    expect(cronCheck?.detail).toContain('0 failures');
  });

  it('warns when tasks.json is present but unreadable (Codex P2 round 1)', async () => {
    // Operator pain: silent skip on malformed tasks.json hid the
    // scheduler-misconfig signal entirely. Now doctor surfaces a warn
    // with the parse error and a recovery hint.
    const memphisDir = mkdtempSync(join(tmpdir(), 'memphis-cron-doctor-'));
    const schedulerDir = join(memphisDir, 'config', 'scheduler');
    mkdirSync(schedulerDir, { recursive: true });
    writeFileSync(join(schedulerDir, 'tasks.json'), '{not valid json');

    process.env = {
      ...originalEnv,
      NODE_ENV: 'test',
      MEMPHIS_DATA_DIR: memphisDir,
      RUST_CHAIN_ENABLED: 'false',
    };

    const report = await runDoctorChecksV2();
    const cronCheck = report.checks.find((c) => c.id === 't6-cron-tasks');
    expect(cronCheck?.level).toBe('warn');
    expect(cronCheck?.ok).toBe(false);
    expect(cronCheck?.detail).toContain('tasks.json unreadable');
    expect(cronCheck?.fix).toContain('jq .');
  });

  it('warns and points to the log path when a task last failed', async () => {
    // Operator pain that motivated this check: a cron task came back
    // 'failed' in the morning report but the operator could not find
    // where to look for the failure detail. Now doctor names the file.
    const memphisDir = mkdtempSync(join(tmpdir(), 'memphis-cron-doctor-'));
    const schedulerDir = join(memphisDir, 'config', 'scheduler');
    mkdirSync(schedulerDir, { recursive: true });
    writeFileSync(
      join(schedulerDir, 'tasks.json'),
      JSON.stringify([
        {
          id: 'morning-raport-wodzu',
          name: 'Morning report',
          cron: '0 6 * * *',
          command: { type: 'shell', script: 'echo hi' },
          enabled: true,
          lastRun: new Date().toISOString(),
          nextRun: null,
          lastStatus: 'failed',
          createdAt: new Date().toISOString(),
          runCount: 5,
        },
      ]),
    );

    process.env = {
      ...originalEnv,
      NODE_ENV: 'test',
      MEMPHIS_DATA_DIR: memphisDir,
      RUST_CHAIN_ENABLED: 'false',
    };

    const report = await runDoctorChecksV2();
    const cronCheck = report.checks.find((c) => c.id === 't6-cron-tasks');
    expect(cronCheck?.level).toBe('warn');
    expect(cronCheck?.detail).toContain('morning-raport-wodzu');
    expect(cronCheck?.detail).toContain('logs at');
    expect(cronCheck?.fix).toContain('morning-raport-wodzu.log');
  });
});
