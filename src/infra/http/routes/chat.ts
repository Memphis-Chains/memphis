import { createHash, randomUUID } from 'node:crypto';

import type {
  GenerationEventRepository,
  SessionRepository,
} from '../../../core/contracts/repository.js';
import { AppError } from '../../../core/errors.js';
import type { OrchestrationService } from '../../../modules/orchestration/service.js';
import { chatGenerateSchema } from '../../config/request-schemas.js';
import { metrics } from '../../logging/metrics.js';
import type { TaskQueueService } from '../../storage/task-queue-service.js';
import type { HttpChatRuntimeDeps } from '../../work/chat-work.js';
import {
  buildChatDispatchWorkItem,
  executeChatGeneratePayload,
} from '../../work/chat-work.js';
import type { WorkPollingService } from '../../work/work-polling-service.js';
import {
  chatDispatchAcceptedSchema,
  chatDispatchStatusSchema,
  generateResponseSchema,
} from '../contracts.js';

type ChatRouteRequest = {
  body: unknown;
  id: string;
  params?: Record<string, string | undefined>;
};

type ChatRouteReply = {
  status: (code: number) => { send: (payload: unknown) => unknown };
  send: (payload: unknown) => unknown;
};

type ChatRouteApp = {
  get: (
    path: string,
    handler: (request: ChatRouteRequest, reply: ChatRouteReply) => Promise<unknown> | unknown,
    ...extra: unknown[]
  ) => unknown;
  post: (
    path: string,
    handler: (request: ChatRouteRequest, reply: ChatRouteReply) => Promise<unknown> | unknown,
    ...extra: unknown[]
  ) => unknown;
};

