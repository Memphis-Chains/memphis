import { buildRuntimeSystemPrompt, runAgentLoop } from './agent-runtime.js';
import type { LlmClient, LoopLimits, MemoryClient, ToolExecutor } from './chat-types.js';
import {
  prepareCognitivePrelude,
  runPostResponseCognitivePass,
} from './cognitive-runtime.js';
import type { ConversationContextService, ConversationPromptOverlay } from './conversation-context-service.js';
import {
  auditPromptFragmentAssessment,
  type InputRiskClassification,
  auditInputClassification,
  buildWrappedUserInput,
  classifyUserInput,
  guardModelOutput,
  inspectPromptFragment,
} from './prompt-boundary.js';
import { providerToLlmClient } from './provider-adapter.js';
import {
  isToolAllowedForSurface,
  resolveSurfacePolicy,
  type SurfacePolicy,
} from './surface-policy.js';
import {
  buildConversationCompactionFragment,
  buildCognitiveContextFragment,
  buildFetchedContentFragment,
  buildRecalledMemoryFragment,
  buildSessionMemoryFragment,
} from './system-prompt.js';
import { fetchUrlsFromMessage } from './url-extract.js';
import type { RuntimeTelemetry, TokenUsage } from '../core/types.js';
import { metrics } from '../infra/logging/metrics.js';
import { createPinoLogger } from '../infra/logging/pino.js';
import { buildRuntimeTelemetry, recordTurnTelemetry } from '../infra/runtime/turn-telemetry.js';
import type { ChatMessage, ChatToolCall, ChatToolDefinition } from '../providers/index.js';
import type { RuntimeProvider } from '../providers/runtime.js';
import { scanContent } from '../security/content-scan.js';
import { emitRuntimeSecurityEvent } from '../security/runtime-security-events.js';
import {
  buildTier3EnvOverride,
  getActiveTier3Session,
  type Tier3Surface,
} from '../security/tier3-session.js';

const log = createPinoLogger({ level: process.env.LOG_LEVEL ?? 'info' });

function mapSurfaceToTier3Surface(surface: string): Tier3Surface | null {
  const normalized = surface.toLowerCase();
  if (normalized.startsWith('telegram')) return 'telegram';
  if (normalized.startsWith('matrix')) return 'matrix';
  if (normalized.startsWith('http')) return 'http';
  if (
    normalized === 'tui' ||
    normalized.startsWith('tui.') ||
    normalized === 'cli.chat' ||
    normalized === 'cli' ||
    normalized.startsWith('cli.')
  ) {
    return 'tui';
  }
  return null;
}

function applyTier3EnvOverride(
  rawEnv: NodeJS.ProcessEnv,
  surface: string,
  auditSurface: string | undefined,
  actorId: string | undefined,
): NodeJS.ProcessEnv {
  const tier3Surface =
    mapSurfaceToTier3Surface(auditSurface ?? surface) ??
    mapSurfaceToTier3Surface(surface);
  if (!tier3Surface) return rawEnv;
  const resolvedActorId = actorId ?? 'local';
  const session = getActiveTier3Session(tier3Surface, resolvedActorId);
  if (!session) return rawEnv;
  const override = buildTier3EnvOverride(tier3Surface, resolvedActorId);
  return { ...rawEnv, ...override };
}

type ToolExecutorLike = {
  execute(call: ChatToolCall): Promise<string>;
  listTools?: () => ChatToolDefinition[];
};

type TurnPersistenceStatus = {
  sessionUpdated: boolean;
  memoryStoreAttempted: boolean;
  memoryStored: boolean;
  postResponseCognitiveAttempted: boolean;
  postResponseCognitiveOk: boolean;
  degraded: boolean;
  providerDegraded?: boolean;
  providerDegradationReason?: string;
  errors: string[];
};

export type TurnRuntimeResult = {
  provider: string;
  model: string;
  timingMs: number;
  output: string;
  messages: ChatMessage[];
  haltReason?: string;
  usage?: TokenUsage;
  telemetry: RuntimeTelemetry;
  persistence: TurnPersistenceStatus;
};

