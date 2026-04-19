import { randomUUID } from 'node:crypto';

import type {
  GenerationEventRepository,
  SessionRepository,
} from '../../core/contracts/repository.js';
import { AppError } from '../../core/errors.js';
import type {
  DegradationInfo,
  ExecutionMode,
  GenerateInput,
  ProviderName,
  RequestedProviderName,
  RuntimeTelemetry,
} from '../../core/types.js';
import type { ConversationContextService } from '../../gateway/conversation-context-service.js';
import { normalizeConversationId, resolveActorId } from '../../gateway/conversation-identity.js';
import { runTurnRuntime } from '../../gateway/turn-runtime.js';
import type { OrchestrationService } from '../../modules/orchestration/service.js';
import type { ChatMessage, ChatToolDefinition } from '../../providers/index.js';
import type { RuntimeProvider } from '../../providers/runtime.js';
import { chatGenerateSchema } from '../config/request-schemas.js';
import type { GenerateResponse } from '../http/contracts.js';
import { generateResponseSchema } from '../http/contracts.js';
import { buildRuntimeTelemetry, recordTurnTelemetry } from '../runtime/turn-telemetry.js';
import { sanitizeForJson, validateProviderName } from '../security/sanitizers.js';
import type { SqliteOperatorChatSessionRepository } from '../storage/sqlite/repositories/operator-chat-session-repository.js';
import type { WorkItemRecord } from '../storage/sqlite/repositories/work-item-repository.js';

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export type HttpChatRuntimeDeps = {
  memory: import('../../gateway/chat-types.js').MemoryClient;
  toolExecutor: import('../../gateway/chat-types.js').ToolExecutor;
  operatorChatSessionRepository?: SqliteOperatorChatSessionRepository;
  conversationContextService?: ConversationContextService;
};

export type ChatGeneratePayload = GenerateInput & {
  provider?: RequestedProviderName;
  mode?: ExecutionMode;
};

export type ChatDispatchWorkPayload = ChatGeneratePayload & {
  requestId?: string;
  conversationId?: string;
  originalUserId?: string | null;
};

export type ChatGenerateExecutionOptions = {
  requestId: string;
  source: string;
  queueTaskId?: string;
  persistSession?: boolean;
};

export type ChatWorkFinalizeDeps = {
  sessionRepository?: SessionRepository;
  generationEventRepository?: GenerationEventRepository;
  operatorChatSessionRepository?: SqliteOperatorChatSessionRepository;
};

function telemetryMessagesFromPayload(payload: ChatGeneratePayload): ChatMessage[] {
  if (payload.messages?.length) {
    return payload.messages as ChatMessage[];
  }
  if (typeof payload.input === 'string' && payload.input.trim().length > 0) {
    return [{ role: 'user', content: payload.input }];
  }
  return [];
}

function providerOnlyDegradation(result: Pick<GenerateResponse, 'trace'>): {
  degraded: boolean;
  reason?: string;
} {
  const usedFallback = result.trace?.attempts.some((attempt) => attempt.viaFallback) ?? false;
  return {
    degraded: usedFallback,
    reason: usedFallback ? 'provider_fallback_used' : undefined,
  };
}

function attachProviderOnlyTelemetry(
  payload: ChatGeneratePayload,
  result: GenerateResponse,
  options: ChatGenerateExecutionOptions,
): GenerateResponse {
  if (result.telemetry) {
    recordTurnTelemetry({
      surface: options.source,
      provider: result.providerUsed,
      model: result.modelUsed ?? 'unknown',
      telemetry: result.telemetry,
    });
    return result;
  }

  const degradation = providerOnlyDegradation(result);
  const telemetry = buildRuntimeTelemetry({
    provider: result.providerUsed,
    model: result.modelUsed ?? 'unknown',
    systemPrompt: payload.systemPrompt,
    messages: telemetryMessagesFromPayload(payload),
    usage: result.usage,
    degraded: degradation.degraded,
    degradationReason: degradation.reason,
  });
  recordTurnTelemetry({
    surface: options.source,
    provider: result.providerUsed,
    model: result.modelUsed ?? 'unknown',
    telemetry,
  });
  return { ...result, telemetry };
}

