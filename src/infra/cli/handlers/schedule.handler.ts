import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { CommandHandler } from './command-handler.js';
import {
  getSchedulerDir,
  getSchedulerLogsDir,
  getSchedulerTasksPath,
  getScheduler,
  reconcileScheduledTasks,
  type ScheduledTask,
  type SchedulerCommand,
} from '../../runtime/scheduler.js';
import { buildScheduledTaskWorkItem } from '../../work/scheduler-work.js';
import type { CliContext } from '../context.js';
import { print } from '../utils/render.js';

export const scheduleCommandHandler: CommandHandler = {
  name: 'schedule',
  commands: ['schedule'],
  canHandle(context: CliContext): boolean {
    return context.args.command === 'schedule';
  },
  async handle(context: CliContext): Promise<boolean> {
    const subcommand = context.args.subcommand;

    if (!subcommand || subcommand === 'list') {
      return handleList(context);
    }
    if (subcommand === 'reconcile') {
      return handleReconcile(context);
    }

    // Phase 4.3 (autopilot 2026-05-08): close issue #278 — gate every
    // mutating subcommand. List + help stay open (read/docs). Plan stop
    // condition: schedule listing must NOT require auth so cron-friendly
    // observability scripts keep working.
    const mutatingSubs = new Set(['add', 'remove', 'enable', 'disable', 'run']);
    if (mutatingSubs.has(subcommand)) {
      const { requireOperatorAuth } = await import('../../auth/operator-gate.js');
      if (!(await requireOperatorAuth(undefined, process.env, context.args.operatorPassphrase))) {
        throw new Error('Operator authentication failed.');
      }
    }

    if (subcommand === 'add') {
      return handleAdd(context);
    }
    if (subcommand === 'remove') {
      return handleRemove(context);
    }
    if (subcommand === 'enable') {
      return handleEnable(context);
    }
    if (subcommand === 'disable') {
      return handleDisable(context);
    }
    if (subcommand === 'run') {
      return handleRun(context);
    }
    if (subcommand === 'help') {
      return handleHelp(context);
    }

    console.error(`Unknown subcommand: ${subcommand}`);
    console.error('Use "memphis schedule help" for usage information.');
    return true;
  },
};

function getSchedulerInstance() {
  return getScheduler();
}

function formatTask(task: ScheduledTask): string {
  const enabled = task.enabled ? '●' : '○';
  const lastRun = task.lastRun ? new Date(task.lastRun).toLocaleString() : 'never';
  const nextRun = task.nextRun ? new Date(task.nextRun).toLocaleString() : 'not scheduled';
  const status = task.lastStatus === 'success' ? '✓' : task.lastStatus === 'failed' ? '✗' : '-';
  return [
    `  ${enabled} ${task.name} [${task.id}]`,
    `    Cron: ${task.cron}`,
    `    Command: ${JSON.stringify(task.command)}`,
    `    Last: ${lastRun} ${status}`,
    `    Next: ${nextRun}`,
    `    Runs: ${task.runCount}`,
  ].join('\n');
}

async function handleList(context: CliContext): Promise<boolean> {
  const scheduler = getSchedulerInstance();
  const tasks = scheduler.listTasks();

  if (context.args.json) {
    console.log(JSON.stringify({ tasks }, null, 2));
    return true;
  }

  if (tasks.length === 0) {
    console.log('No scheduled tasks.');
    console.log('Use "memphis schedule help" to see how to add one.');
    return true;
  }

  console.log(`Scheduled Tasks (${tasks.length}):`);
  console.log('─'.repeat(60));

  const enabled = tasks.filter((t) => t.enabled);
  const disabled = tasks.filter((t) => !t.enabled);

  if (enabled.length > 0) {
    console.log('\nEnabled:');
    for (const task of enabled) {
      console.log(formatTask(task));
    }
  }

  if (disabled.length > 0) {
    console.log('\nDisabled:');
    for (const task of disabled) {
      console.log(formatTask(task));
    }
  }

  return true;
}

