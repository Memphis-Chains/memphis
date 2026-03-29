import { createHash, randomUUID } from 'node:crypto';

import type {
  GenerationEventRepository,
  SessionRepository,
} from '../../../core/contracts/repository.js';
import { AppError } from '../../../core/errors.js';
import type { DegradationInfo } from '../../../core/types.js';
import { runTurnRuntime } from '../../../gateway/turn-runtime.js';
import type { OrchestrationService } from '../../../modules/orchestration/service.js';
import type { ChatToolDefinition } from '../../../providers/index.js';
import type { RuntimeProvider } from '../../../providers/runtime.js';
import { chatGenerateSchema } from '../../config/request-schemas.js';
import { metrics } from '../../logging/metrics.js';
import { sanitizeForJson, validateProviderName } from '../../security/sanitizers.js';
import type { TaskQueueService } from '../../storage/task-queue-service.js';
import { generateResponseSchema } from '../contracts.js';

type ChatRouteRequest = {
  body: unknown;
  id: string;
};

type ChatRouteApp = {
  post: (path: string, handler: (request: ChatRouteRequest) => Promise<unknown>) => void;
};

export type HttpChatRuntimeDeps = {
  memory: import('../../../gateway/chat-types.js').MemoryClient;
  toolExecutor: import('../../../gateway/chat-types.js').ToolExecutor;
};

async function runHttpTurn(
  runtime: HttpChatRuntimeDeps,
  runtimeProvider: RuntimeProvider,
  input: {
    input?: string;
    messages?: import('../../../core/types.js').ChatMessage[];
    systemPrompt?: string;
    tools?: ChatToolDefinition[];
    model?: string;
    userId?: string;
    sessionId?: string;
  },
): Promise<{
  id: string;
  providerUsed: RuntimeProvider['name'];
  modelUsed: string;
  output: string;
  timingMs: number;
}> {
  const turn = await runTurnRuntime({
    input: input.input,
    messages: input.messages,
    provider: runtimeProvider,
    model: input.model,
    systemPrompt: input.systemPrompt,
    tools: input.tools,
    toolExecutor: runtime.toolExecutor,
    memory: runtime.memory,
    memoryUserId: input.userId ?? input.sessionId ?? 'http:anonymous',
    surface: 'http.chat.generate',
  });

  return {
    id: `gen_${randomUUID()}`,
    providerUsed: runtimeProvider.name,
    modelUsed: turn.model,
    output: turn.output,
    timingMs: turn.timingMs,
  };
}

function resolveCascadeForHttp(
  orchestration: OrchestrationService,
  requested?: 'auto' | import('../../../core/types.js').ProviderName,
  strategy: 'default' | 'latency-aware' = 'default',
): { provider: RuntimeProvider; degradation?: DegradationInfo } {
  // SECURITY: Validate provider name at API boundary
  if (requested && requested !== 'auto' && !validateProviderName(requested)) {
    throw new AppError('INVALID_PROVIDER', 'Invalid provider name', 400);
  }

  const cascade = orchestration.getCascadeResult(requested, strategy);

  // SECURITY: Sanitize all fields in degradation response
  const degradation: DegradationInfo | undefined = cascade.degraded
    ? {
        degraded: cascade.degraded,
        tier: cascade.tier,
        originalProvider: sanitizeForJson(cascade.originalRequested),
        actualProvider: sanitizeForJson(cascade.actualProvider),
        reason: cascade.reason ? sanitizeForJson(cascade.reason) : undefined,
      }
    : undefined;

  return { provider: cascade.provider, degradation };
}

export async function registerChatRoutes(
  app: ChatRouteApp,
  orchestration: OrchestrationService,
  repos?: {
    sessionRepository: SessionRepository;
    generationEventRepository: GenerationEventRepository;
    taskQueue?: TaskQueueService;
  },
  runtime?: HttpChatRuntimeDeps,
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

    const mode = payload.mode ?? 'canonical';

    // ─── messages[] path (new: full chat API) ─────────────────────────────────
    if (payload.messages && payload.messages.length > 0) {
      let result: Awaited<ReturnType<typeof runHttpTurn>> | Awaited<ReturnType<OrchestrationService['chat']>> | (Awaited<ReturnType<typeof runHttpTurn>> & { degradation?: DegradationInfo });

      if (mode === 'provider-only') {
        result = await orchestration.chat({
          messages: payload.messages,
          systemPrompt: payload.systemPrompt,
          userId: payload.userId,
          tools: payload.tools,
          provider: payload.provider,
          model: payload.model,
          sessionId: payload.sessionId,
          options: payload.options,
          strategy: payload.strategy,
        });
      } else {
        if (!runtime) {
          // Server misconfiguration - runtime should always be available
          throw new AppError(
            'INTERNAL_ERROR',
            'Chat runtime is not available (server misconfiguration).',
            500,
          );
        }
        const { provider: runtimeProvider, degradation } = resolveCascadeForHttp(orchestration, payload.provider, payload.strategy ?? 'default');
        result = await runHttpTurn(runtime, runtimeProvider, {
          messages: payload.messages,
          systemPrompt: payload.systemPrompt,
          tools: payload.tools as ChatToolDefinition[] | undefined,
          model: payload.model,
          userId: payload.userId,
          sessionId: payload.sessionId,
        });
        // Add degradation info to result if provider cascaded
        if (degradation) {
          result = { ...result, degradation };
        }
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

      const tagged = { ...result, mode };
      const contractCheck = generateResponseSchema.safeParse(tagged);
      if (!contractCheck.success) {
        throw new AppError('INTERNAL_ERROR', 'Invalid generate response contract', 500, {
          issues: contractCheck.error.issues.map((i) => ({
            path: i.path.map(String),
            message: i.message,
          })),
        });
      }

      return contractCheck.data;
    }

    // ─── legacy string input path ────────────────────────────────────────────
    if (!payload.input) {
      throw new AppError('VALIDATION_ERROR', 'input is required when messages[] is not provided', 400);
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

    let result: Awaited<ReturnType<OrchestrationService['generate']>> | (Awaited<ReturnType<typeof runHttpTurn>> & { degradation?: DegradationInfo });
    try {
      if (mode === 'provider-only') {
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
      } else {
        if (!runtime) {
          // Server misconfiguration - runtime should always be available
          throw new AppError(
            'INTERNAL_ERROR',
            'Chat runtime is not available (server misconfiguration).',
            500,
          );
        }
        const { provider: runtimeProvider, degradation } = resolveCascadeForHttp(orchestration, payload.provider, payload.strategy ?? 'default');
        result = await runHttpTurn(runtime, runtimeProvider, {
          input: payload.input,
          systemPrompt: payload.systemPrompt,
          tools: payload.tools as ChatToolDefinition[] | undefined,
          model: payload.model,
          userId: payload.userId,
          sessionId: payload.sessionId,
        });
        // Add degradation info to result if provider cascaded
        if (degradation) {
          result = { ...result, degradation };
        }
      }
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

    const tagged = { ...result, mode };
    const contractCheck = generateResponseSchema.safeParse(tagged);
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
