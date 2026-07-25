/**
 * Memphis Task Scheduler
 *
 * Built-in cron-like scheduler that allows Memphis to execute tasks
 * on a schedule without external cron/systemd timers.
 *
 * Tasks are stored in ~/.memphis/config/scheduler/tasks.json
 * Memphis worker checks every 30 seconds for tasks to execute.
 *
 * Example task:
 * {
 *   "id": "daily-deploy",
 *   "cron": "0 20 * * *",
 *   "name": "Daily deploy check",
 *   "command": "git-pull-and-build",
 *   "enabled": true,
 *   "lastRun": "2026-04-01T20:00:00Z",
 *   "nextRun": "2026-04-02T20:00:00Z",
 *   "lastStatus": "success"
 * }
 */

import { spawn } from 'node:child_process';
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import path, { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runReflectionCycle } from './reflection-loop.js';
import type { BuiltinSchedulerJob } from './scheduler-builtins.js';
import {
  CANONICAL_SCHEDULER_TASKS,
  LEGACY_SCHEDULER_TASK_IDS,
  LEGACY_SCHEDULER_TASK_NAMES,
} from './scheduler-defaults.js';
import { getUserServiceStatus, resolveRuntimeRoot } from './user-service.js';
import { HOME } from '../../config/env-registry.js';
import { getConfigPath } from '../../config/paths.js';
import { runDeployPipeline, type DeployProfile } from '../deploy/pipeline.js';
import { appendBlock } from '../storage/chain-adapter.js';
import { SCHEDULER_EXECUTE_WORK_CAPABILITY } from '../work/work-capabilities.js';
import type { WorkPollingService } from '../work/work-polling-service.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ScheduledTask {
  schemaVersion: 2;
  id: string;
  cron: string; // Standard cron: "min hour day month dow"
  /** IANA time zone. Missing legacy values are migrated to the host zone. */
  timezone: string;
  name: string;
  command: SchedulerCommand;
  enabled: boolean;
  lastRun: string | null;
  nextRun: string | null;
  lastStatus: SchedulerTaskStatus | null;
  startedAt: string | null;
  finishedAt: string | null;
  lastError: string | null;
  lastScheduledFor: string | null;
  leaseOwner: string | null;
  leaseExpiresAt: string | null;
  createdAt: string;
  runCount: number;
}

export type SchedulerTaskStatus =
  | 'pending'
  | 'running'
  | 'success'
  | 'failed'
  | 'skipped'
  | 'timed_out';

export type SchedulerCommand =
  | { type: 'git-pull-build' }
  | { type: 'shell'; script: string }
  | { type: 'reflection'; period?: 'daily' | 'weekly' }
  | { type: 'builtin'; job: BuiltinSchedulerJob }
  | { type: 'http'; url: string; method?: string; body?: string };

// ── Paths ─────────────────────────────────────────────────────────────────────

export function getSchedulerDir(): string {
  return getConfigPath('scheduler');
}

export function getSchedulerTasksPath(): string {
  return join(getSchedulerDir(), 'tasks.json');
}

export function getSchedulerLogsDir(): string {
  return join(getSchedulerDir(), 'logs');
}

// ── Storage ───────────────────────────────────────────────────────────────────

function hostTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

function normalizeTask(value: unknown): ScheduledTask | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (
    typeof raw.id !== 'string' ||
    typeof raw.cron !== 'string' ||
    typeof raw.name !== 'string' ||
    !raw.command ||
    typeof raw.command !== 'object' ||
    typeof raw.enabled !== 'boolean'
  ) {
    return null;
  }
  const timezone = typeof raw.timezone === 'string' ? raw.timezone : hostTimezone();
  validateTimezone(timezone);
  parseCron(raw.cron);
  return {
    schemaVersion: 2,
    id: raw.id,
    cron: raw.cron,
    timezone,
    name: raw.name,
    command: raw.command as SchedulerCommand,
    enabled: raw.enabled,
    lastRun: typeof raw.lastRun === 'string' ? raw.lastRun : null,
    nextRun: typeof raw.nextRun === 'string' ? raw.nextRun : null,
    lastStatus: typeof raw.lastStatus === 'string' ? (raw.lastStatus as SchedulerTaskStatus) : null,
    startedAt: typeof raw.startedAt === 'string' ? raw.startedAt : null,
    finishedAt: typeof raw.finishedAt === 'string' ? raw.finishedAt : null,
    lastError: typeof raw.lastError === 'string' ? raw.lastError : null,
    lastScheduledFor: typeof raw.lastScheduledFor === 'string' ? raw.lastScheduledFor : null,
    leaseOwner: typeof raw.leaseOwner === 'string' ? raw.leaseOwner : null,
    leaseExpiresAt: typeof raw.leaseExpiresAt === 'string' ? raw.leaseExpiresAt : null,
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : new Date().toISOString(),
    runCount:
      typeof raw.runCount === 'number' && Number.isFinite(raw.runCount)
        ? Math.max(0, Math.floor(raw.runCount))
        : 0,
  };
}