export function buildChatDispatchWorkItem(
  payload: ChatGeneratePayload,
  requestId: string,
  extraPayload: Record<string, unknown> = {},
): {
  actorId: string;
  conversationId: string;
  mode: ExecutionMode;
  workInput: {
    type: 'chat.generate';
    actorId: string;
    conversationId: string;
    capabilityScope: string[];
    payload: Record<string, unknown>;
  };
} {
  const actorId = resolveActorId(payload.userId ?? payload.sessionId ?? 'http:anonymous');
  const conversationId = normalizeConversationId(payload.sessionId, actorId);
  const mode = payload.mode ?? 'canonical';

  return {
    actorId,
    conversationId,
    mode,
    workInput: {
      type: 'chat.generate',
      actorId,
      conversationId,
      capabilityScope: ['task:chat.generate'],
      payload: {
        requestId,
        input: payload.input ?? null,
        messages: payload.messages ?? null,
        systemPrompt: payload.systemPrompt ?? null,
        tools: payload.tools ?? null,
        provider: payload.provider ?? 'auto',
        model: payload.model ?? null,
        userId: actorId,
        originalUserId: payload.userId ?? null,
        sessionId: payload.sessionId ?? null,
        conversationId,
        strategy: payload.strategy ?? 'default',
        mode,
        options: payload.options ?? null,
        ...extraPayload,
      },
    },
  };
}

export function parseChatDispatchWorkPayload(value: unknown): ChatDispatchWorkPayload | null {
  if (!isObject(value)) return null;

  const parsed = chatGenerateSchema.safeParse({
    input: typeof value.input === 'string' ? value.input : undefined,
    messages: Array.isArray(value.messages) ? value.messages : undefined,
    systemPrompt: typeof value.systemPrompt === 'string' ? value.systemPrompt : undefined,
    userId: typeof value.userId === 'string' ? value.userId : undefined,
    tools: Array.isArray(value.tools) ? value.tools : undefined,
    provider: typeof value.provider === 'string' ? value.provider : undefined,
    model: typeof value.model === 'string' ? value.model : undefined,
    sessionId: typeof value.sessionId === 'string' ? value.sessionId : undefined,
    strategy:
      value.strategy === 'latency-aware'
        ? 'latency-aware'
        : value.strategy === 'default'
          ? 'default'
          : undefined,
    mode:
      value.mode === 'provider-only'
        ? 'provider-only'
        : value.mode === 'canonical'
          ? 'canonical'
          : undefined,
    options: isObject(value.options) ? value.options : undefined,
  });
  if (!parsed.success) return null;

  return {
    ...parsed.data,
    requestId: typeof value.requestId === 'string' ? value.requestId : undefined,
    conversationId: typeof value.conversationId === 'string' ? value.conversationId : undefined,
    originalUserId: typeof value.originalUserId === 'string' ? value.originalUserId : null,
  };
}

