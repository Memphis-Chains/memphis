import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  CRON_TASK_ID_PREFIX,
  parseCronDirective,
  readCronScripts,
  reconcileCronTasks,
  resolveCronsDir,
} from '../../src/infra/runtime/crons-bridge.js';
import { loadTasks, saveTasks } from '../../src/infra/runtime/scheduler.js';

const roots: string[] = [];
const originalDataDir = process.env.MEMPHIS_DATA_DIR;

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
  if (originalDataDir === undefined) {
    delete process.env.MEMPHIS_DATA_DIR;
  } else {
    process.env.MEMPHIS_DATA_DIR = originalDataDir;
  }
});

/**
 * An isolated data dir (for the task store) plus a crons dir, the way the
 * native `memphis_cron` tool lays them out.
 */
function fixture(scripts: Array<{ name: string; schedule?: string; executable?: boolean }>) {
  const root = mkdtempSync(join(tmpdir(), 'memphis-crons-bridge-'));
  roots.push(root);
  const cronsDir = join(root, 'crons');
  const dataDir = join(root, 'data');
  mkdirSync(cronsDir, { recursive: true });
  mkdirSync(dataDir, { recursive: true });
  for (const script of scripts) {
    const body = [
      '#!/usr/bin/env bash',
      ...(script.schedule ? [`# schedule: ${script.schedule}`] : []),
      'set -euo pipefail',
      '',
      'echo hello',
      '',
    ].join('\n');
    const path = join(cronsDir, script.name);
    writeFileSync(path, body, { mode: 0o755 });
    if (script.executable === false) {
      chmodSync(path, 0o644);
    }
  }
  process.env.MEMPHIS_DATA_DIR = dataDir;
  return { cronsDir, dataDir, root };
}