export function loadTasks(): ScheduledTask[] {
  const tasksPath = getSchedulerTasksPath();
  if (!existsSync(tasksPath)) return [];
  try {
    const parsed = JSON.parse(readFileSync(tasksPath, 'utf8')) as unknown;
    if (!Array.isArray(parsed)) {
      throw new Error('scheduler tasks store must contain a JSON array');
    }
    const tasks = parsed.map(normalizeTask);
    if (tasks.some((task) => task === null)) {
      throw new Error('scheduler tasks store contains an invalid task');
    }
    return tasks as ScheduledTask[];
  } catch (error) {
    throw new Error(
      `Cannot load scheduler tasks from ${tasksPath}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

export function saveTasks(tasks: ScheduledTask[]): void {
  mkdirSync(getSchedulerDir(), { recursive: true });
  const tasksPath = getSchedulerTasksPath();
  const tmpPath = `${tasksPath}.${process.pid}.${Date.now()}.tmp`;
  const fd = openSync(tmpPath, 'wx', 0o600);
  try {
    writeSync(fd, `${JSON.stringify(tasks, null, 2)}\n`, undefined, 'utf8');
  } finally {
    closeSync(fd);
  }
  renameSync(tmpPath, tasksPath);
  chmodSync(tasksPath, 0o600);
}

function withTaskStoreLock<T>(operation: () => T): T {
  mkdirSync(getSchedulerDir(), { recursive: true });
  const lockPath = join(getSchedulerDir(), 'tasks.lock');
  let fd: number;
  try {
    fd = openSync(lockPath, 'wx', 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      if (Date.now() - statSync(lockPath).mtimeMs > 10 * 60 * 1000) {
        unlinkSync(lockPath);
        fd = openSync(lockPath, 'wx', 0o600);
      } else {
        throw new Error('scheduler task store is locked by another process');
      }
    } else {
      throw error;
    }
  }
  try {
    writeSync(fd, `${process.pid}\n`);
    return operation();
  } finally {
    closeSync(fd);
    try {
      unlinkSync(lockPath);
    } catch {
      // A stale-lock recovery may already have removed it.
    }
  }
}

export type SchedulerReconcileResult = {
  changed: boolean;
  added: string[];
  updated: string[];
  removed: string[];
  preserved: string[];
};

export function reconcileScheduledTasks(
  options: {
    apply?: boolean;
    now?: Date;
  } = {},
): SchedulerReconcileResult {
  const current = loadTasks();
  const canonicalIds = new Set(CANONICAL_SCHEDULER_TASKS.map((task) => task.id));
  const legacy = current.filter(
    (task) => LEGACY_SCHEDULER_TASK_IDS.has(task.id) || LEGACY_SCHEDULER_TASK_NAMES.has(task.name),
  );
  const custom = current.filter((task) => !canonicalIds.has(task.id) && !legacy.includes(task));
  const added = CANONICAL_SCHEDULER_TASKS.filter(
    (task) => !current.some((existing) => existing.id === task.id),
  ).map((task) => task.id);
  const updated = CANONICAL_SCHEDULER_TASKS.filter((task) => {
    const existing = current.find((candidate) => candidate.id === task.id);
    return (
      existing &&
      (existing.cron !== task.cron ||
        existing.timezone !== task.timezone ||
        existing.name !== task.name ||
        JSON.stringify(existing.command) !== JSON.stringify(task.command) ||
        !existing.enabled)
    );
  }).map((task) => task.id);
  const result: SchedulerReconcileResult = {
    changed: added.length > 0 || updated.length > 0 || legacy.length > 0,
    added,
    updated,
    removed: legacy.map((task) => task.id),
    preserved: custom.map((task) => task.id),
  };
  if (!options.apply || !result.changed) return result;

  withTaskStoreLock(() => {
    const latest = loadTasks();
    const latestCustom = latest.filter(
      (task) =>
        !canonicalIds.has(task.id) &&
        !LEGACY_SCHEDULER_TASK_IDS.has(task.id) &&
        !LEGACY_SCHEDULER_TASK_NAMES.has(task.name),
    );
    const now = options.now ?? new Date();
    const canonical = CANONICAL_SCHEDULER_TASKS.map((definition) => {
      const existing = latest.find((task) => task.id === definition.id);
      if (existing) {
        return {
          ...existing,
          ...definition,
          schemaVersion: 2 as const,
          nextRun: getNextRun(definition.cron, now, definition.timezone).toISOString(),
        };
      }
      return {
        ...definition,
        schemaVersion: 2 as const,
        lastRun: null,
        nextRun: getNextRun(definition.cron, now, definition.timezone).toISOString(),
        lastStatus: null,
        startedAt: null,
        finishedAt: null,
        lastError: null,
        lastScheduledFor: null,
        leaseOwner: null,
        leaseExpiresAt: null,
        createdAt: now.toISOString(),
        runCount: 0,
      } satisfies ScheduledTask;
    });
    saveTasks([...latestCustom, ...canonical]);
  });
  return result;
}

// ── Cron Parsing ──────────────────────────────────────────────────────────────

interface CronFields {
  minute: number[];
  hour: number[];
  dayOfMonth: number[];
  month: number[];
  dayOfWeek: number[];
  dayOfMonthWildcard: boolean;
  dayOfWeekWildcard: boolean;
}

/**
 * Parse a cron field (e.g., "5,10" or "every 5" or "1-10")
 */
function parseCronField(field: string, min: number, max: number): number[] {
  if (field === '*') {
    return Array.from({ length: max - min + 1 }, (_, i) => min + i);
  }

  const values: number[] = [];
  const parts = field.split(',');

  for (const part of parts) {
    if (part.includes('/')) {
      // Step: */5 or 1-10/2
      const [range, stepStr] = part.split('/');
      const step = parseInt(stepStr, 10);
      if (!Number.isInteger(step) || step <= 0) {
        throw new Error(`Invalid cron step: ${part}`);
      }
      let rangeValues: number[];
      if (range === '*') {
        rangeValues = Array.from({ length: max - min + 1 }, (_, i) => min + i);
      } else if (range.includes('-')) {
        const [startStr, endStr] = range.split('-');
        rangeValues = Array.from(
          { length: parseInt(endStr, 10) - parseInt(startStr, 10) + 1 },
          (_, i) => parseInt(startStr, 10) + i,
        );
      } else {
        rangeValues = [parseInt(range, 10)];
      }
      for (let i = 0; i < rangeValues.length; i += step) {
        values.push(rangeValues[i]);
      }
    } else if (part.includes('-')) {
      const [startStr, endStr] = part.split('-');
      const start = parseInt(startStr, 10);
      const end = parseInt(endStr, 10);
      for (let i = start; i <= end; i++) {
        values.push(i);
      }
    } else {
      values.push(parseInt(part, 10));
    }
  }

  if (values.some((value) => !Number.isInteger(value) || value < min || value > max)) {
    throw new Error(`Cron field out of range (${min}-${max}): ${field}`);
  }
  return [...new Set(values)].sort((a, b) => a - b);
}

export function parseCron(cron: string): CronFields {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new Error(`Invalid cron expression: ${cron} (expected 5 fields)`);
  }
  return {
    minute: parseCronField(parts[0], 0, 59),
    hour: parseCronField(parts[1], 0, 23),
    dayOfMonth: parseCronField(parts[2], 1, 31),
    month: parseCronField(parts[3], 1, 12),
    dayOfWeek: parseCronField(parts[4], 0, 6),
    dayOfMonthWildcard: parts[2] === '*',
    dayOfWeekWildcard: parts[4] === '*',
  };
}

type ZonedDateParts = {
  minute: number;
  hour: number;
  dayOfMonth: number;
  month: number;
  dayOfWeek: number;
};

function validateTimezone(timezone: string): void {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(new Date());
  } catch {
    throw new Error(`Invalid IANA timezone: ${timezone}`);
  }
}

function zonedDateParts(date: Date, timezone: string): ZonedDateParts {
  validateTimezone(timezone);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour12: false,
    minute: '2-digit',
    hour: '2-digit',
    day: '2-digit',
    month: '2-digit',
    weekday: 'short',
  }).formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? '';
  const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(get('weekday'));
  return {
    minute: Number.parseInt(get('minute'), 10),
    hour: Number.parseInt(get('hour'), 10) % 24,
    dayOfMonth: Number.parseInt(get('day'), 10),
    month: Number.parseInt(get('month'), 10),
    dayOfWeek: weekday,
  };
}

export function matchesCron(cron: CronFields, date: Date, timezone = hostTimezone()): boolean {
  const { minute, hour, dayOfMonth, month, dayOfWeek } = zonedDateParts(date, timezone);
  const domMatches = cron.dayOfMonth.includes(dayOfMonth);
  const dowMatches = cron.dayOfWeek.includes(dayOfWeek);
  const dayMatches =
    cron.dayOfMonthWildcard && cron.dayOfWeekWildcard
      ? true
      : cron.dayOfMonthWildcard
        ? dowMatches
        : cron.dayOfWeekWildcard
          ? domMatches
          : domMatches || dowMatches;

  return (
    cron.minute.includes(minute) &&
    cron.hour.includes(hour) &&
    cron.month.includes(month) &&
    dayMatches
  );
}

export function getNextRun(cron: string, from: Date = new Date(), timezone = hostTimezone()): Date {
  const parsed = parseCron(cron);
  validateTimezone(timezone);
  const next = new Date(from);
  next.setSeconds(0, 0);

  // Advance by 1 minute at a time until we find a match (max 1 year)
  for (let i = 0; i < 366 * 24 * 60; i++) {
    next.setMinutes(next.getMinutes() + 1);
    if (matchesCron(parsed, next, timezone)) {
      return next;
    }
  }

  throw new Error(`Cannot find next run for cron: ${cron}`);
}

// ── Task Execution ─────────────────────────────────────────────────────────────

const PROJECT_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

export interface TaskResult extends Record<string, unknown> {
  taskId: string;
  success: boolean;
  status?: Extract<SchedulerTaskStatus, 'success' | 'failed' | 'skipped' | 'timed_out'>;
  output: string;
  error?: string;
  durationMs: number;
  truncated?: boolean;
  originalLength?: number;
}

export type SchedulerExecutionTarget = 'local' | 'workers';

export type SchedulerRuntimeOptions = {
  workPollingService?: WorkPollingService;
  executionTarget?: SchedulerExecutionTarget;
};

export type SchedulerRuntimeStatus = {
  configuredTarget: SchedulerExecutionTarget;
  effectiveTarget: SchedulerExecutionTarget;
  running: boolean;
  intervalMs: number;
  workerLaneReady: boolean | null;
  fallbackReason?: string;
  tasks: {
    total: number;
    enabled: number;
    overdue: number;
  };
};

const TASK_OUTPUT_LIMIT_BYTES = 256 * 1024;
const TASK_LOG_ROTATE_BYTES = 5 * 1024 * 1024;
const TASK_LOG_ROTATIONS = 5;

function rotateTaskLog(logFile: string): void {
  if (!existsSync(logFile) || statSync(logFile).size < TASK_LOG_ROTATE_BYTES) return;
  const oldest = `${logFile}.${TASK_LOG_ROTATIONS}`;
  if (existsSync(oldest)) unlinkSync(oldest);
  for (let index = TASK_LOG_ROTATIONS - 1; index >= 1; index -= 1) {
    const source = `${logFile}.${index}`;
    if (existsSync(source)) renameSync(source, `${logFile}.${index + 1}`);
  }
  renameSync(logFile, `${logFile}.1`);
}

function logToFile(taskId: string, content: string): void {
  const logDir = getSchedulerLogsDir();
  mkdirSync(logDir, { recursive: true });
  const logFile = join(logDir, `${taskId}.log`);
  rotateTaskLog(logFile);
  const timestamp = new Date().toISOString();
  writeFileSync(logFile, `[${timestamp}] ${content}\n`, { flag: 'a' });
}

function capOutput(value: string): {
  output: string;
  truncated: boolean;
  originalLength: number;
} {
  const buffer = Buffer.from(value);
  if (buffer.byteLength <= TASK_OUTPUT_LIMIT_BYTES) {
    return { output: value, truncated: false, originalLength: buffer.byteLength };
  }
  return {
    output: `${buffer.subarray(0, TASK_OUTPUT_LIMIT_BYTES).toString()}\n[output truncated]`,
    truncated: true,
    originalLength: buffer.byteLength,
  };
}

function resolveSchedulerProjectRoot(): string {
  try {
    return resolveRuntimeRoot(process.cwd());
  } catch {
    return path.resolve(PROJECT_ROOT);
  }
}

function resolveSchedulerDeployProfile(runtimeRoot: string): DeployProfile {
  try {
    const service = getUserServiceStatus(runtimeRoot, process.env);
    return service.available && service.installed ? 'local-service' : 'build-only';
  } catch {
    return 'build-only';
  }
}

export async function executeCommand(
  command: SchedulerCommand,
  options?: { taskId?: string },
): Promise<TaskResult> {
  const start = Date.now();
  const taskId = options?.taskId?.trim() || `task-${Date.now()}`;

  try {
    switch (command.type) {
      case 'git-pull-build': {
        const projectRoot = resolveSchedulerProjectRoot();
        logToFile(taskId, 'Starting git-pull-and-build');

        // `--ff-only` means: succeed if local main is fast-forwardable
        // from origin/main, fail clearly otherwise. Without it, local
        // commits or merge state on main produce "You have divergent
        // branches" and the whole task fails — a routine state on a
        // dev machine with feature work in flight (operator's
        // 2026-05-09 incident, see scheduler logs). For an automated
        // build pipeline we want explicit "no auto-merge / no auto-
        // rebase" semantics; if there are local commits the operator
        // should resolve them by hand. Mirrors `source-checkout.ts:408`.
        const pullResult = await runShell('git pull --ff-only origin main', projectRoot);
        if (!pullResult.success) {
          logToFile(taskId, `Git pull failed: ${pullResult.output}`);
          return {
            taskId,
            success: false,
            output: pullResult.output,
            durationMs: Date.now() - start,
          };
        }
        logToFile(taskId, `Git pull: ${pullResult.output}`);

        const profile = resolveSchedulerDeployProfile(projectRoot);
        const deployResult = await runDeployPipeline(
          {
            action: 'run',
            profile,
          },
          {
            rawEnv: process.env,
            runtimeRoot: projectRoot,
          },
        );
        if (!deployResult.success) {
          const rollbackLabel = deployResult.rollback?.attempted
            ? `; rollback=${deployResult.rollback.success ? 'restored' : 'failed'}`
            : '';
          logToFile(
            taskId,
            `Deploy failed (${profile}): ${deployResult.error ?? 'unknown error'}${rollbackLabel}`,
          );
          return {
            taskId,
            success: false,
            output: `Git pull OK, deploy failed: ${deployResult.error ?? 'unknown error'}${rollbackLabel}`,
            error: deployResult.error,
            durationMs: Date.now() - start,
          };
        }
        logToFile(
          taskId,
          `Deploy successful (${profile}): snapshot=${deployResult.snapshotId ?? 'none'} health=${deployResult.health?.healthStatus ?? 'unknown'}`,
        );

        return {
          taskId,
          success: true,
          output: `Git pull OK, deploy completed (${profile})`,
          durationMs: Date.now() - start,
        };
      }

      case 'shell': {
        const result = await runShell(command.script, resolveSchedulerProjectRoot());
        logToFile(taskId, result.output);
        return {
          taskId,
          success: result.success,
          status: result.timedOut ? 'timed_out' : result.success ? 'success' : 'failed',
          output: result.output,
          truncated: result.truncated,
          originalLength: result.originalLength,
          durationMs: Date.now() - start,
        };
      }

      case 'reflection': {
        logToFile(taskId, 'Running reflection');
        const summary = await runReflectionCycle({
          rawEnv: process.env,
          periods: [command.period ?? 'daily'],
          trigger: 'scheduler',
        });
        logToFile(
          taskId,
          `Reflection complete: ${summary.reflectionCount} reflection(s), ${summary.insightCount} insight(s)`,
        );
        return {
          taskId,
          success: true,
          output: `Reflection: ${summary.reflectionCount} reflection(s), ${summary.insightCount} insight(s)`,
          durationMs: Date.now() - start,
        };
      }

      case 'builtin': {
        const { executeBuiltinSchedulerJob } = await import('./scheduler-builtins.js');
        const result = await executeBuiltinSchedulerJob(command.job, process.env);
        logToFile(taskId, result.output);
        return {
          taskId,
          success: result.success,
          status: result.skipped ? 'skipped' : result.success ? 'success' : 'failed',
          output: result.output,
          error: result.error,
          durationMs: Date.now() - start,
        };
      }

      case 'http': {
        try {
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 30_000);
          const response = await fetch(command.url, {
            method: command.method ?? 'GET',
            body: command.body,
            headers: { 'Content-Type': 'application/json' },
            signal: controller.signal,
          });
          const rawText = await response.text();
          clearTimeout(timeout);
          const text = capOutput(rawText);
          logToFile(taskId, `HTTP ${response.status}: ${text.output}`);
          return {
            taskId,
            success: response.ok,
            status: response.ok ? 'success' : 'failed',
            output: `HTTP ${response.status}: ${text.output}`,
            truncated: text.truncated,
            originalLength: text.originalLength,
            durationMs: Date.now() - start,
          };
        } catch (err) {
          const msg = err instanceof Error ? err.message : 'Unknown error';
          const timedOut = err instanceof Error && err.name === 'AbortError';
          logToFile(taskId, `HTTP error: ${msg}`);
          return {
            taskId,
            success: false,
            status: timedOut ? 'timed_out' : 'failed',
            output: msg,
            error: msg,
            durationMs: Date.now() - start,
          };
        }
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    logToFile(taskId, `Error: ${msg}`);
    return { taskId, success: false, output: '', error: msg, durationMs: Date.now() - start };
  }
}

function runShell(
  script: string,
  cwd: string,
): Promise<{
  success: boolean;
  output: string;
  timedOut: boolean;
  truncated: boolean;
  originalLength: number;
}> {
  // Sprint 3.2: HOME hardcoded to '/home/memphis' broke any operator
  // running Memphis under a different user (snap install, fresh-install
  // CLI on macOS, container with non-`memphis` user). Honor process.env
  // HOME so the spawned shell sees the operator's actual $HOME — falls
  // back to '/home/memphis' only when HOME is somehow unset (which
  // shouldn't happen on POSIX, but the fallback keeps prior behavior
  // for the dev-machine case).
  const homeDir = HOME.read(process.env);
  return new Promise((resolve) => {
    // -lc instead of -c: makes bash a login shell so it sources
    // /etc/profile + ~/.profile + ~/.bashrc, which is how the
    // operator's PATH gets entries like ~/.npm-global/bin (where
    // `memphis` itself lives after npm install -g). Without this, a
    // task script of `memphis exec "..."` runs in a non-interactive
    // bash with the systemd-user-service PATH and fails as
    // `memphis: command not found` — exactly the regression Wodzu's
    // 2026-04-30 cron smoke caught (task `morning-raport-wodzu` had
    // been failing daily since 2026-04-26 with that error).
    //
    // Re-assert cwd after profile sourcing (Codex P1 round 1):
    // ~/.bash_profile or ~/.profile commonly contain an unconditional
    // `cd ~/somewhere`. Without re-cd, `git-pull-build` would run
    // outside resolveSchedulerProjectRoot() and fail as "not a git
    // repository". Pass cwd + script as positional args so the inner
    // bash sees them safely without any shell quoting in the wrapper.
    //
    // Then clear $@ before eval (Codex P2 round 2): leaving the
    // wrapper's positional args populated would leak into the eval'd
    // task script, so a user script that checks `[ $# -eq 0 ]` or
    // branches on `$1` would behave differently than under plain
    // `bash -c script`. The wrapper captures the script into a local
    // variable, runs `set --` to clear $@, then eval's — preserving
    // the prior `bash -c` semantic of "task sees no positional args".
    const wrapper = 'cd "$1" || exit 1; __memphis_script="$2"; set --; eval "$__memphis_script"';
    // Set $0 to 'bash' (Codex P2 round 3): the prior literal
    // 'memphis-scheduler' would break operator scripts that re-invoke
    // `$0` (e.g. self-reexec, shell detection). Plain `bash -c script`
    // sets $0 to '/bin/bash' or 'bash'; matching that keeps the prior
    // semantics.
    const shell = spawn('/bin/bash', ['-lc', wrapper, 'bash', cwd, script], {
      cwd,
      env: { ...process.env, HOME: homeDir },
      detached: process.platform !== 'win32',
    });

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutLength = 0;
    let stderrLength = 0;
    let settled = false;

    const settle = (success: boolean, timedOut = false, error?: string) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeoutId);
      const stdoutText = Buffer.concat(stdout).toString();
      const stderrText = Buffer.concat(stderr).toString();
      const combined = error ?? stdoutText + (stderrText ? `\nSTDERR: ${stderrText}` : '');
      const capped = capOutput(combined);
      resolve({
        success,
        timedOut,
        output: capped.output,
        truncated:
          capped.truncated ||
          stdoutLength > TASK_OUTPUT_LIMIT_BYTES ||
          stderrLength > TASK_OUTPUT_LIMIT_BYTES,
        originalLength: stdoutLength + stderrLength,
      });
    };

    shell.stdout?.on('data', (data) => {
      const chunk = Buffer.from(data);
      stdoutLength += chunk.byteLength;
      const retained = Buffer.concat(stdout).byteLength;
      if (retained < TASK_OUTPUT_LIMIT_BYTES) {
        stdout.push(chunk.subarray(0, TASK_OUTPUT_LIMIT_BYTES - retained));
      }
    });
    shell.stderr?.on('data', (data) => {
      const chunk = Buffer.from(data);
      stderrLength += chunk.byteLength;
      const retained = Buffer.concat(stderr).byteLength;
      if (retained < TASK_OUTPUT_LIMIT_BYTES) {
        stderr.push(chunk.subarray(0, TASK_OUTPUT_LIMIT_BYTES - retained));
      }
    });

    shell.on('close', (code) => {
      settle(code === 0);
    });

    shell.on('error', (err) => {
      settle(false, false, err.message);
    });

    // Timeout after 5 minutes
    const timeoutId = setTimeout(
      () => {
        if (process.platform !== 'win32' && shell.pid) {
          try {
            process.kill(-shell.pid, 'SIGTERM');
          } catch {
            shell.kill('SIGTERM');
          }
          setTimeout(() => {
            if (!settled) {
              try {
                process.kill(-shell.pid!, 'SIGKILL');
              } catch {
                shell.kill('SIGKILL');
              }
            }
          }, 5_000).unref();
        } else {
          shell.kill('SIGTERM');
        }
        settle(false, true, 'Timeout after 5 minutes');
      },
      5 * 60 * 1000,
    );
  });
}

