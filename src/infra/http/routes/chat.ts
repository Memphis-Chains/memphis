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
import { generateResponseSchema } from '../contracts.js';

type ChatRouteRequest = {
  body: unknown;
  id: string;
};

type ChatRouteApp = {
  post: (path: string, handler: (request: ChatRouteRequest) => Promise<unknown>) => void;
};

export async function registerChatRoutes(
  app: ChatRouteApp,
  orchestration: OrchestrationService,
  repos?: {
    sessionRepository: SessionRepository;
    generationEventRepository: GenerationEventRepository;
    taskQueue?: TaskQueueService;
  },
) {
  app.post('/v1/chat/generate', async (request) => {
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
    } catch (error) {
      if (error instanceof AppError && error.code === 'OVERLOAD') {
        metrics.recordQueueOverload();
      }
      throw error;
    }

    let result: Awaited<ReturnType<OrchestrationService['generate']>>;
    try {
      result = await orchestration.generate({
        input: payload.input,
        provider: payload.provider,
        model: payload.model,
        sessionId: payload.sessionId,
        options: payload.options,
        strategy: payload.strategy,
        execution: {
          taskId: queueTicket?.taskId ?? request.id,
          runId: queueTicket?.taskId ?? request.id,
          source: 'http.chat.generate',
          enableReplayDedupe: Boolean(queueTicket?.taskId),
        },
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

    const contractCheck = generateResponseSchema.safeParse(result);
    if (!contractCheck.success) {
      throw new AppError('INTERNAL_ERROR', 'Invalid generate response contract', 500, {
        issues: contractCheck.error.issues.map((i) => ({
          path: i.path.map(String),
          message: i.message,
        })),
      });
    }

    return contractCheck.data;
  });
}
