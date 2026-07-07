import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resolveSurfacePolicy, isToolAllowedForSurface } from '../../src/gateway/surface-policy.js';
import { createInProcessToolExecutor } from '../../src/gateway/tool-executor.js';
import { runMemphisLrDashboard } from '../../src/mcp/tools/lr-dashboard.js';
import { realTmpdir as tmpdir } from '../helpers/tmpdir.js';

let dir: string;
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lr-dashboard-tool-'));
  env = { MEMPHIS_DATA_DIR: dir };
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('memphis_lr_dashboard tool', () => {
  it('reports status without requiring exec or localhost fetch', () => {
    const result = runMemphisLrDashboard({ action: 'status' }, env);

    expect(result.ok).toBe(true);
    expect(result.action).toBe('status');
    expect(result.dbPath).toBe(join(dir, 'apps', 'lr-dashboard', 'state', 'lr.sqlite'));
    expect(result.dbExists).toBe(false);
  });

  it('adds a validated row to the managed app SQLite store', () => {
    const inserted = runMemphisLrDashboard(
      {
        action: 'add_entry',
        measuredAt: '2026-07-07',
        category: 'body-ph',
        marker: 'urine_ph',
        value: '6.8',
        unit: 'pH',
        note: 'kuracja Horaka, baseline',
      },
      env,
    );

    expect(inserted.action).toBe('add_entry');
    expect(inserted.entry).toMatchObject({
      id: 1,
      measuredAt: '2026-07-07',
      category: 'body-ph',
      marker: 'urine_ph',
      value: '6.8',
      unit: 'pH',
      note: 'kuracja Horaka, baseline',
    });

    const status = runMemphisLrDashboard({ action: 'status' }, env);
    expect(status.dbExists).toBe(true);
    expect(status.entries).toBe(1);
  });

  it('is exposed by the in-process executor for Telegram-safe calls', () => {
    const executor = createInProcessToolExecutor({ rawEnv: env });
    expect(executor.listTools().map((tool) => tool.name)).toContain('memphis_lr_dashboard');
  });

  it('is allowed by the default Telegram surface policy', () => {
    const policy = resolveSurfacePolicy('telegram', env);
    expect(isToolAllowedForSurface('memphis_lr_dashboard', policy)).toBe(true);
  });
});