export function beginScheduledTaskRun(
  taskId: string,
  now: Date = new Date(),
): { task: ScheduledTask; nextRun: string } | null {
  try {
    return withTaskStoreLock(() => {
      const tasks = loadTasks();
      const idx = tasks.findIndex((task) => task.id === taskId);
      if (idx === -1) return null;
      const task = tasks[idx];
      const leaseExpires = task.leaseExpiresAt ? Date.parse(task.leaseExpiresAt) : 0;
      if (task.lastStatus === 'running' && leaseExpires > now.getTime()) return null;

      const scheduledFor = task.nextRun ?? now.toISOString();
      if (task.lastScheduledFor === scheduledFor && task.lastStatus === 'success') return null;

      const nextRun = getNextRun(task.cron, now, task.timezone).toISOString();
      task.lastRun = now.toISOString();
      task.startedAt = now.toISOString();
      task.finishedAt = null;
      task.lastError = null;
      task.lastStatus = 'running';
      task.lastScheduledFor = scheduledFor;
      task.leaseOwner = `${process.pid}`;
      task.leaseExpiresAt = new Date(now.getTime() + 61 * 60 * 1000).toISOString();
      task.nextRun = nextRun;
      saveTasks(tasks);
      return { task: { ...task }, nextRun };
    });
  } catch (error) {
    if (error instanceof Error && error.message.includes('task store is locked')) return null;
    throw error;
  }
}

