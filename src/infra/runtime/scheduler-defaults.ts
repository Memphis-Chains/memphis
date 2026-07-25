import type { SchedulerCommand } from './scheduler.js';

export const CANONICAL_SCHEDULER_TIMEZONE = 'Europe/Warsaw';

export type CanonicalSchedulerTask = {
  id: string;
  cron: string;
  timezone: string;
  name: string;
  command: SchedulerCommand;
  enabled: true;
};

export const CANONICAL_SCHEDULER_TASKS: readonly CanonicalSchedulerTask[] = [
  {
    id: 'builtin-runtime-watch',
    cron: '*/15 * * * *',
    timezone: CANONICAL_SCHEDULER_TIMEZONE,
    name: 'Memphis runtime watch',
    command: { type: 'builtin', job: 'runtime-watch' },
    enabled: true,
  },
  {
    id: 'builtin-scheduled-backup',
    cron: '0 2 * * *',
    timezone: CANONICAL_SCHEDULER_TIMEZONE,
    name: 'Memphis scheduled backup',
    command: { type: 'builtin', job: 'scheduled-backup' },
    enabled: true,
  },
  {
    id: 'builtin-doctor-diagnose',
    cron: '30 2 * * *',
    timezone: CANONICAL_SCHEDULER_TIMEZONE,
    name: 'Memphis doctor diagnose',
    command: { type: 'builtin', job: 'doctor-diagnose' },
    enabled: true,
  },
  {
    id: 'builtin-weekly-reflection',
    cron: '0 3 * * 0',
    timezone: CANONICAL_SCHEDULER_TIMEZONE,
    name: 'Memphis weekly reflection',
    command: { type: 'reflection', period: 'weekly' },
    enabled: true,
  },
  {
    id: 'builtin-attachment-retention',
    cron: '17 4 * * *',
    timezone: CANONICAL_SCHEDULER_TIMEZONE,
    name: 'Memphis attachment retention',
    command: { type: 'builtin', job: 'attachment-retention' },
    enabled: true,
  },
  {
    id: 'builtin-operator-briefing',
    cron: '0 9 * * *',
    timezone: CANONICAL_SCHEDULER_TIMEZONE,
    name: 'Memphis operator briefing',
    command: { type: 'builtin', job: 'operator-briefing' },
    enabled: true,
  },
  {
    id: 'builtin-daily-reflection',
    cron: '0 23 * * *',
    timezone: CANONICAL_SCHEDULER_TIMEZONE,
    name: 'Memphis daily reflection',
    command: { type: 'reflection', period: 'daily' },
    enabled: true,
  },
] as const;

export const LEGACY_SCHEDULER_TASK_IDS = new Set([
  'shell-mr0n50fw',
  'reflection-mr0n50gt',
  'shell-mr0n50ho',
  'reflection-mr0pjfmf',
  'shell-mr0pjfp2',
  'shell-mr0pl3d5',
]);

export const LEGACY_SCHEDULER_TASK_NAMES = new Set([
  'memphis-backup-daily',
  'memphis-reflection-daily',
  'memphis-health-watchdog',
  'weekly-reflection-mode-e',
  'daily-repair-attempt',
  'slo-monitor-telegram-alert',
]);