export async function registerChatRoutes(
  app: ChatRouteApp,
  orchestration: OrchestrationService,
  repos?: {
    sessionRepository: SessionRepository;
    generationEventRepository: GenerationEventRepository;
    taskQueue?: TaskQueueService;
    workPollingService?: WorkPollingService;
  },
  runtime?: HttpChatRuntimeDeps,
) {
  app.get('/v1/chat/dispatch/:workId', async (request: ChatRouteRequest, reply: ChatRouteReply) => {
    const workId = request.params?.workId?.trim();
    if (!workId) {
      throw new AppError('VALIDATION_ERROR', 'workId is required', 400);
    }

    if (!repos?.workPollingService) {
      return reply.status(503).send({
        ok: false,
        error: 'work polling not initialized',
      });
    }

    const work = repos.workPollingService.getWorkItem(workId);
    if (!work) {
      return reply.status(404).send({
        ok: false,
        error: 'chat dispatch work item not found',
      });
    }

    const responseContract = work.status === 'completed' ? generateResponseSchema.safeParse(work.result) : null;
    const tagged = {
      ok: true as const,
      work: {
        workId: work.workId,
        status: work.status,
        type: work.type,
        actorId: work.actorId ?? null,
        conversationId: work.conversationId ?? null,
        capabilityScope: work.capabilityScope,
        attempts: work.attempts,
        createdAt: work.createdAt,
        updatedAt: work.updatedAt,
        leaseExpiresAtMs: work.leaseExpiresAtMs ?? null,
        heartbeatAtMs: work.heartbeatAtMs ?? null,
      },
      response: responseContract?.success ? responseContract.data : null,
      result: work.result ?? null,
      resultContractOk: responseContract ? responseContract.success : null,
    };
    const contractCheck = chatDispatchStatusSchema.safeParse(tagged);
    if (!contractCheck.success) {
      throw new AppError('INTERNAL_ERROR', 'Invalid chat dispatch status contract', 500, {
        issues: contractCheck.error.issues.map((i) => ({
          path: i.path.map(String),
          message: i.message,
        })),
      });
    }

    return contractCheck.data;
  });

  app.post('/v1/chat/dispatch', async (request: ChatRouteRequest, reply: ChatRouteReply) => {
    const parsed = chatGenerateSchema.safeParse(request.body);

    if (!parsed.success) {
      throw new AppError('VALIDATION_ERROR', 'Invalid request payload', 400, {
        issues: parsed.error.issues.map((i) => ({ path: i.path.map(String), message: i.message })),
      });
    }

    if (!repos?.workPollingService) {
      return reply.status(503).send({
        ok: false,
        error: 'work polling not initialized',
      });
    }

    const workPollingSnapshot = repos.workPollingService.snapshot();
    if (!workPollingSnapshot.tokenReady) {
      return reply.status(503).send({
        ok: false,
        error: 'work polling session tokens are not ready',
      });
    }

    const payload = parsed.data;
    if (repos && payload.sessionId) {
      repos.sessionRepository.ensureSession(payload.sessionId);
    }
    const dispatch = buildChatDispatchWorkItem(payload, request.id);
    const work = repos.workPollingService.enqueueWork(dispatch.workInput);

    const tagged = {
      ok: true as const,
      accepted: true as const,
      requestId: request.id,
      mode: dispatch.mode,
      work: {
        workId: work.workId,
        status: work.status,
        type: work.type,
        actorId: dispatch.actorId,
        conversationId: dispatch.conversationId,
        capabilityScope: work.capabilityScope,
        attempts: work.attempts,
        createdAt: work.createdAt,
        updatedAt: work.updatedAt,
        leaseExpiresAtMs: work.leaseExpiresAtMs ?? null,
        heartbeatAtMs: work.heartbeatAtMs ?? null,
      },
    };
    const contractCheck = chatDispatchAcceptedSchema.safeParse(tagged);
    if (!contractCheck.success) {
      throw new AppError('INTERNAL_ERROR', 'Invalid chat dispatch response contract', 500, {
        issues: contractCheck.error.issues.map((i) => ({
          path: i.path.map(String),
          message: i.message,
        })),
      });
    }

    return reply.status(202).send(contractCheck.data);
  });

  app.post('/v1/chat/generate', async (request: ChatRouteRequest) => {
    const parsed = chatGenerateSchema.safeParse(request.body);

    if (!parsed.success) {
      throw new AppError('VALIDATION_ERROR', 'Invalid request payload', 400, {
        issues: parsed.error.issues.map((i) => ({ path: i.path.map(String), message: i.message })),
      });
    }

    const payload = parsed.data;

    if (repos && payload.sessionId) {
      repos.sessionRepository.ensureSession(payload.sessionId);
    }

    let queueTicket: ReturnType<TaskQueueService['enqueue']> | undefined;
    try {
      if (payload.input) {
        queueTicket = repos?.taskQueue?.enqueue({
          type: 'chat.generate',
          requestId: request.id,
          metadata: {
            provider: payload.provider ?? 'auto',
            strategy: payload.strategy ?? 'default',
            sessionId: payload.sessionId ?? null,
            inputDigest: createHash('sha256').update(payload.input).digest('hex'),
            inputBytes: Buffer.byteLength(payload.input, 'utf8'),
          },
          payload: {
            input: payload.input,
            provider: payload.provider ?? 'auto',
            model: payload.model ?? null,
            sessionId: payload.sessionId ?? null,
            options: payload.options ?? null,
            strategy: payload.strategy ?? 'default',
          },
        });
      }
    } catch (error) {
      if (error instanceof AppError && error.code === 'OVERLOAD') {
        metrics.recordQueueOverload();
      }
      throw error;
    }

    let result;
    try {
      result = await executeChatGeneratePayload(orchestration, runtime, payload, {
        requestId: request.id,
        queueTaskId: queueTicket?.taskId,
        source: 'http.chat.generate',
      });
    } catch (error) {
      if (queueTicket) {
        repos?.taskQueue?.finish(queueTicket.taskId, 'failed', {
          code: error instanceof AppError ? error.code : 'INTERNAL_ERROR',
          message: error instanceof Error ? error.message : String(error),
        });
      }
      throw error;
    }

    if (queueTicket) {
      repos?.taskQueue?.finish(queueTicket.taskId, 'completed', {
        providerUsed: result.providerUsed,
        modelUsed: result.modelUsed ?? null,
      });
    }

    if (repos) {
      repos.generationEventRepository.create({
        id: result.id || `gen_${randomUUID()}`,
        sessionId: payload.sessionId,
        providerUsed: result.providerUsed,
        modelUsed: result.modelUsed,
        timingMs: result.timingMs,
        requestId: request.id,
      });
    }
    return result;
  });
}