export async function completeScheduledTaskRun(
  taskId: string,
  taskName: string,
  nextRun: string,
  result: TaskResult,
): Promise<void> {
  withTaskStoreLock(() => {
    const tasks = loadTasks();
    const idx = tasks.findIndex((task) => task.id === taskId);
    if (idx !== -1) {
      tasks[idx].lastStatus = result.status ?? (result.success ? 'success' : 'failed');
      tasks[idx].lastError = result.error ?? (result.success ? null : result.output.slice(0, 500));
      tasks[idx].finishedAt = new Date().toISOString();
      tasks[idx].leaseOwner = null;
      tasks[idx].leaseExpiresAt = null;
      tasks[idx].runCount = (tasks[idx].runCount || 0) + 1;
      tasks[idx].nextRun = nextRun;
      saveTasks(tasks);
    }
  });

  try {
    await appendBlock('system', {
      type: 'system_event',
      kind: 'scheduler_task',
      source: 'memphis-scheduler',
      schemaVersion: 1,
      content: `Scheduled task "${taskName}" (${taskId}): ${result.success ? 'SUCCESS' : 'FAILED'}`,
      tags: ['scheduler', 'task', result.success ? 'success' : 'failed'],
      metadata: {
        taskId,
        taskName,
        success: result.success,
        output: result.output.slice(0, 500),
        error: result.error,
        durationMs: result.durationMs,
        nextRun,
      },
    });
  } catch {
    // Non-fatal
  }
}