async function handleAdd(context: CliContext): Promise<boolean> {
  // Usage: memphis schedule add --cron "0 20 * * *" --name "Daily deploy" --type git-pull-build
  const cron = context.args.cronPattern; // Must be provided via --cron-pattern
  const name = context.args.name;
  const commandType = (context.args.taskType as string) || 'git-pull-build';
  const script = context.args.value; // for shell type
  const timezone = context.args.timezone;

  if (!cron || !name) {
    console.error(
      'Usage: memphis schedule add --cron "<cron>" --name "<name>" [--type git-pull-build|reflection|shell] [--value "<script>"]',
    );
    console.error('');
    console.error('Examples:');
    console.error(
      '  memphis schedule add --cron "0 20 * * *" --name "Daily deploy" --type git-pull-build',
    );
    console.error(
      '  memphis schedule add --cron "0 9 * * 1-5" --name "Weekday reflection" --type reflection',
    );
    console.error(
      '  memphis schedule add --cron "*/5 * * * *" --name "Every 5 min" --type shell --value "echo hi"',
    );
    return true;
  }

  const scheduler = getSchedulerInstance();

  // Build command
  let command: SchedulerCommand;
  const cmdType = String(commandType).toLowerCase();
  if (cmdType === 'git-pull-build') {
    command = { type: 'git-pull-build' };
  } else if (cmdType === 'reflection') {
    command = {
      type: 'reflection',
      period: script === 'weekly' ? 'weekly' : 'daily',
    };
  } else if (cmdType === 'builtin') {
    const jobs = new Set([
      'runtime-watch',
      'scheduled-backup',
      'doctor-diagnose',
      'operator-briefing',
      'attachment-retention',
    ]);
    if (!script || !jobs.has(script)) {
      throw new Error(`builtin schedule requires --value <job>; jobs: ${[...jobs].join(', ')}`);
    }
    command = {
      type: 'builtin',
      job: script as Extract<SchedulerCommand, { type: 'builtin' }>['job'],
    };
  } else if (cmdType === 'shell') {
    command = { type: 'shell', script: script || 'echo "no script"' };
  } else if (cmdType === 'http') {
    command = { type: 'http', url: script || 'http://example.com' };
  } else {
    console.error(`Unknown command type: ${commandType}`);
    console.error('Types: git-pull-build, reflection, shell, http');
    return true;
  }

  const id = `task-${Date.now()}`;
  const task = scheduler.addTask({
    id,
    cron,
    name,
    command,
    enabled: true,
    timezone,
  });

  console.log(`Task added: ${task.id}`);
  console.log(`  Name: ${task.name}`);
  console.log(`  Cron: ${task.cron}`);
  console.log(`  Next run: ${new Date(task.nextRun!).toLocaleString()}`);

  return true;
}

async function handleReconcile(context: CliContext): Promise<boolean> {
  const apply = context.args.apply === true && context.args.dryRun !== true;
  if (apply) {
    const { requireOperatorAuth } = await import('../../auth/operator-gate.js');
    if (!(await requireOperatorAuth(undefined, process.env, context.args.operatorPassphrase))) {
      throw new Error('Operator authentication failed.');
    }
  }
  let backupDir: string | undefined;
  if (apply) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    backupDir = join(getSchedulerDir(), 'migration-backups', stamp);
    mkdirSync(backupDir, { recursive: true, mode: 0o700 });
    const tasksPath = getSchedulerTasksPath();
    if (existsSync(tasksPath)) copyFileSync(tasksPath, join(backupDir, 'tasks.json'));
    const crontab = readCrontab();
    writeFileSync(join(backupDir, 'crontab.txt'), crontab, { mode: 0o600 });
    const logsDir = getSchedulerLogsDir();
    if (existsSync(logsDir)) {
      renameSync(logsDir, join(backupDir, 'logs'));
    }
  }
  const result = reconcileScheduledTasks({ apply });
  if (apply) removeLegacyMemphisCrontab();
  const payload = { ...result, applied: apply };
  if (backupDir) Object.assign(payload, { backupDir });
  if (context.args.json) {
    console.log(JSON.stringify(payload, null, 2));
  } else {
    console.log(`Scheduler reconcile ${apply ? 'applied' : 'dry-run'}:`);
    console.log(`  add: ${result.added.join(', ') || 'none'}`);
    console.log(`  update: ${result.updated.join(', ') || 'none'}`);
    console.log(`  remove legacy: ${result.removed.join(', ') || 'none'}`);
    console.log(`  preserve custom: ${result.preserved.join(', ') || 'none'}`);
    if (!apply && result.changed) {
      console.log('Run again with --apply after reviewing this diff.');
    }
  }
  return true;
}

function readCrontab(): string {
  try {
    return execFileSync('crontab', ['-l'], { encoding: 'utf8' });
  } catch {
    return '';
  }
}

function removeLegacyMemphisCrontab(): void {
  const current = readCrontab();
  const marker = '# memphis: daily-9am-briefing';
  const kept = current
    .split(/\r?\n/)
    .filter((line) => !line.includes(marker))
    .filter((line, index, lines) => line.length > 0 || index < lines.length - 1)
    .join('\n');
  if (kept === current.replace(/\n$/, '')) return;
  const input = kept.length > 0 ? `${kept}\n` : '';
  execFileSync('crontab', ['-'], { input, encoding: 'utf8' });
}

async function handleRemove(context: CliContext): Promise<boolean> {
  const taskId = context.args.id || context.args.target;

  if (!taskId) {
    console.error('Usage: memphis schedule remove --id <task-id>');
    return true;
  }

  const scheduler = getSchedulerInstance();
  const removed = scheduler.removeTask(taskId);

  if (removed) {
    console.log(`Task removed: ${taskId}`);
  } else {
    console.error(`Task not found: ${taskId}`);
  }

  return true;
}

