/**
 * memphis_cron — create, list, and manage scheduled tasks via the built-in scheduler.
 *
 * Tier 2: can execute shell commands on schedule.
 * Tasks persist in ~/.memphis/scheduler/tasks.json and survive restarts.
 *
 * Supported task types:
 *   - shell: run a shell script on schedule
 *   - reflection: trigger the reflection engine
 *   - git-pull-build: pull latest code, run deploy pipeline, and verify health
 *   - http: make an HTTP request on schedule
 */

import {
  getScheduler,
  type ScheduledTask,
  type SchedulerCommand,
} from '../../infra/runtime/scheduler.js';

export type MemphisCronAction = 'list' | 'add' | 'remove' | 'enable' | 'disable';

export type MemphisCronInput = {
  action: MemphisCronAction;
  /** Required for add: cron expression (e.g. "0 * * * *" = every hour) */
  cron?: string;
  /** Required for add: human-readable name */
  name?: string;
  /** Required for add: task type */
  taskType?: 'shell' | 'reflection' | 'git-pull-build' | 'http';
  /** Required for shell type: the script to run */
  script?: string;
  /** Required for http type: URL to call */
  url?: string;
  /** Optional for http type: HTTP method (default GET) */
  method?: string;
  /** Required for remove/enable/disable: task ID */
  taskId?: string;
};

export type MemphisCronOutput = {
  success: boolean;
  tasks?: Array<{
    id: string;
    name: string;
    cron: string;
    enabled: boolean;
    lastStatus: string | null;
    runCount: number;
  }>;
  task?: { id: string; name: string };
  error?: string;
};

function formatTask(t: ScheduledTask) {
  return {
    id: t.id,
    name: t.name,
    cron: t.cron,
    enabled: t.enabled,
    lastStatus: t.lastStatus,
    runCount: t.runCount,
  };
}

export function runMemphisCron(input: MemphisCronInput): MemphisCronOutput {
  const scheduler = getScheduler();

  switch (input.action) {
    case 'list': {
      const tasks = scheduler.listTasks();
      return { success: true, tasks: tasks.map(formatTask) };
    }

    case 'add': {
      if (!input.cron || !input.name || !input.taskType) {
        return { success: false, error: 'add requires: cron, name, taskType' };
      }

      let command: SchedulerCommand;
      switch (input.taskType) {
        case 'shell':
          if (!input.script) return { success: false, error: 'shell type requires script' };
          command = { type: 'shell', script: input.script };
          break;
        case 'reflection':
          command = { type: 'reflection' };
          break;
        case 'git-pull-build':
          command = { type: 'git-pull-build' };
          break;
        case 'http':
          if (!input.url) return { success: false, error: 'http type requires url' };
          command = { type: 'http', url: input.url, method: input.method };
          break;
        default:
          return { success: false, error: `unknown taskType: ${input.taskType}` };
      }

      const id = `${input.taskType}-${Date.now().toString(36)}`;
      const task = scheduler.addTask({ id, cron: input.cron, name: input.name, command, enabled: true });
      return { success: true, task: { id: task.id, name: task.name } };
    }

    case 'remove': {
      if (!input.taskId) return { success: false, error: 'remove requires taskId' };
      const removed = scheduler.removeTask(input.taskId);
      return { success: removed, error: removed ? undefined : `task '${input.taskId}' not found` };
    }

    case 'enable': {
      if (!input.taskId) return { success: false, error: 'enable requires taskId' };
      const enabled = scheduler.enableTask(input.taskId);
      return { success: enabled, error: enabled ? undefined : `task '${input.taskId}' not found` };
    }

    case 'disable': {
      if (!input.taskId) return { success: false, error: 'disable requires taskId' };
      const disabled = scheduler.disableTask(input.taskId);
      return { success: disabled, error: disabled ? undefined : `task '${input.taskId}' not found` };
    }

    default:
      return { success: false, error: `unknown action: ${input.action}. Use: list, add, remove, enable, disable` };
  }
}