export type TurnRuntimeInput = {
  input?: string;
  messages?: ChatMessage[];
  provider?: RuntimeProvider;
  llm?: LlmClient;
  providerLabel?: string;
  defaultModel?: string;
  model?: string;
  systemPrompt?: string;
  tools?: ChatToolDefinition[];
  toolExecutor?: ToolExecutorLike;
  loopLimits?: LoopLimits;
  memory?: MemoryClient;
  memoryUserId?: string;
  conversationId?: string;
  conversationContext?: ConversationContextService;
  cognitiveRuntimeEnabled?: boolean;
  surface: string;
  auditSurface?: string;
  rawEnv?: NodeJS.ProcessEnv;
  actorId?: string;
  sendReply?: (reply: string) => Promise<void>;
  persistSession?: (entry: {
    userText: string;
    assistantReply: string;
    messages: ChatMessage[];
  }) => Promise<void> | void;
  providerCascade?: { degraded: boolean; tier?: number; reason?: string };
};

type PreparedTurn = {
  messages: ChatMessage[];
  systemPrompt: string;
  originalUserText: string;
  sessionUserText: string;
  memoryUserText: string;
  classification?: InputRiskClassification;
  blockedCapabilities: string[];
};

type SurfaceToolPolicyResult = {
  toolExecutor?: ToolExecutor;
  blockedToolNames: string[];
};

function dedupeTools(
  localTools: ChatToolDefinition[],
  extraTools: ChatToolDefinition[],
): ChatToolDefinition[] {
  const merged = new Map<string, ChatToolDefinition>();
  for (const tool of localTools) merged.set(tool.name, tool);
  for (const tool of extraTools) {
    if (!merged.has(tool.name)) merged.set(tool.name, tool);
  }
  return Array.from(merged.values());
}

function normalizeToolExecutor(
  toolExecutor: ToolExecutorLike | undefined,
  explicitTools: ChatToolDefinition[] | undefined,
): ToolExecutor | undefined {
  const localTools = toolExecutor?.listTools?.() ?? [];
  const mergedTools = dedupeTools(localTools, explicitTools ?? []);
  if (!toolExecutor && mergedTools.length === 0) return undefined;

  const executableNames = new Set(localTools.map((tool) => tool.name));

  return {
    listTools: () => mergedTools,
    async execute(call: ChatToolCall): Promise<string> {
      if (!toolExecutor) {
        return JSON.stringify({
          error: `tool ${call.name} is not available in this runtime`,
        });
      }
      if (executableNames.size > 0 && !executableNames.has(call.name)) {
        return JSON.stringify({
          error: `tool ${call.name} is not available in this runtime`,
        });
      }
      return toolExecutor.execute(call);
    },
  };
}

function hardenToolExecutor(
  toolExecutor: ToolExecutor | undefined,
  surface: string,
): ToolExecutor | undefined {
  if (!toolExecutor) return undefined;

  return {
    listTools: () => toolExecutor.listTools(),
    async execute(call: ChatToolCall): Promise<string> {
      const output = await toolExecutor.execute(call);
      const assessment = inspectPromptFragment(output, 'tool_output');
      if (assessment.allowed) {
        return output;
      }

      await auditPromptFragmentAssessment(assessment, surface, {
        toolName: call.name,
        toolCallId: call.id,
      });
      return JSON.stringify({
        error: 'tool output blocked by security policy',
        blocked: true,
        tool: call.name,
        risk: assessment.risk,
        flags: assessment.flags,
      });
    },
  };
}

