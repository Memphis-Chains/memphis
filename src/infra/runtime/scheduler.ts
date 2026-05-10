/**
 * Memphis Task Scheduler
 *
 * Built-in cron-like scheduler that allows Memphis to execute tasks
 * on a schedule without external cron/systemd timers.
 *
 * Tasks are stored in ~/.memphis/scheduler/tasks.json
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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path, { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runReflectionCycle } from './reflection-loop.js';
import { getUserServiceStatus, resolveRuntimeRoot } from './user-service.js';
import { HOME } from '../../config/env-registry.js';
import { getConfigPath } from '../../config/paths.js';
import { runDeployPipeline, type DeployProfile } from '../deploy/pipeline.js';
import { appendBlock } from '../storage/chain-adapter.js';
import { SCHEDULER_EXECUTE_WORK_CAPABILITY } from '../work/work-capabilities.js';
import type { WorkPollingService } from '../work/work-polling-service.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ScheduledTask {
  id: string;
  cron: string; // Standard cron: "min hour day month dow"
  name: string;
  command: SchedulerCommand;
  enabled: boolean;
  lastRun: string | null;
  nextRun: string | null;
  lastStatus: 'success' | 'failed' | null;
  createdAt: string;
  runCount: number;
}

export type SchedulerCommand =
  | { type: 'git-pull-build' }
  | { type: 'shell'; script: string }
  | { type: 'reflection' }
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

export function loadTasks(): ScheduledTask[] {
  const path = getSchedulerTasksPath();
  if (!existsSync(path)) return [];
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as ScheduledTask[];
  } catch {
    return [];
  }
}

export function saveTasks(tasks: ScheduledTask[]): void {
  mkdirSync(getSchedulerDir(), { recursive: true });
  writeFileSync(getSchedulerTasksPath(), JSON.stringify(tasks, null, 2), 'utf8');
}

// ── Cron Parsing ──────────────────────────────────────────────────────────────

interface CronFields {
  minute: number[];
  hour: number[];
  dayOfMonth: number[];
  month: number[];
  dayOfWeek: number[];
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

  return [...new Set(values)].sort((a, b) => a - b);
}

function parseCron(cron: string): CronFields {
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
  };
}

function matchesCron(cron: CronFields, date: Date): boolean {
  const minute = date.getMinutes();
  const hour = date.getHours();
  const dayOfMonth = date.getDate();
  const month = date.getMonth() + 1;
  const dayOfWeek = date.getDay();

  return (
    cron.minute.includes(minute) &&
    cron.hour.includes(hour) &&
    cron.dayOfMonth.includes(dayOfMonth) &&
    cron.month.includes(month) &&
    cron.dayOfWeek.includes(dayOfWeek)
  );
}

function getNextRun(cron: string, from: Date = new Date()): Date {
  const parsed = parseCron(cron);
  const next = new Date(from);
  next.setSeconds(0, 0);

  // Advance by 1 minute at a time until we find a match (max 1 year)
  for (let i = 0; i < 366 * 24 * 60; i++) {
    next.setMinutes(next.getMinutes() + 1);
    if (matchesCron(parsed, next)) {
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
  output: string;
  error?: string;
  durationMs: number;
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

function logToFile(taskId: string, content: string): void {
  const logDir = getSchedulerLogsDir();
  mkdirSync(logDir, { recursive: true });
  const logFile = join(logDir, `${taskId}.log`);
  const timestamp = new Date().toISOString();
  writeFileSync(logFile, `[${timestamp}] ${content}\n`, { flag: 'a' });
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
          output: result.output,
          durationMs: Date.now() - start,
        };
      }

      case 'reflection': {
        logToFile(taskId, 'Running reflection');
        const summary = await runReflectionCycle({
          rawEnv: process.env,
          periods: ['daily'],
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

      case 'http': {
        try {
          const response = await fetch(command.url, {
            method: command.method ?? 'GET',
            body: command.body,
            headers: { 'Content-Type': 'application/json' },
          });
          const text = await response.text();
          logToFile(taskId, `HTTP ${response.status}: ${text.slice(0, 500)}`);
          return {
            taskId,
            success: response.ok,
            output: `HTTP ${response.status}: ${text.slice(0, 200)}`,
            durationMs: Date.now() - start,
          };
        } catch (err) {
          const msg = err instanceof Error ? err.message : 'Unknown error';
          logToFile(taskId, `HTTP error: ${msg}`);
          return {
            taskId,
            success: false,
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

function runShell(script: string, cwd: string): Promise<{ success: boolean; output: string }> {
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
    });

    let stdout = '';
    let stderr = '';
    let settled = false;

    const settle = (result: { success: boolean; output: string }) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeoutId);
      resolve(result);
    };

    shell.stdout?.on('data', (data) => {
      stdout += data.toString();
    });
    shell.stderr?.on('data', (data) => {
      stderr += data.toString();
    });

    shell.on('close', (code) => {
      settle({
        success: code === 0,
        output: stdout + (stderr ? `\nSTDERR: ${stderr}` : ''),
      });
    });

    shell.on('error', (err) => {
      settle({ success: false, output: err.message });
    });

    // Timeout after 5 minutes
    const timeoutId = setTimeout(
      () => {
        shell.kill();
        settle({ success: false, output: 'Timeout after 5 minutes' });
      },
      5 * 60 * 1000,
    );
  });
}

export function beginScheduledTaskRun(
  taskId: string,
  now: Date = new Date(),
): { task: ScheduledTask; nextRun: string } | null {
  const tasks = loadTasks();
  const idx = tasks.findIndex((task) => task.id === taskId);
  if (idx === -1) return null;

  const nextRun = getNextRun(tasks[idx].cron, now).toISOString();
  tasks[idx].lastRun = now.toISOString();
  tasks[idx].nextRun = nextRun;
  saveTasks(tasks);
  return {
    task: tasks[idx],
    nextRun,
  };
}

export async function completeScheduledTaskRun(
  taskId: string,
  taskName: string,
  nextRun: string,
  result: TaskResult,
): Promise<void> {
  const tasks = loadTasks();
  const idx = tasks.findIndex((task) => task.id === taskId);
  if (idx !== -1) {
    tasks[idx].lastStatus = result.success ? 'success' : 'failed';
    tasks[idx].runCount = (tasks[idx].runCount || 0) + 1;
    tasks[idx].nextRun = nextRun;
    saveTasks(tasks);
  }

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
    const tasks = loadTasks().filter((t) => t.enabled);
    const now = new Date();

    for (const task of tasks) {
      if (!task.nextRun) {
        // Initialize nextRun for new tasks
        task.nextRun = getNextRun(task.cron).toISOString();
      }

      const nextRunDate = new Date(task.nextRun);
      if (now >= nextRunDate) {
        await this.runTask(task);
      }
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
    task: Omit<ScheduledTask, 'lastRun' | 'nextRun' | 'lastStatus' | 'createdAt' | 'runCount'>,
  ): ScheduledTask {
    const tasks = loadTasks();
    const newTask: ScheduledTask = {
      ...task,
      lastRun: null,
      nextRun: getNextRun(task.cron).toISOString(),
      lastStatus: null,
      createdAt: new Date().toISOString(),
      runCount: 0,
    };
    tasks.push(newTask);
    saveTasks(tasks);
    return newTask;
  }

  removeTask(id: string): boolean {
    const tasks = loadTasks();
    const idx = tasks.findIndex((t) => t.id === id);
    if (idx === -1) return false;
    tasks.splice(idx, 1);
    saveTasks(tasks);
    return true;
  }

  enableTask(id: string): boolean {
    const tasks = loadTasks();
    const idx = tasks.findIndex((t) => t.id === id);
    if (idx === -1) return false;
    tasks[idx].enabled = true;
    tasks[idx].nextRun = getNextRun(tasks[idx].cron).toISOString();
    saveTasks(tasks);
    return true;
  }

  disableTask(id: string): boolean {
    const tasks = loadTasks();
    const idx = tasks.findIndex((t) => t.id === id);
    if (idx === -1) return false;
    tasks[idx].enabled = false;
    saveTasks(tasks);
    return true;
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