async function handleEnable(context: CliContext): Promise<boolean> {
  const taskId = context.args.id || context.args.target;

  if (!taskId) {
    console.error('Usage: memphis schedule enable --id <task-id>');
    return true;
  }

  const scheduler = getSchedulerInstance();
  const enabled = scheduler.enableTask(taskId);

  if (enabled) {
    const task = scheduler.getTask(taskId);
    console.log(`Task enabled: ${taskId}`);
    console.log(
      `  Next run: ${task?.nextRun ? new Date(task.nextRun).toLocaleString() : 'unknown'}`,
    );
  } else {
    console.error(`Task not found: ${taskId}`);
  }

  return true;
}

async function handleDisable(context: CliContext): Promise<boolean> {
  const taskId = context.args.id || context.args.target;

  if (!taskId) {
    console.error('Usage: memphis schedule disable --id <task-id>');
    return true;
  }

  const scheduler = getSchedulerInstance();
  const disabled = scheduler.disableTask(taskId);

  if (disabled) {
    console.log(`Task disabled: ${taskId}`);
  } else {
    console.error(`Task not found: ${taskId}`);
  }

  return true;
}

async function handleRun(context: CliContext): Promise<boolean> {
  const taskId = context.args.id || context.args.target;

  if (!taskId) {
    console.error('Usage: memphis schedule run --id <task-id>');
    return true;
  }

  const scheduler = getSchedulerInstance();
  const task = scheduler.getTask(taskId);

  if (!task) {
    console.error(`Task not found: ${taskId}`);
    return true;
  }

  if (context.args.runtime) {
    const container = context.getContainer();
    const snapshot = container.workPollingService.snapshot();
    if (!snapshot.tokenReady) {
      throw new Error(
        'worker session tokens are not ready; set MEMPHIS_SESSION_TOKEN_SECRET first',
      );
    }

    const dispatched = buildScheduledTaskWorkItem(task, {
      nextRun: task.nextRun ?? new Date().toISOString(),
      source: 'cli.schedule.run',
    });
    const work = container.workPollingService.enqueueWork(dispatched.workInput);
    print(
      {
        ok: true,
        mode: 'schedule.run.runtime',
        taskId: task.id,
        workId: work.workId,
        status: work.status,
        capabilityScope: work.capabilityScope,
      },
      context.args.json,
    );
    return true;
  }

  console.log(`Running task: ${task.name}...`);

  // Import executeCommand from scheduler module
  const schedulerModule = await import('../../runtime/scheduler.js');
  const executeCommand = schedulerModule.executeCommand;
  const result = await executeCommand(task.command);

  if (result.success) {
    console.log(`✓ Task completed successfully (${result.durationMs}ms)`);
    if (result.output) console.log(result.output);
  } else {
    console.error(`✗ Task failed (${result.durationMs}ms)`);
    if (result.error) console.error(result.error);
    if (result.output) console.error(result.output);
  }

  return true;
}

async function handleHelp(_context: CliContext): Promise<boolean> {
  console.log(`
Memphis Task Scheduler

Usage: memphis schedule <subcommand> [options]

Subcommands:
  list                      List all scheduled tasks
  add                       Create a new scheduled task
  remove                    Remove a task
  enable                    Enable a task
  disable                   Disable a task
  run                       Run a task immediately
  reconcile                 Preview/apply the canonical Memphis task set
  help                      Show this help

Options:
  --cron "<pattern>"        Cron expression (e.g. "0 20 * * *")
  --name "<name>"           Task name
  --type <type>             Task type: git-pull-build, reflection, builtin, shell, http
  --value "<value>"         Script, URL, reflection period, or builtin job
  --timezone "<IANA>"       Time zone (default: host time zone)
  --apply                   Apply reconcile (default is dry-run)
  --id <task-id>            Task ID for remove/enable/disable/run
  --runtime                 Enqueue "run" through the worker runtime instead of direct execution

Cron format: "min hour day month dow"
  * = any value
  */n = every n units
  n-m = range
  n,m = list

Examples:
  memphis schedule add --cron "0 20 * * *" --name "Daily deploy" --type git-pull-build
  memphis schedule add --cron "0 9 * * 1-5" --name "Weekday reflection" --type reflection
  memphis schedule add --cron "*/15 * * * *" --name "Every 15 min" --type shell --value "echo hi"
  memphis schedule reconcile --dry-run
  memphis schedule list
  memphis schedule enable --id task-1234567890
  memphis schedule disable --id task-1234567890
  memphis schedule run --id task-1234567890
  memphis schedule run --id task-1234567890 --runtime --json

Task types:
  git-pull-build  - Git pull, run deploy pipeline, verify health, rollback on failure
  reflection      - Run Memphis reflection engine
  builtin <job>   - Run a typed Memphis maintenance job
  shell <script>  - Run arbitrary shell command
  http <url>      - Make HTTP request

Files:
  Tasks stored in: ~/.memphis/config/scheduler/tasks.json
  Logs in: ~/.memphis/config/scheduler/logs/
`);
  return true;
}