export async function executeChatGeneratePayload(
  orchestration: OrchestrationService,
  runtime: HttpChatRuntimeDeps | undefined,
  payload: ChatGeneratePayload,
  options: ChatGenerateExecutionOptions,
): Promise<GenerateResponse> {
  const mode = payload.mode ?? 'canonical';

  if (payload.messages && payload.messages.length > 0) {
    let result:
      | Awaited<ReturnType<OrchestrationService['chat']>>
      | (Awaited<ReturnType<typeof runHttpTurn>> & { degradation?: DegradationInfo });

    if (mode === 'provider-only') {
      result = attachProviderOnlyTelemetry(
        payload,
        await orchestration.chat({
          messages: payload.messages,
          systemPrompt: payload.systemPrompt,
          userId: payload.userId,
          tools: payload.tools,
          provider: payload.provider,
          model: payload.model,
          sessionId: payload.sessionId,
          options: payload.options,
          strategy: payload.strategy,
        }),
        options,
      );
    } else {
      if (!runtime) {
        throw new AppError(
          'INTERNAL_ERROR',
          'Chat runtime is not available (server misconfiguration).',
          500,
        );
      }
      const { provider: runtimeProvider, degradation } = resolveCascadeForHttp(
        orchestration,
        payload.provider,
        payload.strategy ?? 'default',
      );
      result = await runHttpTurn(runtime, runtimeProvider, {
        messages: payload.messages,
        systemPrompt: payload.systemPrompt,
        tools: payload.tools as ChatToolDefinition[] | undefined,
        model: payload.model,
        userId: payload.userId,
        sessionId: payload.sessionId,
        persistSession: options.persistSession ?? true,
        providerCascade: degradation,
      });
      if (degradation) {
        result = { ...result, degradation };
      }
    }

    return validateGenerateContract({ ...result, mode });
  }

  if (!payload.input) {
    throw new AppError(
      'VALIDATION_ERROR',
      'input is required when messages[] is not provided',
      400,
    );
  }

  let result:
    | Awaited<ReturnType<OrchestrationService['generate']>>
    | (Awaited<ReturnType<typeof runHttpTurn>> & { degradation?: DegradationInfo });
  if (mode === 'provider-only') {
    result = attachProviderOnlyTelemetry(
      payload,
      await orchestration.generate({
        input: payload.input,
        provider: payload.provider,
        model: payload.model,
        sessionId: payload.sessionId,
        options: payload.options,
        strategy: payload.strategy,
        execution: {
          taskId: options.queueTaskId ?? options.requestId,
          runId: options.queueTaskId ?? options.requestId,
          source: options.source,
          enableReplayDedupe: Boolean(options.queueTaskId),
        },
      }),
      options,
    );
  } else {
    if (!runtime) {
      throw new AppError(
        'INTERNAL_ERROR',
        'Chat runtime is not available (server misconfiguration).',
        500,
      );
    }
    const { provider: runtimeProvider, degradation } = resolveCascadeForHttp(
      orchestration,
      payload.provider,
      payload.strategy ?? 'default',
    );
    result = await runHttpTurn(runtime, runtimeProvider, {
      input: payload.input,
      systemPrompt: payload.systemPrompt,
      tools: payload.tools as ChatToolDefinition[] | undefined,
      model: payload.model,
      userId: payload.userId,
      sessionId: payload.sessionId,
      persistSession: options.persistSession ?? true,
      providerCascade: degradation,
    });
    if (degradation) {
      result = { ...result, degradation };
    }
  }

  return validateGenerateContract({ ...result, mode });
}

export function finalizeCompletedChatGenerateWork(
  work: WorkItemRecord,
  deps?: ChatWorkFinalizeDeps,
): void {
  if (work.type !== 'chat.generate' || work.status !== 'completed' || !work.result) {
    return;
  }

  const responseContract = generateResponseSchema.safeParse(work.result);
  if (!responseContract.success) {
    return;
  }

  const response = responseContract.data;
  const requestId =
    typeof work.payload.requestId === 'string' && work.payload.requestId.trim().length > 0
      ? work.payload.requestId.trim()
      : undefined;
  const sessionId =
    typeof work.payload.sessionId === 'string' && work.payload.sessionId.trim().length > 0
      ? work.payload.sessionId.trim()
      : work.conversationId;
  const conversationId =
    work.conversationId ??
    (typeof work.payload.conversationId === 'string' &&
    work.payload.conversationId.trim().length > 0
      ? work.payload.conversationId.trim()
      : undefined);

  if (deps?.sessionRepository && sessionId) {
    deps.sessionRepository.ensureSession(sessionId);
  }

  deps?.generationEventRepository?.create({
    id: response.id,
    sessionId,
    providerUsed: response.providerUsed,
    modelUsed: response.modelUsed,
    timingMs: response.timingMs,
    requestId,
  });

  if (!deps?.operatorChatSessionRepository || !conversationId) {
    return;
  }

  const userText = extractUserTextForPersistence(work.payload);
  const assistantReply = response.output.trim();
  const messages = [];
  if (userText) {
    messages.push({
      role: 'user' as const,
      content: userText,
      displayContent: userText,
      provider: 'http.chat.dispatch',
    });
  }
  if (assistantReply) {
    messages.push({
      role: 'assistant' as const,
      content: assistantReply,
      displayContent: assistantReply,
      provider: response.providerUsed,
      model: response.modelUsed,
    });
  }
  if (messages.length > 0) {
    deps.operatorChatSessionRepository.appendMessages(conversationId, messages);
  }
}

