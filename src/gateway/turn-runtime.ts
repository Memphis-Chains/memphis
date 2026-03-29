import { buildRuntimeSystemPrompt, runAgentLoop } from './agent-runtime.js';
import type { LlmClient, LoopLimits, MemoryClient, ToolExecutor } from './chat-types.js';
import {
  prepareCognitivePrelude,
  runPostResponseCognitivePass,
} from './cognitive-runtime.js';
import {
  auditInputClassification,
  buildWrappedUserInput,
  classifyUserInput,
  guardModelOutput,
} from './prompt-boundary.js';
import { providerToLlmClient } from './provider-adapter.js';
import {
  buildCognitiveContextFragment,
  buildFetchedContentFragment,
  buildRecalledMemoryFragment,
} from './system-prompt.js';
import { fetchUrlsFromMessage } from './url-extract.js';
import { metrics } from '../infra/logging/metrics.js';
import { createPinoLogger } from '../infra/logging/pino.js';
import type { ChatMessage, ChatToolCall, ChatToolDefinition } from '../providers/index.js';
import type { RuntimeProvider } from '../providers/runtime.js';

const log = createPinoLogger({ level: process.env.LOG_LEVEL ?? 'info' });

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
  cognitiveRuntimeEnabled?: boolean;
  surface: string;
  auditSurface?: string;
  rawEnv?: NodeJS.ProcessEnv;
  sendReply?: (reply: string) => Promise<void>;
  persistSession?: (entry: {
    userText: string;
    assistantReply: string;
    messages: ChatMessage[];
  }) => Promise<void> | void;
  providerCascade?: { degraded: boolean; tier: number; reason?: string };
};

