import { z } from 'zod';

import type {
  GenerationEventRepository,
  SessionRepository,
} from '../../../core/contracts/repository.js';
import { AppError } from '../../../core/errors.js';
import type { SqliteOperatorChatSessionRepository } from '../../storage/sqlite/repositories/operator-chat-session-repository.js';
import { finalizeCompletedChatGenerateWork } from '../../work/chat-work.js';
import { finalizeCompletedScheduledTaskWork } from '../../work/scheduler-work.js';
import type { WorkerAuthContext, WorkPollingService } from '../../work/work-polling-service.js';

const registerWorkerSchema = z.object({
  workerId: z.string().trim().min(1).max(128),
  capabilityScope: z.array(z.string().trim().min(1).max(64)).max(32).optional(),
});

const enqueueWorkSchema = z.object({
  type: z.string().trim().min(1).max(128),
  actorId: z.string().trim().min(1).max(128).optional(),
  conversationId: z.string().trim().min(1).max(256).optional(),
  capabilityScope: z.array(z.string().trim().min(1).max(64)).max(32).optional(),
  payload: z.record(z.string(), z.unknown()).optional(),
});

const pollSchema = z.object({
  waitMs: z.number().int().min(0).max(30_000).optional(),
});

const workRefSchema = z.object({
  workId: z.string().trim().min(1).max(128),
});

const completeSchema = z.object({
  workId: z.string().trim().min(1).max(128),
  status: z.enum(['completed', 'failed', 'canceled']),
  result: z.record(z.string(), z.unknown()).optional(),
});

const revokeSchema = z.object({
  sessionId: z.string().trim().min(1).max(128),
});

type WorkerRouteRequest = {
  body: unknown;
  workerAuth?: WorkerAuthContext;
};

type WorkerRouteReply = {
  status: (code: number) => { send: (payload: unknown) => unknown };
  send: (payload: unknown) => unknown;
};

type WorkerRouteApp = {
  get: (
    path: string,
    handler: (request: WorkerRouteRequest, reply: WorkerRouteReply) => Promise<unknown>,
  ) => void;
  post: (
    path: string,
    handler: (request: WorkerRouteRequest, reply: WorkerRouteReply) => Promise<unknown>,
  ) => void;
};

type WorkerRouteDeps = {
  sessionRepository?: SessionRepository;
  generationEventRepository?: GenerationEventRepository;
  operatorChatSessionRepository?: SqliteOperatorChatSessionRepository;
};

function requireWorkerAuth(request: WorkerRouteRequest): WorkerAuthContext {
  if (!request.workerAuth) {
    throw new AppError('PERMISSION_DENIED', 'worker session token required', 401);
  }
  return request.workerAuth;
}