function constrainToolExecutorToSurface(
  toolExecutor: ToolExecutor | undefined,
  surfacePolicy: SurfacePolicy,
  surface: string,
): SurfaceToolPolicyResult {
  if (!toolExecutor) {
    return { toolExecutor: undefined, blockedToolNames: [] };
  }

  const declaredTools = toolExecutor.listTools();
  const allowedTools = declaredTools.filter((tool) => isToolAllowedForSurface(tool.name, surfacePolicy));
  const blockedToolNames = declaredTools
    .filter((tool) => !isToolAllowedForSurface(tool.name, surfacePolicy))
    .map((tool) => tool.name);
  const allowedNames = new Set(allowedTools.map((tool) => tool.name));

  return {
    blockedToolNames,
    toolExecutor: {
      listTools: () => allowedTools,
      async execute(call: ChatToolCall): Promise<string> {
        if (
          !isToolAllowedForSurface(call.name, surfacePolicy) ||
          (allowedNames.size > 0 && !allowedNames.has(call.name))
        ) {
          return JSON.stringify({
            error: 'tool blocked by surface policy',
            blocked: true,
            tool: call.name,
            surface,
            maxToolTier: surfacePolicy.maxToolTier,
          });
        }
        return toolExecutor.execute(call);
      },
    },
  };
}

function normalizeQueryText(value: string): string {
  return value
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function findLatestUserText(messages: ChatMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message?.role === 'user') return normalizeQueryText(message.content);
  }
  return '';
}

function updateFinalAssistantMessage(messages: ChatMessage[], reply: string): ChatMessage[] {
  const next = [...messages];
  for (let i = next.length - 1; i >= 0; i -= 1) {
    const message = next[i];
    if (message?.role !== 'assistant') continue;
    next[i] = { ...message, content: reply };
    break;
  }
  return next;
}

function trimConversationMessages(messages: ChatMessage[], limit: number | undefined): ChatMessage[] {
  if (!limit || messages.length <= limit) return [...messages];

  const hasSystemMessage = messages[0]?.role === 'system';
  const systemPrefix = hasSystemMessage ? [messages[0]!] : [];
  const tail = messages.slice(messages.length - limit);
  return hasSystemMessage ? [...systemPrefix, ...tail.filter((message) => message.role !== 'system')] : tail;
}

function buildEffectiveSystemPrompt(options: {
  baseSystemPrompt?: string;
  availableTools: string[];
  cognitiveContext?: string;
  recalledMemory: Array<{ content: string; score: number }>;
  sessionMemory?: string;
  compactions?: Array<{ summary: string; startSequence: number; endSequence: number }>;
  rawEnv?: NodeJS.ProcessEnv;
}): string {
  const base = options.baseSystemPrompt?.trim();
  const basePrompt = base
    ? base
    : buildRuntimeSystemPrompt({
        availableTools: options.availableTools,
        cognitiveContext: options.cognitiveContext,
        recalledMemory: options.recalledMemory,
        rawEnv: options.rawEnv,
      });

  const fragments: string[] = [];
  if (base && options.recalledMemory.length > 0) {
    fragments.push(buildRecalledMemoryFragment(options.recalledMemory));
  }
  if (options.sessionMemory && options.sessionMemory.trim().length > 0) {
    fragments.push(buildSessionMemoryFragment(options.sessionMemory));
  }
  if (options.compactions && options.compactions.length > 0) {
    const fragment = buildConversationCompactionFragment(options.compactions);
    if (fragment) fragments.push(fragment);
  }
  if (options.cognitiveContext && options.cognitiveContext.trim().length > 0) {
    fragments.push(buildCognitiveContextFragment(options.cognitiveContext));
  }

  return [basePrompt, ...fragments].filter(Boolean).join('\n\n');
}

