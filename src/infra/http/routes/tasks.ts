import type { TaskQueueService } from '../../storage/task-queue-service.js';

type TaskRouteApp = {
  get: (
    path: string,
    handler: (request: unknown, reply: { send: (body: unknown) => unknown }) => Promise<unknown>,
  ) => void;
};

export function registerTaskRoutes(app: TaskRouteApp, taskQueue?: TaskQueueService): void {
  app.get('/api/tasks/status', async (_request, reply) => {
    if (!taskQueue) {
      return reply.send({ ok: false, error: 'task queue not initialized' });
    }

    const snapshot = taskQueue.snapshot();
    return reply.send({
      ok: true,
      queue: {
        mode: snapshot.mode,
        resumePolicy: snapshot.resumePolicy,
        maxPendingTasks: snapshot.maxPendingTasks,
        pendingTasks: snapshot.pendingTasks,
        recoveredPendingTasks: snapshot.recoveredPendingTasks,
        totalEnqueued: snapshot.totalEnqueued,
        totalFinished: snapshot.totalFinished,
        lastResume: snapshot.lastResume,
      },
    });
  });

  app.get('/api/tasks/pending', async (_request, reply) => {
    if (!taskQueue) {
      return reply.send({ ok: false, error: 'task queue not initialized' });
    }

    const pending = taskQueue.listPending();
    return reply.send({
      ok: true,
      count: pending.length,
      tasks: pending.map((t) => ({
        taskId: t.taskId,
        enqueuedAt: t.enqueuedAt,
        type: t.task.type,
        requestId: t.task.requestId ?? null,
      })),
    });
  });
}
