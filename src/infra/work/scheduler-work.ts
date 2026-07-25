import { z } from 'zod';

import { SCHEDULER_EXECUTE_WORK_CAPABILITY } from './work-capabilities.js';
import {
  completeScheduledTaskRun,
  executeCommand as executeSchedulerCommand,
  type ScheduledTask,
  type TaskResult,
} from '../runtime/scheduler.js';
import type { WorkItemRecord } from '../storage/sqlite/repositories/work-item-repository.js';

const schedulerCommandSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('git-pull-build') }),
  z.object({
    type: z.literal('shell'),
    script: z.string().trim().min(1),
  }),
  z.object({
    type: z.literal('reflection'),
    period: z.enum(['daily', 'weekly']).optional(),
  }),
  z.object({
    type: z.literal('builtin'),
    job: z.enum([
      'runtime-watch',
      'scheduled-backup',
      'doctor-diagnose',
      'operator-briefing',
      'attachment-retention',
    ]),
  }),
  z.object({
    type: z.literal('http'),
    url: z.string().trim().min(1),
    method: z.string().trim().min(1).optional(),
    body: z.string().optional(),
  }),
]);

const schedulerWorkPayloadSchema = z.object({
  taskId: z.string().trim().min(1),
  taskName: z.string().trim().min(1),
  command: schedulerCommandSchema,
  nextRun: z.string().trim().min(1),
  triggeredAt: z.string().trim().min(1),
  source: z.string().trim().min(1).optional(),
});

export type SchedulerWorkPayload = z.infer<typeof schedulerWorkPayloadSchema>;

function parseTaskResult(value: unknown): TaskResult | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  const raw = value as Record<string, unknown>;
  if (
    typeof raw.taskId !== 'string' ||
    typeof raw.success !== 'boolean' ||
    typeof raw.output !== 'string' ||
    typeof raw.durationMs !== 'number'
  ) {
    return null;
  }

  return {
    taskId: raw.taskId,
    success: raw.success,
    output: raw.output,
    error: typeof raw.error === 'string' ? raw.error : undefined,
    durationMs: raw.durationMs,
  };
}

export function buildScheduledTaskWorkItem(
  task: ScheduledTask,
  input: {
    nextRun: string;
    triggeredAt?: string;
    source?: string;
  },
): {
  workInput: {
    type: 'scheduler.execute';
    actorId: string;
    conversationId: string;
    capabilityScope: string[];
    payload: SchedulerWorkPayload;
  };
} {
  return {
    workInput: {
      type: 'scheduler.execute',
      actorId: 'system:scheduler',
      conversationId: 'system::scheduler',
      capabilityScope: [SCHEDULER_EXECUTE_WORK_CAPABILITY],
      payload: {
        taskId: task.id,
        taskName: task.name,
        command: task.command,
        nextRun: input.nextRun,
        triggeredAt: input.triggeredAt ?? new Date().toISOString(),
        source: input.source,
      },
    },
  };
}

export function parseScheduledTaskWorkPayload(value: unknown): SchedulerWorkPayload | null {
  const parsed = schedulerWorkPayloadSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function executeScheduledTaskWorkPayload(
  payload: SchedulerWorkPayload,
): Promise<TaskResult> {
  return executeSchedulerCommand(payload.command, { taskId: payload.taskId });
}

export async function finalizeCompletedScheduledTaskWork(work: WorkItemRecord): Promise<void> {
  if (work.type !== 'scheduler.execute' || !work.result) {
    return;
  }

  const payload = parseScheduledTaskWorkPayload(work.payload);
  const result = parseTaskResult(work.result);
  if (!payload || !result) {
    return;
  }

  await completeScheduledTaskRun(payload.taskId, payload.taskName, payload.nextRun, result);
}