export function resolveConfiguredSchedulerExecutionTarget(
  rawEnv: NodeJS.ProcessEnv = process.env,
): SchedulerExecutionTarget {
  return rawEnv.MEMPHIS_SCHEDULER_EXECUTION_TARGET?.trim().toLowerCase() === 'workers'
    ? 'workers'
    : 'local';
}

function buildTaskSnapshot(nowMs = Date.now()): SchedulerRuntimeStatus['tasks'] {
  const tasks = loadTasks();
  return {
    total: tasks.length,
    enabled: tasks.filter((task) => task.enabled).length,
    overdue: tasks.filter((task) => {
      if (!task.enabled || !task.nextRun) {
        return false;
      }
      const nextRunMs = Date.parse(task.nextRun);
      return Number.isFinite(nextRunMs) && nextRunMs <= nowMs;
    }).length,
  };
}

// ── Scheduler Core ─────────────────────────────────────────────────────────────

export class MemphisScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private tickInFlight = false;
  private readonly intervalMs: number;
  private runtime: SchedulerRuntimeOptions;

  constructor(intervalMs = 30_000, runtime: SchedulerRuntimeOptions = {}) {
    this.intervalMs = intervalMs;
    this.runtime = { ...runtime };
  }

  public configure(runtime: SchedulerRuntimeOptions = {}): void {
    this.runtime = { ...this.runtime, ...runtime };
  }

  public snapshot(nowMs = Date.now()): SchedulerRuntimeStatus {
    const configuredTarget = this.runtime.executionTarget ?? 'local';
    const workerLaneReady = this.runtime.workPollingService
      ? this.runtime.workPollingService.snapshot().tokenReady
      : null;
    const effectiveTarget = configuredTarget === 'workers' && workerLaneReady ? 'workers' : 'local';

    return {
      configuredTarget,
      effectiveTarget,
      running: this.timer !== null,
      intervalMs: this.intervalMs,
      workerLaneReady,
      fallbackReason:
        configuredTarget === 'workers' && effectiveTarget !== 'workers'
          ? workerLaneReady === false
            ? 'worker session tokens are not ready; using local execution'
            : 'worker runtime is not attached; using local execution'
          : undefined,
      tasks: buildTaskSnapshot(nowMs),
    };
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    if (typeof this.timer === 'object' && 'unref' in this.timer) {
      this.timer.unref();
    }
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async tick(): Promise<void> {
    if (this.tickInFlight) return;
    this.tickInFlight = true;
    try {
      const tasks = loadTasks().filter((t) => t.enabled);
      const now = new Date();
      for (const task of tasks) {
        if (!task.nextRun) {
          task.nextRun = getNextRun(task.cron, now, task.timezone).toISOString();
        }
        const leaseExpired =
          task.lastStatus === 'running' &&
          task.leaseExpiresAt !== null &&
          Date.parse(task.leaseExpiresAt) <= now.getTime();
        if (now >= new Date(task.nextRun) || leaseExpired) {
          await this.runTask(task);
        }
      }
    } finally {
      this.tickInFlight = false;
    }
  }

  private async runTask(task: ScheduledTask): Promise<void> {
    const prepared = beginScheduledTaskRun(task.id);
    if (!prepared) return;

    const target = this.resolveExecutionTarget();
    if (target === 'workers') {
      const queued = this.enqueueTaskForWorkers(prepared.task, prepared.nextRun);
      if (queued) {
        return;
      }
    }

    const result = await executeCommand(prepared.task.command, { taskId: prepared.task.id });
    await completeScheduledTaskRun(prepared.task.id, prepared.task.name, prepared.nextRun, result);
  }

  private resolveExecutionTarget(): SchedulerExecutionTarget {
    const requested = this.runtime.executionTarget ?? 'local';
    if (requested !== 'workers') {
      return 'local';
    }

    const snapshot = this.runtime.workPollingService?.snapshot();
    return snapshot?.tokenReady ? 'workers' : 'local';
  }

  private enqueueTaskForWorkers(task: ScheduledTask, nextRun: string): boolean {
    if (!this.runtime.workPollingService) {
      return false;
    }

    try {
      this.runtime.workPollingService.enqueueWork({
        type: 'scheduler.execute',
        actorId: 'system:scheduler',
        conversationId: 'system::scheduler',
        capabilityScope: [SCHEDULER_EXECUTE_WORK_CAPABILITY],
        payload: {
          taskId: task.id,
          taskName: task.name,
          command: task.command,
          nextRun,
          triggeredAt: task.lastRun ?? new Date().toISOString(),
          source: 'scheduler.tick',
        },
      });
      return true;
    } catch {
      return false;
    }
  }

  // ── Task Management ────────────────────────────────────────────────────────

  addTask(
    task: Pick<ScheduledTask, 'id' | 'cron' | 'name' | 'command' | 'enabled'> &
      Partial<Pick<ScheduledTask, 'timezone'>>,
  ): ScheduledTask {
    return withTaskStoreLock(() => {
      const tasks = loadTasks();
      if (tasks.some((current) => current.id === task.id)) {
        throw new Error(`Scheduled task already exists: ${task.id}`);
      }
      const timezone = task.timezone ?? hostTimezone();
      validateTimezone(timezone);
      const newTask: ScheduledTask = {
        schemaVersion: 2,
        ...task,
        timezone,
        lastRun: null,
        nextRun: getNextRun(task.cron, new Date(), timezone).toISOString(),
        lastStatus: null,
        startedAt: null,
        finishedAt: null,
        lastError: null,
        lastScheduledFor: null,
        leaseOwner: null,
        leaseExpiresAt: null,
        createdAt: new Date().toISOString(),
        runCount: 0,
      };
      tasks.push(newTask);
      saveTasks(tasks);
      return newTask;
    });
  }

  removeTask(id: string): boolean {
    return withTaskStoreLock(() => {
      const tasks = loadTasks();
      const idx = tasks.findIndex((t) => t.id === id);
      if (idx === -1) return false;
      tasks.splice(idx, 1);
      saveTasks(tasks);
      return true;
    });
  }

  enableTask(id: string): boolean {
    return withTaskStoreLock(() => {
      const tasks = loadTasks();
      const idx = tasks.findIndex((t) => t.id === id);
      if (idx === -1) return false;
      tasks[idx].enabled = true;
      tasks[idx].nextRun = getNextRun(
        tasks[idx].cron,
        new Date(),
        tasks[idx].timezone,
      ).toISOString();
      saveTasks(tasks);
      return true;
    });
  }

  disableTask(id: string): boolean {
    return withTaskStoreLock(() => {
      const tasks = loadTasks();
      const idx = tasks.findIndex((t) => t.id === id);
      if (idx === -1) return false;
      tasks[idx].enabled = false;
      saveTasks(tasks);
      return true;
    });
  }

  listTasks(): ScheduledTask[] {
    return loadTasks();
  }

  getTask(id: string): ScheduledTask | undefined {
    return loadTasks().find((t) => t.id === id);
  }
}

