import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  __resetScheduledBackupForTests,
  getScheduledBackupState,
  MIN_BACKUP_INTERVAL_MS,
  startScheduledBackupLoop,
} from '../../src/infra/runtime/scheduled-backup.js';

describe('scheduled backup loop (Phase 1.2 production sprint)', () => {
  beforeEach(() => {
    __resetScheduledBackupForTests();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    __resetScheduledBackupForTests();
  });

  it('does NOT start when MEMPHIS_BACKUP_INTERVAL_MS unset (operator opt-in only)', () => {
    const createBackupFn = vi.fn(async () => ({
      backupPath: '/tmp/x.tar.gz',
      file: 'x.tar.gz',
      size: 100,
    }));
    const handle = startScheduledBackupLoop({
      rawEnv: {} as NodeJS.ProcessEnv,
      createBackupFn,
    });
    vi.advanceTimersByTime(60_000);
    expect(createBackupFn).not.toHaveBeenCalled();
    expect(handle.state().enabled).toBe(false);
  });

  it('refuses intervals below the floor (5 min)', () => {
    const createBackupFn = vi.fn(async () => ({
      backupPath: '/tmp/x.tar.gz',
      file: 'x.tar.gz',
      size: 100,
    }));
    startScheduledBackupLoop({
      rawEnv: { MEMPHIS_BACKUP_INTERVAL_MS: '1000' } as NodeJS.ProcessEnv,
      createBackupFn,
    });
    vi.advanceTimersByTime(60_000);
    expect(createBackupFn).not.toHaveBeenCalled();
  });

  it('runs backup at the configured interval and records success', async () => {
    const createBackupFn = vi.fn(async () => ({
      backupPath: '/tmp/x.tar.gz',
      file: 'x.tar.gz',
      size: 1024,
    }));
    const cleanFn = vi.fn(async () => {});
    const handle = startScheduledBackupLoop({
      rawEnv: {
        MEMPHIS_BACKUP_INTERVAL_MS: String(MIN_BACKUP_INTERVAL_MS),
      } as NodeJS.ProcessEnv,
      createBackupFn,
      cleanFn,
      drillFn: async () => {},
    });
    await handle.tickNow();
    const s = handle.state();
    expect(s.totalSuccess).toBe(1);
    expect(s.lastSuccessFile).toBe('x.tar.gz');
    expect(s.lastSuccessSizeBytes).toBe(1024);
    expect(cleanFn).toHaveBeenCalledOnce();
    handle.stop();
  });

  it('restore-drill runs every Nth tick and records outcome', async () => {
    const drillFn = vi.fn(async () => {});
    const handle = startScheduledBackupLoop({
      rawEnv: {
        MEMPHIS_BACKUP_INTERVAL_MS: String(MIN_BACKUP_INTERVAL_MS),
        MEMPHIS_BACKUP_DRILL_EVERY_N: '3',
      } as NodeJS.ProcessEnv,
      createBackupFn: async () => ({
        backupPath: '/tmp/x.tar.gz',
        file: 'x.tar.gz',
        size: 100,
      }),
      cleanFn: async () => {},
      drillFn,
    });
    await handle.tickNow(); // 1
    await handle.tickNow(); // 2
    expect(drillFn).not.toHaveBeenCalled();
    await handle.tickNow(); // 3 → drill fires
    expect(drillFn).toHaveBeenCalledOnce();
    expect(handle.state().totalDrills).toBe(1);
    expect(handle.state().lastDrillOk).toBe(true);
  });

  it('failed restore-drill is recorded and alerts (lastDrillOk=false)', async () => {
    const handle = startScheduledBackupLoop({
      rawEnv: {
        MEMPHIS_BACKUP_INTERVAL_MS: String(MIN_BACKUP_INTERVAL_MS),
        MEMPHIS_BACKUP_DRILL_EVERY_N: '1',
      } as NodeJS.ProcessEnv,
      createBackupFn: async () => ({
        backupPath: '/tmp/x.tar.gz',
        file: 'x.tar.gz',
        size: 100,
      }),
      cleanFn: async () => {},
      drillFn: async () => {
        throw new Error('archive corrupt');
      },
    });
    await handle.tickNow();
    const s = handle.state();
    expect(s.totalSuccess).toBe(1);
    expect(s.lastDrillOk).toBe(false);
    expect(s.lastDrillError).toMatch(/archive corrupt/);
  });

  it('records failure on createBackup throw', async () => {
    const handle = startScheduledBackupLoop({
      rawEnv: {
        MEMPHIS_BACKUP_INTERVAL_MS: String(MIN_BACKUP_INTERVAL_MS),
      } as NodeJS.ProcessEnv,
      createBackupFn: async () => {
        throw new Error('disk full');
      },
      cleanFn: async () => {},
    });
    await handle.tickNow();
    const s = handle.state();
    expect(s.totalFailures).toBe(1);
    expect(s.lastError).toMatch(/disk full/);
    expect(s.lastErrorAt).toBeTruthy();
  });

  it('overlap guard: skips a tick when prior is still running', async () => {
    let resolveFirst: (() => void) | null = null;
    const createBackupFn = vi.fn(async () => {
      if (!resolveFirst) {
        await new Promise<void>((r) => {
          resolveFirst = r;
        });
      }
      return { backupPath: '/tmp/x.tar.gz', file: 'x.tar.gz', size: 100 };
    });
    const handle = startScheduledBackupLoop({
      rawEnv: {
        MEMPHIS_BACKUP_INTERVAL_MS: String(MIN_BACKUP_INTERVAL_MS),
      } as NodeJS.ProcessEnv,
      createBackupFn,
      cleanFn: async () => {},
      drillFn: async () => {},
    });
    // Fire a tick that hangs
    const hung = handle.tickNow();
    // Try to fire another tick — should be skipped
    const skipped = await handle.tickNow();
    expect(skipped.totalSuccess).toBe(0);
    // Release the hung tick
    resolveFirst?.();
    await hung;
    expect(handle.state().totalSuccess).toBe(1);
  });

  it('getScheduledBackupState reports staleness based on age vs threshold', async () => {
    const handle = startScheduledBackupLoop({
      rawEnv: {
        MEMPHIS_BACKUP_INTERVAL_MS: String(MIN_BACKUP_INTERVAL_MS),
        MEMPHIS_BACKUP_STALE_ALERT_MS: '1', // anything is stale
      } as NodeJS.ProcessEnv,
      createBackupFn: async () => ({
        backupPath: '/tmp/x.tar.gz',
        file: 'x.tar.gz',
        size: 100,
      }),
      cleanFn: async () => {},
      drillFn: async () => {},
    });
    await handle.tickNow();
    // Use real time briefly to ensure age > 1ms
    vi.useRealTimers();
    await new Promise((r) => setTimeout(r, 5));
    const report = getScheduledBackupState({
      MEMPHIS_BACKUP_INTERVAL_MS: String(MIN_BACKUP_INTERVAL_MS),
      MEMPHIS_BACKUP_STALE_ALERT_MS: '1',
    } as NodeJS.ProcessEnv);
    expect(report.isStale).toBe(true);
    expect(report.ageMs).toBeGreaterThan(0);
    handle.stop();
  });
});
