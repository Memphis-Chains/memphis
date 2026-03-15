import { randomUUID } from 'node:crypto';

import { TaskQueueWal } from './task-queue-wal.js';
import { AppError } from '../../core/errors.js';

export type TaskQueueMode = 'financial' | 'standard';
export type TaskQueueStatus = 'completed' | 'failed' | 'canceled';
export type TaskQueueResumePolicy = 'keep' | 'fail' | 'redispatch';

export interface TaskQueueServiceOptions {
  walPath: string;
  mode?: TaskQueueMode;
  maxPendingTasks?: number;
  maxWalBytes?: number;
  faultInject?: string;
  resumePolicy?: TaskQueueResumePolicy;
}

export interface QueueTaskInput {
  type: string;
  requestId?: string;
  metadata?: Record<string, unknown>;
  payload?: Record<string, unknown>;
}

export interface QueueTicket {
  taskId: string;
  enqueuedAt: string;
}

export interface TaskQueueSnapshot {
  mode: TaskQueueMode;
  resumePolicy: TaskQueueResumePolicy;
  maxPendingTasks: number;
  pendingTasks: number;
  recoveredPendingTasks: number;
  totalEnqueued: number;
  totalFinished: number;
  lastResume: TaskQueueResumeSummary | null;
}

export interface QueuePendingTask {
  taskId: string;
  enqueuedAt: string;
  task: QueueTaskInput;
}

export interface TaskQueueResumeResult {
  policy: TaskQueueResumePolicy;
  scanned: number;
  redispatched: number;
  failed: number;
  canceled: number;
  kept: number;
  errors: string[];
}

export interface TaskQueueResumeSummary extends TaskQueueResumeResult {
  completedAt: string;
}

type QueueEnvelope =
  | {
      op: 'enqueue';
      taskId: string;
      enqueuedAt: string;
      task: QueueTaskInput;
    }
  | {
      op: 'finish';
      taskId: string;
      status: TaskQueueStatus;
      finishedAt: string;
      metadata?: Record<string, unknown>;
    };

interface PendingTask {
  taskId: string;
  enqueuedAt: string;
  task: QueueTaskInput;
}

function parseEnvelope(raw: string): QueueEnvelope | null {
  try {
    const parsed = JSON.parse(raw) as Partial<QueueEnvelope>;
    if (!parsed || typeof parsed !== 'object' || typeof parsed.op !== 'string') {
      return null;
    }

    if (
      parsed.op === 'enqueue' &&
      typeof parsed.taskId === 'string' &&
      typeof parsed.enqueuedAt === 'string' &&
      parsed.task &&
      typeof parsed.task === 'object' &&
      typeof (parsed.task as QueueTaskInput).type === 'string'
    ) {
      return parsed as QueueEnvelope;
    }

    if (
      parsed.op === 'finish' &&
      typeof parsed.taskId === 'string' &&
      typeof parsed.finishedAt === 'string' &&
      (parsed.status === 'completed' || parsed.status === 'failed' || parsed.status === 'canceled')
    ) {
      return parsed as QueueEnvelope;
    }
  } catch {
    return null;
  }

  return null;
}

export class TaskQueueService {
  private readonly wal: TaskQueueWal;
  private readonly mode: TaskQueueMode;
  private readonly maxPendingTasks: number;
  private readonly defaultResumePolicy: TaskQueueResumePolicy;
  private readonly pending = new Map<string, PendingTask>();
  private readonly recoveredTaskIds = new Set<string>();
  private lastResume: TaskQueueResumeSummary | null = null;
  private totalEnqueued = 0;
  private totalFinished = 0;

  constructor(options: TaskQueueServiceOptions) {
    this.mode = options.mode ?? 'financial';
    this.maxPendingTasks = options.maxPendingTasks ?? 100;
    this.defaultResumePolicy = options.resumePolicy ?? 'keep';
    this.wal = new TaskQueueWal({
      walPath: options.walPath,
      mode: this.mode,
      maxWalBytes: options.maxWalBytes,
      faultInject: options.faultInject,
    });

    this.recover();
  }

  public enqueue(task: QueueTaskInput): QueueTicket {
    if (this.pending.size >= this.maxPendingTasks) {
      throw new AppError('OVERLOAD', 'task queue is full', 429, {
        pendingTasks: this.pending.size,
        maxPendingTasks: this.maxPendingTasks,
      });
    }

    const taskId = randomUUID();
    const enqueuedAt = new Date().toISOString();
    const envelope: QueueEnvelope = {
      op: 'enqueue',
      taskId,
      enqueuedAt,
      task,
    };

    this.wal.enqueue(envelope);
    this.pending.set(taskId, { taskId, enqueuedAt, task });
    this.totalEnqueued += 1;

    return { taskId, enqueuedAt };
  }

