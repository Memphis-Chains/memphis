import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  restoreOptionalBackgroundWork,
  shedOptionalBackgroundWork,
} from '../../src/infra/runtime/scheduler-builtins.js';
import { loadTasks, saveTasks, type ScheduledTask } from '../../src/infra/runtime/scheduler.js';

let dataDir = '';
let priorDataDir: string | undefined;

function task(id: string, enabled: boolean): ScheduledTask {
  return {
    schemaVersion: 2,
    id,
    cron: '0 3 * * *',
    timezone: 'Europe/Warsaw',
    name: id,
    command: { type: 'builtin', job: 'doctor-diagnose' },
    enabled,
    lastRun: null,
    nextRun: null,
    lastStatus: null,
    startedAt: null,
    finishedAt: null,
    lastError: null,
    lastScheduledFor: null,
    leaseOwner: null,
    leaseExpiresAt: null,
    createdAt: '2026-11-20T00:00:00.000Z',
    runCount: 0,
  };
}

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'memphis-homeostat-'));
  priorDataDir = process.env.MEMPHIS_DATA_DIR;
  process.env.MEMPHIS_DATA_DIR = dataDir;
});

afterEach(() => {
  if (priorDataDir === undefined) delete process.env.MEMPHIS_DATA_DIR;
  else process.env.MEMPHIS_DATA_DIR = priorDataDir;
  rmSync(dataDir, { recursive: true, force: true });
});

describe('the homeostat sheds and restores the optional background work', () => {
  it('switches off only the tasks it was given', () => {
    saveTasks([task('builtin-operator-briefing', true), task('builtin-runtime-watch', true)]);
    const result = shedOptionalBackgroundWork(['builtin-operator-briefing']);
    expect(result.shed).toEqual(['builtin-operator-briefing']);
    const after = loadTasks();
    expect(after.find((entry) => entry.id === 'builtin-operator-briefing')?.enabled).toBe(false);
    expect(after.find((entry) => entry.id === 'builtin-runtime-watch')?.enabled).toBe(true);
  });

  it('says so when there is nothing left to shed', () => {
    saveTasks([task('builtin-operator-briefing', false)]);
    const result = shedOptionalBackgroundWork(['builtin-operator-briefing']);
    expect(result.shed).toEqual([]);
    expect(result.detail).toContain('already shed');
  });

  it('switches back on only the tasks the homeostat switched off', () => {
    saveTasks([
      task('builtin-operator-briefing', false),
      task('builtin-attachment-retention', false),
    ]);
    const result = restoreOptionalBackgroundWork(['builtin-operator-briefing']);
    expect(result.restored).toEqual(['builtin-operator-briefing']);
    const after = loadTasks();
    expect(after.find((entry) => entry.id === 'builtin-operator-briefing')?.enabled).toBe(true);
    expect(after.find((entry) => entry.id === 'builtin-attachment-retention')?.enabled).toBe(false);
  });

  it('does nothing when it is given no task at all', () => {
    saveTasks([task('builtin-operator-briefing', true)]);
    expect(shedOptionalBackgroundWork([]).shed).toEqual([]);
    expect(restoreOptionalBackgroundWork([]).restored).toEqual([]);
    expect(loadTasks()[0]?.enabled).toBe(true);
  });
});