async function prepareTextTurn(
  input: string,
  options: TurnRuntimeInput,
  availableTools: string[],
  classification: InputRiskClassification | undefined,
  surfacePolicy: SurfacePolicy,
  conversationOverlay?: ConversationPromptOverlay,
): Promise<PreparedTurn> {
  let recalledMemory: Array<{ content: string; score: number }> = [];
  let cognitiveContext = '';
  let fetchedBlocks = '';
  const blockedCapabilities: string[] = [];
  const highRisk = classification?.risk === 'high';

  try {
    if (options.memory && options.memoryUserId && input.trim().length > 0 && !highRisk) {
      if (!surfacePolicy.allowMemoryRecall) {
        blockedCapabilities.push('memory_recall_surface_policy_blocked');
      } else {
        const recalled = await options.memory.recall(options.memoryUserId, input, 5);
        const nextRecalledMemory: Array<{ content: string; score: number }> = [];
        for (const item of recalled.items) {
          const assessment = inspectPromptFragment(item.content, 'recalled_memory');
          if (!assessment.allowed) {
            blockedCapabilities.push('recalled_memory_blocked');
            await auditPromptFragmentAssessment(
              assessment,
              options.auditSurface ?? options.surface,
              {
                score: item.score ?? 0.5,
              },
            );
            continue;
          }
          nextRecalledMemory.push({
            content: item.content,
            score: item.score ?? 0.5,
          });
        }
        recalledMemory = nextRecalledMemory;
      }
    } else if (highRisk) {
      blockedCapabilities.push('memory_recall');
    }
  } catch (error) {
    log.warn({ err: error, surface: options.surface }, 'turn recall failed');
  }

  try {
    if (!surfacePolicy.allowUrlFetch) {
      if (/(https?:\/\/|www\.)/i.test(input)) {
        blockedCapabilities.push('url_fetch_surface_policy_blocked');
      }
    } else if (!highRisk) {
      const fetched = await fetchUrlsFromMessage(input);
      const allowedFetched = [];
      for (const item of fetched) {
        const assessment = inspectPromptFragment(item.content, 'fetched_content');
        if (!assessment.allowed) {
          blockedCapabilities.push('fetched_content_blocked');
          await auditPromptFragmentAssessment(assessment, options.auditSurface ?? options.surface, {
            url: item.url,
          });
          continue;
        }
        allowedFetched.push(item);
      }
      if (allowedFetched.length > 0) {
        fetchedBlocks = allowedFetched
          .map((item) => buildFetchedContentFragment(item.url, item.content))
          .join('\n\n');
      }
    } else {
      blockedCapabilities.push('url_fetch');
    }
  } catch (error) {
    log.warn({ err: error, surface: options.surface }, 'turn url fetch failed');
  }

  if (options.cognitiveRuntimeEnabled !== false && !highRisk) {
    if (!surfacePolicy.allowCognitivePrelude) {
      blockedCapabilities.push('cognitive_prelude_surface_policy_blocked');
    } else {
      try {
        const prelude = await prepareCognitivePrelude(input);
        cognitiveContext = prelude.promptFragment;
      } catch (error) {
        log.warn({ err: error, surface: options.surface }, 'turn cognitive prelude failed');
      }
    }
  } else if (highRisk) {
    blockedCapabilities.push('cognitive_prelude');
  }

  const wrappedUserInput = buildWrappedUserInput(
    input,
    classification ?? classifyUserInput(input),
  );
  const llmUserText = fetchedBlocks
    ? `${wrappedUserInput}\n\n${fetchedBlocks}`
    : wrappedUserInput;
  const sessionUserText = highRisk
    ? `[high-risk user input omitted hash=${classification?.contentHash}]`
    : llmUserText;

  return {
    messages: [...(options.messages ?? []), { role: 'user', content: llmUserText }],
    systemPrompt: buildEffectiveSystemPrompt({
      baseSystemPrompt: options.systemPrompt,
      availableTools,
      cognitiveContext,
      recalledMemory,
      sessionMemory: conversationOverlay?.sessionMemory,
      compactions: conversationOverlay?.compactions,
      rawEnv: options.rawEnv,
    }),
    originalUserText: input,
    sessionUserText,
    memoryUserText: highRisk ? '' : input,
    classification,
    blockedCapabilities,
  };
}