export function registerWorkerRoutes(
  app: WorkerRouteApp,
  workPollingService?: WorkPollingService,
  deps?: WorkerRouteDeps,
): void {
  app.get('/api/workers/status', async (_request, reply) => {
    if (!workPollingService) {
      return reply.status(503).send({ ok: false, error: 'work polling not initialized' });
    }

    return {
      ok: true,
      snapshot: workPollingService.snapshot(),
    };
  });

  app.post('/api/workers/register', async (request, reply) => {
    if (!workPollingService) {
      return reply.status(503).send({ ok: false, error: 'work polling not initialized' });
    }

    const parsed = registerWorkerSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        ok: false,
        error: 'invalid worker registration payload',
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.map(String),
          message: issue.message,
        })),
      });
    }

    const registration = workPollingService.registerWorker({
      workerId: parsed.data.workerId,
      capabilityScope: parsed.data.capabilityScope ?? [],
    });
    return {
      ok: true,
      sessionId: registration.session.sessionId,
      workerId: registration.session.workerId,
      capabilityScope: registration.session.capabilityScope,
      expiresAtMs: registration.expiresAtMs,
      token: registration.token,
    };
  });

  app.post('/api/workers/refresh', async (request, reply) => {
    if (!workPollingService) {
      return reply.status(503).send({ ok: false, error: 'work polling not initialized' });
    }

    const auth = requireWorkerAuth(request);
    const refreshed = workPollingService.refreshSession(auth);
    return {
      ok: true,
      sessionId: refreshed.session.sessionId,
      workerId: refreshed.session.workerId,
      capabilityScope: refreshed.session.capabilityScope,
      expiresAtMs: refreshed.expiresAtMs,
      token: refreshed.token,
    };
  });

  app.post('/api/workers/enqueue', async (request, reply) => {
    if (!workPollingService) {
      return reply.status(503).send({ ok: false, error: 'work polling not initialized' });
    }

    const parsed = enqueueWorkSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        ok: false,
        error: 'invalid work enqueue payload',
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.map(String),
          message: issue.message,
        })),
      });
    }

    const record = workPollingService.enqueueWork(parsed.data);
    return {
      ok: true,
      workId: record.workId,
      status: record.status,
      type: record.type,
      capabilityScope: record.capabilityScope,
    };
  });

  app.post('/api/workers/poll', async (request, reply) => {
    if (!workPollingService) {
      return reply.status(503).send({ ok: false, error: 'work polling not initialized' });
    }

    const parsed = pollSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.status(400).send({
        ok: false,
        error: 'invalid poll payload',
      });
    }

    const auth = requireWorkerAuth(request);
    const work = await workPollingService.poll(auth, { waitMs: parsed.data.waitMs });
    return {
      ok: true,
      work: work
        ? {
            workId: work.workId,
            type: work.type,
            actorId: work.actorId ?? null,
            conversationId: work.conversationId ?? null,
            capabilityScope: work.capabilityScope,
            payload: work.payload,
            attempts: work.attempts,
          }
        : null,
    };
  });

  app.post('/api/workers/ack', async (request, reply) => {
    if (!workPollingService) {
      return reply.status(503).send({ ok: false, error: 'work polling not initialized' });
    }

    const parsed = workRefSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ ok: false, error: 'invalid ack payload' });
    }

    const auth = requireWorkerAuth(request);
    const work = workPollingService.acknowledgeWork(auth, parsed.data.workId);
    return {
      ok: true,
      workId: work.workId,
      status: work.status,
      leaseExpiresAtMs: work.leaseExpiresAtMs ?? null,
    };
  });

  app.post('/api/workers/heartbeat', async (request, reply) => {
    if (!workPollingService) {
      return reply.status(503).send({ ok: false, error: 'work polling not initialized' });
    }

    const parsed = workRefSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ ok: false, error: 'invalid heartbeat payload' });
    }

    const auth = requireWorkerAuth(request);
    const work = workPollingService.heartbeat(auth, parsed.data.workId);
    return {
      ok: true,
      workId: work.workId,
      status: work.status,
      heartbeatAtMs: work.heartbeatAtMs ?? null,
      leaseExpiresAtMs: work.leaseExpiresAtMs ?? null,
    };
  });

  app.post('/api/workers/complete', async (request, reply) => {
    if (!workPollingService) {
      return reply.status(503).send({ ok: false, error: 'work polling not initialized' });
    }

    const parsed = completeSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ ok: false, error: 'invalid completion payload' });
    }

    const auth = requireWorkerAuth(request);
    const work = workPollingService.completeWork(auth, parsed.data);
    finalizeCompletedChatGenerateWork(work, deps);
    await finalizeCompletedScheduledTaskWork(work);
    return {
      ok: true,
      workId: work.workId,
      status: work.status,
    };
  });

  app.post('/api/workers/revoke', async (request, reply) => {
    if (!workPollingService) {
      return reply.status(503).send({ ok: false, error: 'work polling not initialized' });
    }

    const parsed = revokeSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ ok: false, error: 'invalid revoke payload' });
    }

    const session = workPollingService.revokeSession(parsed.data.sessionId);
    return {
      ok: true,
      sessionId: session.sessionId,
      workerId: session.workerId,
      revokedAt: session.revokedAt ?? null,
      tokenEpoch: session.tokenEpoch,
    };
  });
}