// Singleton instance
let schedulerInstance: MemphisScheduler | null = null;

export function getScheduler(runtime: SchedulerRuntimeOptions = {}): MemphisScheduler {
  if (!schedulerInstance) {
    schedulerInstance = new MemphisScheduler(30_000, runtime);
  } else if (Object.keys(runtime).length > 0) {
    schedulerInstance.configure(runtime);
  }
  return schedulerInstance;
}

export function startScheduler(runtime: SchedulerRuntimeOptions = {}): void {
  getScheduler(runtime).start();
}

export function getSchedulerRuntimeStatus(
  rawEnv: NodeJS.ProcessEnv = process.env,
  options?: {
    workPollingTokenReady?: boolean | null;
    nowMs?: number;
  },
): SchedulerRuntimeStatus {
  if (schedulerInstance) {
    return schedulerInstance.snapshot(options?.nowMs);
  }

  const configuredTarget = resolveConfiguredSchedulerExecutionTarget(rawEnv);
  const workerLaneReady = options?.workPollingTokenReady ?? null;
  const effectiveTarget = configuredTarget === 'workers' && workerLaneReady ? 'workers' : 'local';

  return {
    configuredTarget,
    effectiveTarget,
    running: false,
    intervalMs: 30_000,
    workerLaneReady,
    fallbackReason:
      configuredTarget === 'workers' && effectiveTarget !== 'workers'
        ? workerLaneReady === false
          ? 'worker session tokens are not ready; using local execution'
          : 'scheduler runtime not initialized; using local execution'
        : undefined,
    tasks: buildTaskSnapshot(options?.nowMs),
  };
}

export function stopScheduler(): void {
  if (schedulerInstance) {
    schedulerInstance.stop();
    schedulerInstance = null;
  }
}
