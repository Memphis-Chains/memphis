/**
 * Chat gateway agent loop.
 *
 * Handles incoming messages from channels (Telegram, Discord, terminal),
 * runs a tool-calling loop via Memphis Provider.chat(), and sends replies.
 *
 * Loop enforcement: Rust soul_loop_step() via NAPI (authoritative).
 * Fallback: TypeScript enforcement when Rust bridge is not loaded.
 *
 * All LLM calls go through Memphis providers — audited, chained, fallback-aware.
 */

import pino from 'pino';

import type {
  ChannelAdapter,
  ChatGatewayConfig,
  IncomingMessage,
  LoopLimits,
  LoopState,
  MemoryClient,
  SessionStore,
} from './chat-types.js';
import {
  buildSystemPrompt as buildMemphisSystemPrompt,
  buildRecalledMemoryFragment,
  buildFetchedContentFragment,
} from './system-prompt.js';
import { fetchUrlsFromMessage } from './url-extract.js';
import { appendBlock } from '../infra/storage/chain-adapter.js';
import {
  NapiChainAdapter,
  type SoulLoopAction,
  type SoulLoopLimits,
  type SoulLoopState,
  type SoulLoopStepResult,
} from '../infra/storage/rust-chain-adapter.js';
import type { ChatMessage } from '../providers/index.js';

const log = pino({ level: process.env.LOG_LEVEL ?? 'info' });

const DEFAULT_LIMITS: LoopLimits = {
  max_steps: 32,
  max_tool_calls: 16,
  max_wait_ms: 120_000,
  max_errors: 4,
};

// ─── Loop enforcement ───────────────────────────────────────────

let _rustAdapter: NapiChainAdapter | null = null;
let _rustChecked = false;

function getRustAdapter(): NapiChainAdapter | null {
  if (!_rustChecked) {
    _rustChecked = true;
    try {
      const adapter = new NapiChainAdapter();
      // Probe if soul_loop_step is available
      adapter.soulLoopStep(
        { steps: 0, tool_calls: 0, wait_ms: 0, errors: 0, completed: false, halt_reason: null },
        { type: 'complete', data: { summary: 'probe' } },
      );
      _rustAdapter = adapter;
      log.info('rust loop engine connected');
    } catch {
      log.info('rust loop engine unavailable — using TypeScript fallback');
    }
  }
  return _rustAdapter;
}

function applyLoopStep(
  state: LoopState,
  action: SoulLoopAction,
  limits: LoopLimits,
): { applied: boolean; reason?: string; state: LoopState } {
  const rustAdapter = getRustAdapter();

  // Layer 1: Rust authoritative enforcement via NAPI
  if (rustAdapter) {
    try {
      const result: SoulLoopStepResult = rustAdapter.soulLoopStep(
        state as SoulLoopState,
        action,
        limits as SoulLoopLimits,
      );
      return { applied: result.applied, reason: result.reason, state: result.state };
    } catch (err) {
      log.warn({ err }, 'rust loop step failed — falling back to TS');
    }
  }

  // Layer 2: TypeScript fallback
  const s = { ...state };
  s.steps += 1;

  if (s.steps > limits.max_steps) {
    s.halt_reason = 'max_steps_exceeded';
    return { applied: false, reason: 'max_steps_exceeded', state: s };
  }

  if (action.type === 'tool_call') {
    s.tool_calls += 1;
    if (s.tool_calls > limits.max_tool_calls) {
      s.halt_reason = 'max_tool_calls_exceeded';
      return { applied: false, reason: 'max_tool_calls_exceeded', state: s };
    }
  } else if (action.type === 'error') {
    s.errors += 1;
    if (s.errors > limits.max_errors) {
      s.halt_reason = 'max_errors_exceeded';
      return { applied: false, reason: 'max_errors_exceeded', state: s };
    }
    if (action.data.recoverable === false) {
      s.completed = true;
      s.halt_reason = 'non_recoverable_error';
    }
  } else if (action.type === 'complete') {
    s.completed = true;
  }

  return { applied: true, state: s };
}

