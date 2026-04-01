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

import { getConfigPath } from '../../config/paths.js';
import { appendBlock } from '../storage/chain-adapter.js';

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

const PROJECT_ROOT = path.resolve(join(getSchedulerDir(), '..', '..', '..'));

export interface TaskResult {
  taskId: string;
  success: boolean;
  output: string;
  error?: string;
  durationMs: number;
}

function logToFile(taskId: string, content: string): void {
  const logDir = getSchedulerLogsDir();
  mkdirSync(logDir, { recursive: true });
  const logFile = join(logDir, `${taskId}.log`);
  const timestamp = new Date().toISOString();
  writeFileSync(logFile, `[${timestamp}] ${content}\n`, { flag: 'a' });
}

export async function executeCommand(command: SchedulerCommand): Promise<TaskResult> {
  const start = Date.now();
  const taskId = `task-${Date.now()}`;

  try {
    switch (command.type) {
      case 'git-pull-build': {
        logToFile(taskId, 'Starting git-pull-and-build');

        // Git pull
        const pullResult = await runShell('git pull origin main', PROJECT_ROOT);
        if (!pullResult.success) {
          logToFile(taskId, `Git pull failed: ${pullResult.output}`);
          return { taskId, success: false, output: pullResult.output, durationMs: Date.now() - start };
        }
        logToFile(taskId, `Git pull: ${pullResult.output}`);

        // Build
        const buildResult = await runShell('npm run build', PROJECT_ROOT);
        if (!buildResult.success) {
          logToFile(taskId, `Build failed: ${buildResult.output}`);
          return { taskId, success: false, output: `Git pull OK, build failed: ${buildResult.output}`, durationMs: Date.now() - start };
        }
        logToFile(taskId, `Build successful`);

        // Restart memphis if running
        await runShell('systemctl --user restart memphis', '/tmp');
        logToFile(taskId, 'Memphis restarted');

        return { taskId, success: true, output: 'Git pull, build, and restart completed', durationMs: Date.now() - start };
      }

      case 'shell': {
        const result = await runShell(command.script, PROJECT_ROOT);
        logToFile(taskId, result.output);
        return { taskId, success: result.success, output: result.output, durationMs: Date.now() - start };
      }

      case 'reflection': {
        logToFile(taskId, 'Running reflection');
        // Trigger Memphis reflection engine
        const { ReflectionEngine } = await import('../../reflection/engine.js');
        const engine = new ReflectionEngine();
        const reflections = await engine.reflectDaily('scheduled', new Map());
        logToFile(taskId, `Reflection complete: ${reflections.length} reflections generated`);
        return { taskId, success: true, output: `Reflection: ${reflections.length} reflections`, durationMs: Date.now() - start };
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
          return { taskId, success: false, output: msg, error: msg, durationMs: Date.now() - start };
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
  return new Promise((resolve) => {
    const shell = spawn('/bin/bash', ['-c', script], {
      cwd,
      env: { ...process.env, HOME: '/home/memphis' },
    });

    let stdout = '';
    let stderr = '';

    shell.stdout?.on('data', (data) => { stdout += data.toString(); });
    shell.stderr?.on('data', (data) => { stderr += data.toString(); });

    shell.on('close', (code) => {
      resolve({
        success: code === 0,
        output: stdout + (stderr ? `\nSTDERR: ${stderr}` : ''),
      });
    });

    shell.on('error', (err) => {
      resolve({ success: false, output: err.message });
    });

    // Timeout after 5 minutes
    setTimeout(() => {
      shell.kill();
      resolve({ success: false, output: 'Timeout after 5 minutes' });
    }, 5 * 60 * 1000);
  });
}

// ── Scheduler Core ─────────────────────────────────────────────────────────────

export class MemphisScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly intervalMs: number;

  constructor(intervalMs = 30_000) { // 30 seconds default
    this.intervalMs = intervalMs;
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
    const now = new Date();
    const nextRun = getNextRun(task.cron, now);

    // Mark as running
    const tasks = loadTasks();
    const idx = tasks.findIndex((t) => t.id === task.id);
    if (idx === -1) return;

    tasks[idx].lastRun = now.toISOString();
    tasks[idx].nextRun = nextRun.toISOString();
    saveTasks(tasks);

    // Execute
    const result = await executeCommand(task.command);

    // Update status
    const tasks2 = loadTasks();
    const idx2 = tasks2.findIndex((t) => t.id === task.id);
    if (idx2 !== -1) {
      tasks2[idx2].lastStatus = result.success ? 'success' : 'failed';
      tasks2[idx2].runCount = (tasks2[idx2].runCount || 0) + 1;
      saveTasks(tasks2);
    }

    // Log to chain
    try {
      await appendBlock('system', {
        type: 'scheduler_task',
        source: 'memphis-scheduler',
        schemaVersion: 1,
        content: `Scheduled task "${task.name}" (${task.id}): ${result.success ? 'SUCCESS' : 'FAILED'}`,
        tags: ['scheduler', 'task', result.success ? 'success' : 'failed'],
        metadata: {
          taskId: task.id,
          taskName: task.name,
          success: result.success,
          output: result.output.slice(0, 500),
          error: result.error,
          durationMs: result.durationMs,
          nextRun: nextRun.toISOString(),
        },
      });
    } catch {
      // Non-fatal
    }
  }

  // ── Task Management ────────────────────────────────────────────────────────

  addTask(task: Omit<ScheduledTask, 'lastRun' | 'nextRun' | 'lastStatus' | 'createdAt' | 'runCount'>): ScheduledTask {
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

export function getScheduler(): MemphisScheduler {
  if (!schedulerInstance) {
    schedulerInstance = new MemphisScheduler();
  }
  return schedulerInstance;
}

export function startScheduler(): void {
  getScheduler().start();
}

export function stopScheduler(): void {
  if (schedulerInstance) {
    schedulerInstance.stop();
    schedulerInstance = null;
  }
}