function extractUserTextForPersistence(payload: Record<string, unknown>): string | undefined {
  if (typeof payload.input === 'string' && payload.input.trim().length > 0) {
    return payload.input.trim();
  }
  if (!Array.isArray(payload.messages)) {
    return undefined;
  }

  const messages = payload.messages as Array<Record<string, unknown>>;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === 'user' && typeof message.content === 'string' && message.content.trim()) {
      return message.content.trim();
    }
  }
  return undefined;
}

async function runHttpTurn(
  runtime: HttpChatRuntimeDeps,
  runtimeProvider: RuntimeProvider,
  input: {
    input?: string;
    messages?: import('../../core/types.js').ChatMessage[];
    systemPrompt?: string;
    tools?: ChatToolDefinition[];
    model?: string;
    userId?: string;
    sessionId?: string;
    persistSession?: boolean;
    providerCascade?: Pick<DegradationInfo, 'degraded' | 'tier' | 'reason'>;
  },
): Promise<{
  id: string;
  providerUsed: RuntimeProvider['name'];
  modelUsed: string;
  output: string;
  usage?: GenerateResponse['usage'];
  telemetry?: RuntimeTelemetry;
  timingMs: number;
}> {
  const actorId = resolveActorId(input.userId ?? input.sessionId ?? 'http:anonymous');
  const conversationId = normalizeConversationId(input.sessionId, actorId);
  const turn = await runTurnRuntime({
    input: input.input,
    messages: input.messages,
    provider: runtimeProvider,
    model: input.model,
    systemPrompt: input.systemPrompt,
    tools: input.tools,
    toolExecutor: runtime.toolExecutor,
    memory: runtime.memory,
    memoryUserId: actorId,
    conversationId,
    conversationContext: runtime.conversationContextService,
    surface: 'http.chat.generate',
    providerCascade: input.providerCascade,
    persistSession:
      input.persistSession !== false && runtime.operatorChatSessionRepository && input.sessionId
        ? ({ userText, assistantReply }) => {
            runtime.operatorChatSessionRepository?.appendMessages(conversationId, [
              {
                role: 'user',
                content: userText,
                displayContent: userText,
                provider: 'http.chat.generate',
              },
              {
                role: 'assistant',
                content: assistantReply,
                displayContent: assistantReply,
                provider: 'http.chat.generate',
                model: runtimeProvider.defaultModel(),
              },
            ]);
          }
        : undefined,
  });

  return {
    id: `gen_${randomUUID()}`,
    providerUsed: runtimeProvider.name,
    modelUsed: turn.model,
    output: turn.output,
    usage: turn.usage,
    telemetry: turn.telemetry,
    timingMs: turn.timingMs,
  };
}

function resolveCascadeForHttp(
  orchestration: OrchestrationService,
  requested?: 'auto' | ProviderName,
  strategy: 'default' | 'latency-aware' = 'default',
): { provider: RuntimeProvider; degradation?: DegradationInfo } {
  if (requested && requested !== 'auto' && !validateProviderName(requested)) {
    throw new AppError('INVALID_PROVIDER', 'Invalid provider name', 400);
  }

  const cascade = orchestration.getCascadeResult(requested, strategy);
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

function validateGenerateContract(result: GenerateResponse): GenerateResponse {
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
}