async function prepareMessagesTurn(
  messages: ChatMessage[],
  options: TurnRuntimeInput,
  availableTools: string[],
  classification: InputRiskClassification | undefined,
  surfacePolicy: SurfacePolicy,
  conversationOverlay?: ConversationPromptOverlay,
): Promise<PreparedTurn> {
  const originalUserText = findLatestUserText(messages);
  let memoryUserText = originalUserText;
  let recalledMemory: Array<{ content: string; score: number }> = [];
  let cognitiveContext = '';
  const blockedCapabilities: string[] = [];
  const highRisk = classification?.risk === 'high';

  if (originalUserText.length > 0) {
    if (highRisk) {
      memoryUserText = '';
    }

    try {
      if (options.memory && options.memoryUserId && !highRisk) {
        if (!surfacePolicy.allowMemoryRecall) {
          blockedCapabilities.push('memory_recall_surface_policy_blocked');
        } else {
          const recalled = await options.memory.recall(options.memoryUserId, originalUserText, 5);
          const nextRecalledMemory: Array<{ content: string; score: number }> = [];
          for (const item of recalled.items) {
            const assessment = inspectPromptFragment(item.content, 'recalled_memory');
            if (!assessment.allowed) {
              blockedCapabilities.push('recalled_memory_blocked');
              await auditPromptFragmentAssessment(
                assessment,
                options.auditSurface ?? options.surface,
                {
                  score: item.score ?? 0.5,
                },
              );
              continue;
            }
            nextRecalledMemory.push({
              content: item.content,
              score: item.score ?? 0.5,
            });
          }
          recalledMemory = nextRecalledMemory;
        }
      } else if (highRisk) {
        blockedCapabilities.push('memory_recall');
      }
    } catch (error) {
      log.warn({ err: error, surface: options.surface }, 'turn recall failed');
    }

    if (options.cognitiveRuntimeEnabled !== false && !highRisk) {
      if (!surfacePolicy.allowCognitivePrelude) {
        blockedCapabilities.push('cognitive_prelude_surface_policy_blocked');
      } else {
        try {
          const prelude = await prepareCognitivePrelude(originalUserText);
          cognitiveContext = prelude.promptFragment;
        } catch (error) {
          log.warn({ err: error, surface: options.surface }, 'turn cognitive prelude failed');
        }
      }
    } else if (highRisk) {
      blockedCapabilities.push('cognitive_prelude');
    }
  }

  return {
    messages: [...messages],
    systemPrompt: buildEffectiveSystemPrompt({
      baseSystemPrompt: options.systemPrompt,
      availableTools,
      cognitiveContext,
      recalledMemory,
      sessionMemory: conversationOverlay?.sessionMemory,
      compactions: conversationOverlay?.compactions,
      rawEnv: options.rawEnv,
    }),
    originalUserText,
    sessionUserText: highRisk
      ? `[high-risk user input omitted hash=${classification?.contentHash}]`
      : originalUserText,
    memoryUserText,
    classification,
    blockedCapabilities,
  };
}

function replaceLatestUserMessage(messages: ChatMessage[], content: string): ChatMessage[] {
  const next = [...messages];
  for (let i = next.length - 1; i >= 0; i -= 1) {
    const message = next[i];
    if (message?.role !== 'user') continue;
    next[i] = { ...message, content };
    break;
  }
  return next;
}

async function resolveInputClassification(
  options: TurnRuntimeInput,
): Promise<InputRiskClassification | undefined> {
  const candidate =
    typeof options.input === 'string' ? options.input : findLatestUserText(options.messages ?? []);
  if (!candidate.trim()) return undefined;

  const classification = classifyUserInput(candidate);
  const auditSurface = options.auditSurface ?? options.surface;
  await auditInputClassification(classification, auditSurface);
  if (classification.risk === 'high') {
    await emitRuntimeSecurityEvent({
      action: 'prompt.input.capabilities.degraded',
      status: 'blocked',
      details: {
        surface: auditSurface,
        risk: classification.risk,
        flags: classification.flags,
        contentHash: classification.contentHash,
      },
    });
  }
  return classification;
}

function resolveLlm(options: TurnRuntimeInput): {
  llm: LlmClient;
  provider: string;
  model: string;
} {
  if (options.provider) {
    return {
      llm: providerToLlmClient(options.provider, { model: options.model }),
      provider: options.provider.name,
      model: options.model ?? options.provider.defaultModel(),
    };
  }

  if (options.llm) {
    return {
      llm: options.llm,
      provider: options.providerLabel ?? 'provider',
      model: options.model ?? options.defaultModel ?? 'unknown',
    };
  }

  throw new Error('turn runtime requires provider or llm');
}

