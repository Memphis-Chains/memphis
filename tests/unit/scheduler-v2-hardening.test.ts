import { mkdirSync, mkdtempSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { cleanBackups } from '../../src/infra/cli/commands/backup.js';
import { pruneTelegramAttachments } from '../../src/infra/runtime/scheduler-builtins.js';
import {
  getNextRun,
  loadTasks,
  matchesCron,
  parseCron,
  reconcileScheduledTasks,
  saveTasks,
} from '../../src/infra/runtime/scheduler.js';

afterEach(() => {
  delete process.env.MEMPHIS_DATA_DIR;
});

describe('scheduler v2 hardening', () => {
  it('uses standard cron OR semantics when DOM and DOW are both restricted', () => {
    const cron = parseCron('0 9 15 * 1');
    // Monday 2026-06-01, not the 15th: DOW match is sufficient.
    expect(matchesCron(cron, new Date('2026-06-01T07:00:00Z'), 'Europe/Warsaw')).toBe(true);
    // Monday 2026-06-15: both match.
    expect(matchesCron(cron, new Date('2026-06-15T07:00:00Z'), 'Europe/Warsaw')).toBe(true);
  });

  it('calculates the canonical briefing in Europe/Warsaw across DST', () => {
    expect(
      getNextRun('0 9 * * *', new Date('2026-07-25T06:59:30Z'), 'Europe/Warsaw').toISOString(),
    ).toBe('2026-07-25T07:00:00.000Z');
    expect(
      getNextRun('0 9 * * *', new Date('2026-12-25T07:59:30Z'), 'Europe/Warsaw').toISOString(),
    ).toBe('2026-12-25T08:00:00.000Z');
  });

  it('reconciles legacy tasks idempotently and preserves custom tasks', () => {
    const root = mkdtempSync(join(tmpdir(), 'scheduler-v2-'));
    process.env.MEMPHIS_DATA_DIR = root;
    saveTasks([
      {
        schemaVersion: 2,
        id: 'shell-mr0pjfp2',
        cron: '0 2 * * *',
        timezone: 'Europe/Warsaw',
        name: 'daily-repair-attempt',
        command: { type: 'shell', script: 'memphis repair --force || true' },
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
      {
        schemaVersion: 2,
        id: 'operator-custom',
        cron: '5 * * * *',
        timezone: 'UTC',
        name: 'Operator custom',
        command: { type: 'shell', script: 'echo custom' },
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

    const preview = reconcileScheduledTasks();
    expect(preview.removed).toContain('shell-mr0pjfp2');
    expect(preview.preserved).toContain('operator-custom');
    reconcileScheduledTasks({ apply: true, now: new Date('2026-07-25T00:00:00Z') });
    expect(loadTasks()).toHaveLength(8);
    expect(loadTasks().filter((task) => task.id.startsWith('builtin-'))).toHaveLength(7);
    expect(reconcileScheduledTasks().changed).toBe(false);
    expect(statSync(join(root, 'config', 'scheduler', 'tasks.json')).mode & 0o777).toBe(0o600);
  });

  it('quarantines old Telegram attachments before permanently purging them', () => {
    const root = mkdtempSync(join(tmpdir(), 'scheduler-attachments-'));
    process.env.MEMPHIS_DATA_DIR = root;
    const attachments = join(root, 'state', 'telegram-attachments');
    mkdirSync(attachments, { recursive: true });
    const old = join(attachments, 'old.pdf');
    writeFileSync(old, 'old');
    const now = Date.now();
    utimesSync(old, new Date(now - 8 * 86_400_000), new Date(now - 8 * 86_400_000));

    const dry = pruneTelegramAttachments({ apply: false, nowMs: now });
    expect(dry.wouldQuarantine).toEqual([old]);
    expect(readFileSync(old, 'utf8')).toBe('old');

    const applied = pruneTelegramAttachments({ apply: true, nowMs: now });
    expect(applied.quarantined).toHaveLength(1);
  });

  it('cleans only scheduled backups when retention is tag-scoped', async () => {
    const backupRoot = mkdtempSync(join(tmpdir(), 'scheduler-backups-'));
    const entries = [
      ['scheduled-new.tar.gz', 'scheduled', '2026-07-25T00:00:00.000Z'],
      ['scheduled-old.tar.gz', 'scheduled', '2026-07-24T00:00:00.000Z'],
      ['manual-critical.tar.gz', 'manual', '2026-01-01T00:00:00.000Z'],
    ] as const;
    for (const [file] of entries) writeFileSync(join(backupRoot, file), file);
    writeFileSync(
      join(backupRoot, 'manifest.json'),
      JSON.stringify({
        retentionPolicy: { keepDaily: 7, keepWeekly: 4, keepMonthly: 12 },
        backups: entries.map(([file, tag, timestamp]) => ({
          file,
          tag,
          timestamp,
          size: 1,
          checksum: 'sha256:test',
          fileCount: 1,
        })),
      }),
    );

    const result = await cleanBackups({ backupRoot, keep: 1, tag: 'scheduled' });
    expect(result.removed).toEqual(['scheduled-old.tar.gz']);
    expect(readFileSync(join(backupRoot, 'manual-critical.tar.gz'), 'utf8')).toBe(
      'manual-critical.tar.gz',
    );
  });
});