// ─── Audit trail ────────────────────────────────────────────────

async function auditLlmCall(provider: string, toolCallCount: number): Promise<void> {
  try {
    await appendBlock('system', {
      type: 'tool_call',
      content: `LLM call via ${provider}`,
      tags: ['audit', 'llm-call'],
      source: 'gateway',
      provider,
      tool_calls_returned: toolCallCount,
      timestamp: new Date().toISOString(),
    });
  } catch {
    // Audit is best-effort — don't break the chat loop
  }
}

// ─── Session fallback ───────────────────────────────────────────

const fallbackSessions = new Map<string, ChatMessage[]>();
const fallbackSessionStore: SessionStore = {
  get(chatId: string): ChatMessage[] {
    if (!fallbackSessions.has(chatId)) fallbackSessions.set(chatId, []);
    return fallbackSessions.get(chatId)!;
  },
  append(chatId: string, userText: string, assistantReply: string): void {
    const history = this.get(chatId);
    history.push({ role: 'user', content: userText });
    history.push({ role: 'assistant', content: assistantReply });
    if (history.length > 20) history.splice(0, history.length - 20);
  },
};

// ─── System prompt ──────────────────────────────────────────────

function buildSystemPrompt(
  config: ChatGatewayConfig,
  context: Awaited<ReturnType<MemoryClient['recall']>>,
): string {
  // Build the full Memphis system prompt with tool-use instructions
  const toolNames = config.toolExecutor?.listTools().map((t) => t.name) ?? [];
  const rustAvailable = !!getRustAdapter();

  const base = buildMemphisSystemPrompt({
    rustBridgeActive: rustAvailable,
    availableTools: toolNames,
    userIdentity: config.systemPrompt ? undefined : undefined,
    safeMode: process.env.MEMPHIS_SAFE_MODE === 'true',
    strictMode: process.env.RUST_CHAIN_REQUIRE_SIGNATURES === 'true',
    agentName: process.env.MEMPHIS_AGENT_NAME,
    ownerName: process.env.MEMPHIS_OWNER_NAME,
  });

  // Append recalled memory as structured fragment
  const memoryFragment =
    context.items.length > 0
      ? buildRecalledMemoryFragment(
          context.items.map((item) => ({
            content: item.content,
            score: item.score ?? 0.5,
          })),
        )
      : '';

  return memoryFragment ? `${base}\n\n${memoryFragment}` : base;
}

// ─── Tool-calling loop ──────────────────────────────────────────

function newLoopState(): LoopState {
  return { steps: 0, tool_calls: 0, wait_ms: 0, errors: 0, completed: false, halt_reason: null };
}

/**
 * Run the tool-calling agent loop.
 *
 * Loop enforcement goes through Rust soul_loop_step() (NAPI) when available.
 * Every LLM call is audited to the system chain.
 */