export async function runTurnRuntime(options: TurnRuntimeInput): Promise<TurnRuntimeResult> {
  const startedAt = Date.now();
  const classification = await resolveInputClassification(options);
  const auditSurface = options.auditSurface ?? options.surface;
  const rawEnvWithTier3 = applyTier3EnvOverride(
    options.rawEnv ?? process.env,
    options.surface,
    options.auditSurface,
    options.actorId,
  );
  const surfacePolicy = resolveSurfacePolicy(auditSurface, rawEnvWithTier3);
  const conversationOverlay =
    options.conversationContext && options.conversationId
      ? await options.conversationContext.getPromptOverlay(options.conversationId)
      : undefined;
  const rawToolExecutor = normalizeToolExecutor(options.toolExecutor, options.tools);
  const constrainedTools = constrainToolExecutorToSurface(rawToolExecutor, surfacePolicy, auditSurface);
  const highRisk = classification?.risk === 'high';
  const normalizedToolExecutor = highRisk
    ? undefined
    : hardenToolExecutor(constrainedTools.toolExecutor, auditSurface);
  const availableTools = normalizedToolExecutor?.listTools().map((tool) => tool.name) ?? [];
  const baseMessages = trimConversationMessages(
    options.messages ?? [],
    conversationOverlay?.trimRecentMessagesTo,
  );
  const prepared =
    typeof options.input === 'string'
      ? await prepareTextTurn(
          options.input,
          { ...options, messages: baseMessages },
          availableTools,
          classification,
          surfacePolicy,
          conversationOverlay,
        )
      : await prepareMessagesTurn(
          baseMessages,
          options,
          availableTools,
          classification,
          surfacePolicy,
          conversationOverlay,
        );
  if (constrainedTools.blockedToolNames.length > 0) {
    await emitRuntimeSecurityEvent({
      action: 'surface_policy.tools.blocked',
      status: 'blocked',
      details: {
        surface: auditSurface,
        blockedTools: constrainedTools.blockedToolNames,
        maxToolTier: surfacePolicy.maxToolTier,
      },
    });
  }
  const llm = resolveLlm(options);
  let result: Awaited<ReturnType<typeof runAgentLoop>>;
  try {
    result = await runAgentLoop({
      systemPrompt: prepared.systemPrompt,
      messages: prepared.messages,
      llm: llm.llm,
      toolExecutor: normalizedToolExecutor,
      loopLimits: options.loopLimits,
    });
  } catch (error) {
    metrics.recordProviderCall(llm.provider, false, Date.now() - startedAt);
    throw error;
  }
  metrics.recordProviderCall(llm.provider, true, Date.now() - startedAt);

  const guarded = await guardModelOutput(result.reply, options.auditSurface ?? options.surface);
  let messages = updateFinalAssistantMessage(result.messages, guarded.output);
  if (prepared.classification?.risk === 'high') {
    messages = replaceLatestUserMessage(messages, prepared.sessionUserText);
  }
  const persistence: TurnPersistenceStatus = {
    sessionUpdated: true,
    memoryStoreAttempted: false,
    memoryStored: false,
    postResponseCognitiveAttempted: false,
    postResponseCognitiveOk: false,
    degraded: false,
    errors: [],
  };
  if (prepared.blockedCapabilities.length > 0) {
    persistence.degraded = true;
    persistence.errors.push(...new Set(prepared.blockedCapabilities));
  }
  if (constrainedTools.blockedToolNames.length > 0) {
    persistence.degraded = true;
    persistence.errors.push('tools_surface_policy_blocked');
  }
  if (highRisk) {
    persistence.degraded = true;
    persistence.errors.push(
      ...new Set(['tools_blocked', ...prepared.blockedCapabilities, 'memory_store_blocked']),
    );
  }

  if (options.sendReply) {
    await options.sendReply(guarded.output);
  }

  if (options.persistSession) {
    try {
      await options.persistSession({
        userText: prepared.sessionUserText,
        assistantReply: guarded.output,
        messages,
      });
    } catch (error) {
      persistence.sessionUpdated = false;
      persistence.degraded = true;
      persistence.errors.push(error instanceof Error ? error.message : String(error));
    }
  }

  const trimmedMessages = Math.max(0, (options.messages ?? []).length - baseMessages.length);
  const buildTurnTelemetrySnapshot = (): RuntimeTelemetry =>
    buildRuntimeTelemetry({
      provider: llm.provider,
      model: llm.model,
      systemPrompt: prepared.systemPrompt,
      messages: prepared.messages,
      usage: result.usage,
      trimmedMessages,
      compactionCount: conversationOverlay?.compactions?.length ?? 0,
      degraded: options.providerCascade?.degraded === true || persistence.degraded,
      degradationReason:
        options.providerCascade?.reason ??
        (persistence.errors.length > 0 ? persistence.errors[0] : undefined),
    });

  if (options.conversationContext && options.conversationId && persistence.sessionUpdated) {
    try {
      await options.conversationContext.refreshConversation({
        conversationId: options.conversationId,
        actorId: options.memoryUserId,
        sourceSurface: auditSurface,
        telemetry: buildTurnTelemetrySnapshot(),
      });
    } catch (error) {
      persistence.degraded = true;
      persistence.errors.push(error instanceof Error ? error.message : String(error));
    }
  }

  if (!surfacePolicy.allowMemoryWrite) {
    if (options.memory && options.memoryUserId && prepared.memoryUserText.trim().length > 0) {
      persistence.degraded = true;
      persistence.errors.push('memory_store_surface_policy_blocked');
      await emitRuntimeSecurityEvent({
        action: 'surface_policy.memory_store.blocked',
        status: 'blocked',
        details: {
          surface: auditSurface,
          memoryUserId: options.memoryUserId,
        },
      });
    }
  } else if (options.memory && options.memoryUserId && prepared.memoryUserText.trim().length > 0) {
    const memoryStoreScan = scanContent(
      `${prepared.memoryUserText}\n${guarded.output}`,
      'memory',
    );
    if (!memoryStoreScan.allowed) {
      persistence.degraded = true;
      persistence.errors.push('memory_store_scanned_blocked');
      await emitRuntimeSecurityEvent({
        action: 'content_scan.memory_store.blocked',
        status: 'blocked',
        details: {
          surface: options.auditSurface ?? options.surface,
          patternId: memoryStoreScan.patternId,
          reason: memoryStoreScan.reason,
          contentHash: memoryStoreScan.contentHash,
        },
      });
    } else {
      persistence.memoryStoreAttempted = true;
      try {
        await options.memory.store(options.memoryUserId, prepared.memoryUserText, guarded.output);
        persistence.memoryStored = true;
      } catch (error) {
        persistence.degraded = true;
        persistence.errors.push(error instanceof Error ? error.message : String(error));
      }
    }
  }

  if (
    options.cognitiveRuntimeEnabled !== false &&
    prepared.originalUserText.trim().length > 0 &&
    prepared.classification?.risk !== 'high'
  ) {
    persistence.postResponseCognitiveAttempted = true;
    const postResponse = await runPostResponseCognitivePass({
      userText: prepared.originalUserText,
      assistantReply: guarded.output,
    });
    persistence.postResponseCognitiveOk = postResponse.ok;
    if (!postResponse.ok) {
      persistence.degraded = true;
      persistence.errors.push(postResponse.error);
    }
  }

  const telemetry = buildTurnTelemetrySnapshot();
  recordTurnTelemetry({
    surface: auditSurface,
    provider: llm.provider,
    model: llm.model,
    telemetry,
  });

  return {
    provider: llm.provider,
    model: llm.model,
    timingMs: Date.now() - startedAt,
    output: guarded.output,
    messages,
    haltReason: result.haltReason,
    usage: result.usage,
    telemetry,
    persistence,
  };
}
