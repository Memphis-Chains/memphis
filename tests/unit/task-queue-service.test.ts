import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { AppError } from '../../src/core/errors.js';
import { TaskQueueService } from '../../src/infra/storage/task-queue-service.js';

describe('task queue service', () => {
  it('replays pending state from wal', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mv5-queue-service-'));
    const walPath = join(dir, 'queue.wal');
    const queue = new TaskQueueService({
      walPath,
      mode: 'financial',
      maxPendingTasks: 10,
    });

    const t1 = queue.enqueue({ type: 'chat.generate', metadata: { requestId: 'r1' } });
    const t2 = queue.enqueue({ type: 'chat.generate', metadata: { requestId: 'r2' } });
    expect(queue.finish(t1.taskId, 'completed')).toBe(true);
    expect(queue.finish('unknown', 'completed')).toBe(false);

    const snapshotBeforeRestart = queue.snapshot();
    expect(snapshotBeforeRestart.resumePolicy).toBe('keep');
    expect(snapshotBeforeRestart.pendingTasks).toBe(1);
    expect(snapshotBeforeRestart.totalEnqueued).toBe(2);
    expect(snapshotBeforeRestart.totalFinished).toBe(1);
    expect(snapshotBeforeRestart.lastResume).toBeNull();

    const queueAfterRestart = new TaskQueueService({
      walPath,
      mode: 'financial',
      maxPendingTasks: 10,
    });
    const snapshotAfterRestart = queueAfterRestart.snapshot();
    expect(snapshotAfterRestart.pendingTasks).toBe(1);
    expect(snapshotAfterRestart.recoveredPendingTasks).toBe(1);
    expect(snapshotAfterRestart.totalEnqueued).toBe(2);
    expect(snapshotAfterRestart.totalFinished).toBe(1);
    expect(queueAfterRestart.finish(t2.taskId, 'failed')).toBe(true);
  });

  it('fails fast when pending queue is full', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mv5-queue-full-'));
    const walPath = join(dir, 'queue.wal');
    const queue = new TaskQueueService({
      walPath,
      mode: 'financial',
      maxPendingTasks: 1,
    });

    queue.enqueue({ type: 'chat.generate', metadata: { requestId: 'r1' } });

    try {
      queue.enqueue({ type: 'chat.generate', metadata: { requestId: 'r2' } });
      expect.fail('expected overload error');
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      const appError = error as AppError;
      expect(appError.code).toBe('OVERLOAD');
      expect(appError.statusCode).toBe(429);
    }
  });

  it('applies fail resume policy to recovered tasks on restart', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mv5-queue-resume-fail-'));
    const walPath = join(dir, 'queue.wal');
    const queue = new TaskQueueService({
      walPath,
      mode: 'financial',
      maxPendingTasks: 10,
    });

    queue.enqueue({
      type: 'chat.generate',
      requestId: 'req-1',
      payload: { input: 'hello', provider: 'auto', strategy: 'default' },
    });

    const restarted = new TaskQueueService({
      walPath,
      mode: 'financial',
      maxPendingTasks: 10,
      resumePolicy: 'fail',
    });
    const before = restarted.snapshot();
    expect(before.pendingTasks).toBe(1);
    expect(before.recoveredPendingTasks).toBe(1);

    const resume = await restarted.resumeRecoveredPending();
    expect(resume.policy).toBe('fail');
    expect(resume.scanned).toBe(1);
    expect(resume.failed).toBe(1);
    expect(resume.redispatched).toBe(0);
    expect(resume.errors).toEqual([]);

    const after = restarted.snapshot();
    expect(after.pendingTasks).toBe(0);
    expect(after.recoveredPendingTasks).toBe(0);
    expect(after.totalFinished).toBe(1);
    expect(after.lastResume?.policy).toBe('fail');
    expect(after.lastResume?.scanned).toBe(1);
  });

  it('applies redispatch resume policy with deterministic outcomes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mv5-queue-resume-redispatch-'));
    const walPath = join(dir, 'queue.wal');
    const queue = new TaskQueueService({
      walPath,
      mode: 'financial',
      maxPendingTasks: 10,
    });

    const a = queue.enqueue({
      type: 'chat.generate',
      requestId: 'req-a',
      payload: { input: 'hello-a', provider: 'auto', strategy: 'default' },
    });
    const b = queue.enqueue({
      type: 'chat.generate',
      requestId: 'req-b',
      payload: { input: 'hello-b', provider: 'auto', strategy: 'default' },
    });

    const restarted = new TaskQueueService({
      walPath,
      mode: 'financial',
      maxPendingTasks: 10,
      resumePolicy: 'redispatch',
    });

    const seen: string[] = [];
    const resume = await restarted.resumeRecoveredPending({
      redispatch: async (task) => {
        seen.push(task.taskId);
        return task.taskId === b.taskId ? 'canceled' : 'completed';
      },
    });

    expect(resume.policy).toBe('redispatch');
    expect(resume.scanned).toBe(2);
    expect(resume.redispatched).toBe(1);
    expect(resume.canceled).toBe(1);
    expect(resume.failed).toBe(0);
    expect(seen).toContain(a.taskId);
    expect(seen).toContain(b.taskId);

    const snapshot = restarted.snapshot();
    expect(snapshot.pendingTasks).toBe(0);
    expect(snapshot.recoveredPendingTasks).toBe(0);
    expect(snapshot.totalFinished).toBe(2);
    expect(snapshot.resumePolicy).toBe('redispatch');
    expect(snapshot.lastResume?.policy).toBe('redispatch');
    expect(snapshot.lastResume?.scanned).toBe(2);
  });
});