  public finish(
    taskId: string,
    status: TaskQueueStatus,
    metadata?: Record<string, unknown>,
  ): boolean {
    const pending = this.pending.get(taskId);
    if (!pending) return false;

    const envelope: QueueEnvelope = {
      op: 'finish',
      taskId,
      status,
      finishedAt: new Date().toISOString(),
      metadata,
    };
    this.wal.enqueue(envelope);
    this.pending.delete(taskId);
    this.recoveredTaskIds.delete(taskId);
    this.totalFinished += 1;
    return true;
  }

  public snapshot(): TaskQueueSnapshot {
    return {
      mode: this.mode,
      resumePolicy: this.defaultResumePolicy,
      maxPendingTasks: this.maxPendingTasks,
      pendingTasks: this.pending.size,
      recoveredPendingTasks: this.recoveredTaskIds.size,
      totalEnqueued: this.totalEnqueued,
      totalFinished: this.totalFinished,
      lastResume: this.lastResume
        ? { ...this.lastResume, errors: [...this.lastResume.errors] }
        : null,
    };
  }

  public listPending(): QueuePendingTask[] {
    return [...this.pending.values()]
      .map((task) => ({ ...task }))
      .sort((a, b) => {
        if (a.enqueuedAt === b.enqueuedAt) return a.taskId.localeCompare(b.taskId);
        return a.enqueuedAt.localeCompare(b.enqueuedAt);
      });
  }

  public async resumeRecoveredPending(input?: {
    policy?: TaskQueueResumePolicy;
    redispatch?: (
      task: QueuePendingTask,
    ) => Promise<TaskQueueStatus | void> | TaskQueueStatus | void;
  }): Promise<TaskQueueResumeResult> {
    const policy = input?.policy ?? this.defaultResumePolicy;
    const recovered = this.listPending().filter((task) => this.recoveredTaskIds.has(task.taskId));
    const out: TaskQueueResumeResult = {
      policy,
      scanned: recovered.length,
      redispatched: 0,
      failed: 0,
      canceled: 0,
      kept: 0,
      errors: [],
    };

    if (recovered.length === 0) return this.recordLastResume(out);

    if (policy === 'keep') {
      out.kept = recovered.length;
      this.recoveredTaskIds.clear();
      return this.recordLastResume(out);
    }

    if (policy === 'redispatch' && !input?.redispatch) {
      out.kept = recovered.length;
      out.errors.push('resume redispatch requested but no redispatch handler was provided');
      this.recoveredTaskIds.clear();
      return this.recordLastResume(out);
    }

    for (const task of recovered) {
      try {
        if (policy === 'fail') {
          this.finish(task.taskId, 'failed', {
            reason: 'resume_policy_fail',
            recoveredOnStartup: true,
          });
          out.failed += 1;
          continue;
        }

        const resumeStatus = normalizeResumeStatus(await input?.redispatch?.(task));
        this.finish(task.taskId, resumeStatus, {
          reason: 'resume_policy_redispatch',
          recoveredOnStartup: true,
        });
        if (resumeStatus === 'completed') {
          out.redispatched += 1;
        } else if (resumeStatus === 'canceled') {
          out.canceled += 1;
        } else {
          out.failed += 1;
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.finish(task.taskId, 'failed', {
          reason: 'resume_policy_redispatch_error',
          recoveredOnStartup: true,
          error: message,
        });
        out.failed += 1;
        out.errors.push(`task ${task.taskId}: ${message}`);
      } finally {
        this.recoveredTaskIds.delete(task.taskId);
      }
    }

    return this.recordLastResume(out);
  }

  private recover(): void {
    const records = this.wal.recoverAndRead();
    for (const record of records) {
      const envelope = parseEnvelope(record.payload);
      if (!envelope) continue;

      if (envelope.op === 'enqueue') {
        this.pending.set(envelope.taskId, {
          taskId: envelope.taskId,
          enqueuedAt: envelope.enqueuedAt,
          task: envelope.task,
        });
        this.recoveredTaskIds.add(envelope.taskId);
        this.totalEnqueued += 1;
        continue;
      }

      this.pending.delete(envelope.taskId);
      this.recoveredTaskIds.delete(envelope.taskId);
      this.totalFinished += 1;
    }
  }

  private recordLastResume(result: TaskQueueResumeResult): TaskQueueResumeResult {
    this.lastResume = {
      ...result,
      errors: [...result.errors],
      completedAt: new Date().toISOString(),
    };
    return result;
  }
}

function normalizeResumeStatus(status: TaskQueueStatus | void): TaskQueueStatus {
  if (status === 'completed' || status === 'failed' || status === 'canceled') {
    return status;
  }
  return 'completed';
}