async function runToolLoop(
  systemPrompt: string,
  messages: ChatMessage[],
  config: ChatGatewayConfig,
): Promise<string> {
  const toolExecutor = config.toolExecutor;
  const tools = toolExecutor?.listTools() ?? [];
  const limits = config.loopLimits ?? DEFAULT_LIMITS;
  let state = newLoopState();

  const workingMessages = [...messages];

  for (;;) {
    const response = await config.llm.complete({
      system: systemPrompt,
      messages: workingMessages,
      tools: tools.length > 0 ? tools : undefined,
    });

    // Audit every LLM call to system chain
    void auditLlmCall('provider', response.tool_calls?.length ?? 0);

    // No tool calls — return final text
    if (!response.tool_calls?.length) {
      return response.content;
    }

    // Process tool calls
    const assistantMsg: ChatMessage = {
      role: 'assistant',
      content: response.content,
      tool_calls: response.tool_calls,
    };
    workingMessages.push(assistantMsg);

    let halted = false;

    for (const tc of response.tool_calls) {
      // Rust-enforced loop limits
      const step = applyLoopStep(state, { type: 'tool_call', data: { tool: tc.name } }, limits);
      state = step.state;

      if (!step.applied) {
        log.warn({ reason: step.reason, tool: tc.name, state }, 'loop limit hit');
        halted = true;
        break;
      }

      let result: string;
      try {
        if (!toolExecutor) {
          result = JSON.stringify({ error: 'no tool executor configured' });
        } else {
          result = await toolExecutor.execute(tc);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.error({ tool: tc.name, err: msg }, 'tool execution failed');
        result = JSON.stringify({ error: msg });

        // Track error via Rust loop engine
        const errStep = applyLoopStep(
          state,
          { type: 'error', data: { recoverable: true, message: msg } },
          limits,
        );
        state = errStep.state;

        if (!errStep.applied) {
          log.warn({ reason: errStep.reason, state }, 'error limit hit');
          halted = true;
          break;
        }
      }

      workingMessages.push({ role: 'tool', tool_call_id: tc.id, content: result });
      log.info({ tool: tc.name, resultLen: result.length }, 'tool executed');
    }

    if (halted) {
      if (response.content) return response.content;
      return `I've reached my tool call limit (${state.halt_reason}). Here's what I gathered so far — please ask me to continue if needed.`;
    }
  }
}

// ─── Message handler ────────────────────────────────────────────

export async function handleMessage(
  message: IncomingMessage,
  config: ChatGatewayConfig,
  adapterMap: Map<string, ChannelAdapter>,
): Promise<void> {
  // Context fetch is best-effort — don't block the user if recall/fetch fails
  let context: Awaited<ReturnType<MemoryClient['recall']>> = { items: [] };
  let fetched: Awaited<ReturnType<typeof fetchUrlsFromMessage>> = [];

  try {
    [context, fetched] = await Promise.all([
      config.memory.recall(message.userId, message.text, 5),
      fetchUrlsFromMessage(message.text),
    ]);
  } catch (err) {
    log.warn({ err, userId: message.userId }, 'context fetch failed — continuing without recall/fetch');
  }

  log.info(
    { urls: fetched.length, recall: context.items.length, userId: message.userId },
    'message context',
  );

  const systemPrompt = buildSystemPrompt(config, context);

  // Append fetched URL content with structured boundary markers
  let userContent = message.text;
  if (fetched.length > 0) {
    const fetchedBlock = fetched
      .map((f) => buildFetchedContentFragment(f.url, f.content))
      .join('\n\n');
    userContent = `${message.text}\n\n${fetchedBlock}`;
  }

  const sessions = config.sessions ?? fallbackSessionStore;
  const history = sessions.get(message.chatId);
  const messages: ChatMessage[] = [...history, { role: 'user', content: userContent }];

  const reply = await runToolLoop(systemPrompt, messages, config);

  // Send reply first — storage failures should not block the user
  const adapter = adapterMap.get(message.channel);
  if (adapter) {
    await adapter.send(message.chatId, reply);
  }

  // Store session and memory (best-effort)
  try {
    sessions.append(message.chatId, message.text, reply, message.channel);
    await config.memory.store(message.userId, message.text, reply);
  } catch (err) {
    log.warn({ err, userId: message.userId }, 'session/memory store failed (non-fatal)');
  }
}

export { newLoopState };

// ─── Gateway lifecycle ──────────────────────────────────────────

export type GatewayHandle = {
  stop(): Promise<void>;
};

export async function startGateway(config: ChatGatewayConfig): Promise<GatewayHandle> {
  const adapterMap = new Map<string, ChannelAdapter>(
    config.adapters.map((adapter) => [adapter.name, adapter]),
  );

  await Promise.all(
    config.adapters.map((adapter) =>
      adapter.start((message) => handleMessage(message, config, adapterMap)),
    ),
  );

  return {
    async stop() {
      await Promise.all(config.adapters.map((adapter) => adapter.stop()));
    },
  };
}