describe('the crons bridge', () => {
  it('registers a scheduled script as a scheduler task', () => {
    const { cronsDir } = fixture([
      { name: 'memphis-usage-record.sh', schedule: '*/10 * * * *' },
    ]);

    const result = reconcileCronTasks({ apply: true, cronsDir });

    expect(result.added).toEqual([`${CRON_TASK_ID_PREFIX}memphis-usage-record`]);
    const tasks = loadTasks();
    const task = tasks.find((entry) => entry.id === result.added[0]);
    expect(task).toBeDefined();
    expect(task?.cron).toBe('*/10 * * * *');
    expect(task?.enabled).toBe(true);
    expect(task?.command).toEqual({
      type: 'shell',
      script: `bash ${join(cronsDir, 'memphis-usage-record.sh')}`,
    });
  });

  it('registers a script without the executable bit as disabled', () => {
    const { cronsDir } = fixture([
      { name: 'paused.sh', schedule: '0 3 * * *', executable: false },
    ]);

    reconcileCronTasks({ apply: true, cronsDir });

    const task = loadTasks().find((entry) => entry.id === `${CRON_TASK_ID_PREFIX}paused`);
    expect(task?.enabled).toBe(false);
  });

  it('leaves a script without a schedule header unregistered', () => {
    const { cronsDir } = fixture([{ name: 'manual.sh' }]);

    const result = reconcileCronTasks({ apply: true, cronsDir });

    expect(result.added).toEqual([]);
    expect(loadTasks()).toEqual([]);
  });

  it('updates the schedule when the script header changes', () => {
    const { cronsDir } = fixture([
      { name: 'job.sh', schedule: '0 3 * * *' },
    ]);
    reconcileCronTasks({ apply: true, cronsDir });

    writeFileSync(
      join(cronsDir, 'job.sh'),
      '#!/usr/bin/env bash\n# schedule: 0 4 * * *\nset -euo pipefail\n\necho hello\n',
      { mode: 0o755 },
    );
    const result = reconcileCronTasks({ apply: true, cronsDir });

    expect(result.updated).toEqual([`${CRON_TASK_ID_PREFIX}job`]);
    const task = loadTasks().find((entry) => entry.id === `${CRON_TASK_ID_PREFIX}job`);
    expect(task?.cron).toBe('0 4 * * *');
  });

  it('unregisters a task when the script is deleted', () => {
    const { cronsDir } = fixture([
      { name: 'job.sh', schedule: '0 3 * * *' },
      { name: 'other.sh', schedule: '0 5 * * *' },
    ]);
    reconcileCronTasks({ apply: true, cronsDir });

    rmSync(join(cronsDir, 'job.sh'));
    const result = reconcileCronTasks({ apply: true, cronsDir });

    expect(result.removed).toEqual([`${CRON_TASK_ID_PREFIX}job`]);
    const ids = loadTasks().map((entry) => entry.id);
    expect(ids).toContain(`${CRON_TASK_ID_PREFIX}other`);
    expect(ids).not.toContain(`${CRON_TASK_ID_PREFIX}job`);
  });

  it('preserves tasks it does not own', () => {
    const { cronsDir } = fixture([{ name: 'job.sh', schedule: '0 3 * * *' }]);
    // A task the operator added by hand, with an id the bridge does not own.
    saveTasks([
      {
        schemaVersion: 2,
        id: 'my-own-task',
        cron: '0 6 * * *',
        timezone: 'Europe/Warsaw',
        name: 'My own task',
        command: { type: 'shell', script: 'echo hi' },
        enabled: true,
        lastRun: null,
        nextRun: null,
        lastStatus: null,
        startedAt: null,
        finishedAt: null,
        lastError: null,
        lastScheduledFor: null,
        leaseOwner: null,
        leaseExpiresAt: null,
        createdAt: new Date().toISOString(),
        runCount: 0,
      },
    ]);

    reconcileCronTasks({ apply: true, cronsDir });

    const ids = loadTasks().map((entry) => entry.id);
    expect(ids).toContain('my-own-task');
    expect(ids).toContain(`${CRON_TASK_ID_PREFIX}job`);
  });

  it('reports a script with an invalid cron instead of registering it', () => {
    const { cronsDir } = fixture([{ name: 'broken.sh', schedule: 'not a cron' }]);

    const result = reconcileCronTasks({ apply: true, cronsDir });

    expect(result.added).toEqual([]);
    expect(result.problems).toHaveLength(1);
    expect(result.problems[0]?.file).toBe('broken.sh');
    expect(loadTasks()).toEqual([]);
  });

  it('is idempotent: a second sync changes nothing', () => {
    const { cronsDir } = fixture([
      { name: 'job.sh', schedule: '0 3 * * *' },
    ]);
    reconcileCronTasks({ apply: true, cronsDir });

    const second = reconcileCronTasks({ apply: true, cronsDir });

    expect(second.changed).toBe(false);
    expect(second.added).toEqual([]);
    expect(second.updated).toEqual([]);
    expect(second.removed).toEqual([]);
  });
});

describe('cron directive parsing', () => {
  it('reads the schedule the native tool writes', () => {
    expect(
      parseCronDirective('#!/usr/bin/env bash\n# schedule: 17 7 * * *\nset -euo pipefail\n'),
    ).toBe('17 7 * * *');
  });

  it('returns nothing for a script without the header', () => {
    expect(parseCronDirective('#!/usr/bin/env bash\necho hi\n')).toBeUndefined();
  });

  it('resolves the directory the native tool writes to', () => {
    expect(resolveCronsDir({ HOME: '/home/operator' })).toBe('/home/operator/memphis/crons');
  });

  it('reads the executable bit as the enabled flag', () => {
    const root = mkdtempSync(join(tmpdir(), 'memphis-crons-read-'));
    roots.push(root);
    writeFileSync(join(root, 'on.sh'), '# schedule: * * * * *\n', { mode: 0o755 });
    writeFileSync(join(root, 'off.sh'), '# schedule: * * * * *\n', { mode: 0o644 });

    const { scripts } = readCronScripts(root);

    expect(scripts.find((script) => script.file === 'on.sh')?.enabled).toBe(true);
    expect(scripts.find((script) => script.file === 'off.sh')?.enabled).toBe(false);
  });
});