type PreparedTurn = {
  messages: ChatMessage[];
  systemPrompt: string;
  originalUserText: string;
  sessionUserText: string;
  memoryUserText: string;
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

function buildEffectiveSystemPrompt(options: {
  baseSystemPrompt?: string;
  availableTools: string[];
  cognitiveContext?: string;
  recalledMemory: Array<{ content: string; score: number }>;
  rawEnv?: NodeJS.ProcessEnv;
}): string {
  const base = options.baseSystemPrompt?.trim();
  if (!base) {
    return buildRuntimeSystemPrompt({
      availableTools: options.availableTools,
      cognitiveContext: options.cognitiveContext,
      recalledMemory: options.recalledMemory,
      rawEnv: options.rawEnv,
    });
  }

  const fragments: string[] = [];
  if (options.recalledMemory.length > 0) {
    fragments.push(buildRecalledMemoryFragment(options.recalledMemory));
  }
  if (options.cognitiveContext && options.cognitiveContext.trim().length > 0) {
    fragments.push(buildCognitiveContextFragment(options.cognitiveContext));
  }

  return [base, ...fragments].filter(Boolean).join('\n\n');
}

async function prepareTextTurn(
  input: string,
  options: TurnRuntimeInput,
  availableTools: string[],
): Promise<PreparedTurn> {
  const classification = classifyUserInput(input);
  const auditSurface = options.auditSurface ?? options.surface;
  await auditInputClassification(classification, auditSurface);

  let recalledMemory: Array<{ content: string; score: number }> = [];
  let cognitiveContext = '';
  let fetchedBlocks = '';

  try {
    if (options.memory && options.memoryUserId && input.trim().length > 0) {
      const recalled = await options.memory.recall(options.memoryUserId, input, 5);
      recalledMemory = recalled.items.map((item) => ({
        content: item.content,
        score: item.score ?? 0.5,
      }));
    }
  } catch (error) {
    log.warn({ err: error, surface: options.surface }, 'turn recall failed');
  }

  try {
    const fetched = await fetchUrlsFromMessage(input);
    if (fetched.length > 0) {
      fetchedBlocks = fetched
        .map((item) => buildFetchedContentFragment(item.url, item.content))
        .join('\n\n');
    }
  } catch (error) {
    log.warn({ err: error, surface: options.surface }, 'turn url fetch failed');
  }

  if (options.cognitiveRuntimeEnabled !== false) {
    try {
      const prelude = await prepareCognitivePrelude(input);
      cognitiveContext = prelude.promptFragment;
    } catch (error) {
      log.warn({ err: error, surface: options.surface }, 'turn cognitive prelude failed');
    }
  }

  const wrappedUserInput = buildWrappedUserInput(input, classification);
  const sessionUserText = fetchedBlocks
    ? `${wrappedUserInput}\n\n${fetchedBlocks}`
    : wrappedUserInput;

  return {
    messages: [...(options.messages ?? []), { role: 'user', content: sessionUserText }],
    systemPrompt: buildEffectiveSystemPrompt({
      baseSystemPrompt: options.systemPrompt,
      availableTools,
      cognitiveContext,
      recalledMemory,
      rawEnv: options.rawEnv,
    }),
    originalUserText: input,
    sessionUserText,
    memoryUserText:
      classification.risk === 'high'
        ? `[high-risk user input omitted hash=${classification.contentHash}]`
        : input,
  };
}

async function prepareMessagesTurn(
  messages: ChatMessage[],
  options: TurnRuntimeInput,
  availableTools: string[],
): Promise<PreparedTurn> {
  const originalUserText = findLatestUserText(messages);
  let memoryUserText = originalUserText;
  let recalledMemory: Array<{ content: string; score: number }> = [];
  let cognitiveContext = '';

  if (originalUserText.length > 0) {
    const classification = classifyUserInput(originalUserText);
    const auditSurface = options.auditSurface ?? options.surface;
    await auditInputClassification(classification, auditSurface);
    if (classification.risk === 'high') {
      memoryUserText = `[high-risk user input omitted hash=${classification.contentHash}]`;
    }

    try {
      if (options.memory && options.memoryUserId) {
        const recalled = await options.memory.recall(options.memoryUserId, originalUserText, 5);
        recalledMemory = recalled.items.map((item) => ({
          content: item.content,
          score: item.score ?? 0.5,
        }));
      }
    } catch (error) {
      log.warn({ err: error, surface: options.surface }, 'turn recall failed');
    }

    if (options.cognitiveRuntimeEnabled !== false) {
      try {
        const prelude = await prepareCognitivePrelude(originalUserText);
        cognitiveContext = prelude.promptFragment;
      } catch (error) {
        log.warn({ err: error, surface: options.surface }, 'turn cognitive prelude failed');
      }
    }
  }

  return {
    messages: [...messages],
    systemPrompt: buildEffectiveSystemPrompt({
      baseSystemPrompt: options.systemPrompt,
      availableTools,
      cognitiveContext,
      recalledMemory,
      rawEnv: options.rawEnv,
    }),
    originalUserText,
    sessionUserText: originalUserText,
    memoryUserText,
  };
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
  const normalizedToolExecutor = normalizeToolExecutor(options.toolExecutor, options.tools);
  const availableTools = normalizedToolExecutor?.listTools().map((tool) => tool.name) ?? [];
  const prepared =
    typeof options.input === 'string'
      ? await prepareTextTurn(options.input, options, availableTools)
      : await prepareMessagesTurn(options.messages ?? [], options, availableTools);
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
  const messages = updateFinalAssistantMessage(result.messages, guarded.output);
  const persistence: TurnPersistenceStatus = {
    sessionUpdated: true,
    memoryStoreAttempted: false,
    memoryStored: false,
    postResponseCognitiveAttempted: false,
    postResponseCognitiveOk: false,
    degraded: false,
    errors: [],
  };

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

  if (options.memory && options.memoryUserId && prepared.memoryUserText.trim().length > 0) {
    persistence.memoryStoreAttempted = true;
    try {
      await options.memory.store(options.memoryUserId, prepared.memoryUserText, guarded.output);
      persistence.memoryStored = true;
    } catch (error) {
      persistence.degraded = true;
      persistence.errors.push(error instanceof Error ? error.message : String(error));
    }
  }

  if (options.cognitiveRuntimeEnabled !== false && prepared.originalUserText.trim().length > 0) {
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

  return {
    provider: llm.provider,
    model: llm.model,
    timingMs: Date.now() - startedAt,
    output: guarded.output,
    messages,
    haltReason: result.haltReason,
    persistence,
  };
}
