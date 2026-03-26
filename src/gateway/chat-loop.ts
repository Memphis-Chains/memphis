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

import { buildRuntimeSystemPrompt, runAgentLoop, newLoopState } from './agent-runtime.js';
import type {
  ChannelAdapter,
  ChatGatewayConfig,
  IncomingMessage,
  MemoryClient,
  SessionStore,
} from './chat-types.js';
import {
  auditInputClassification,
  buildWrappedUserInput,
  classifyUserInput,
  guardModelOutput,
} from './prompt-boundary.js';
import { buildFetchedContentFragment } from './system-prompt.js';
import { fetchUrlsFromMessage } from './url-extract.js';
import type { ChatMessage } from '../providers/index.js';

const log = pino({ level: process.env.LOG_LEVEL ?? 'info' });

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
    log.warn(
      { err, userId: message.userId },
      'context fetch failed — continuing without recall/fetch',
    );
  }

  log.info(
    { urls: fetched.length, recall: context.items.length, userId: message.userId },
    'message context',
  );

  const inputClassification = classifyUserInput(message.text);
  await auditInputClassification(inputClassification, message.channel);

  const systemPrompt = buildRuntimeSystemPrompt({
    availableTools: config.toolExecutor?.listTools().map((tool) => tool.name) ?? [],
    recalledMemory: context.items.map((item) => ({
      content: item.content,
      score: item.score ?? 0.5,
    })),
  });

  // Append fetched URL content with structured boundary markers
  let userContent = buildWrappedUserInput(message.text, inputClassification);
  if (fetched.length > 0) {
    const fetchedBlock = fetched
      .map((f) => buildFetchedContentFragment(f.url, f.content))
      .join('\n\n');
    userContent = `${message.text}\n\n${fetchedBlock}`;
  }

  const sessions = config.sessions ?? fallbackSessionStore;
  const history = sessions.get(message.chatId);
  const messages: ChatMessage[] = [...history, { role: 'user', content: userContent }];

  const rawReply = (
    await runAgentLoop({
      systemPrompt,
      messages,
      llm: config.llm,
      toolExecutor: config.toolExecutor,
      loopLimits: config.loopLimits,
    })
  ).reply;
  const guardedReply = await guardModelOutput(rawReply, message.channel);
  const reply = guardedReply.output;

  // Send reply first — storage failures should not block the user
  const adapter = adapterMap.get(message.channel);
  if (adapter) {
    await adapter.send(message.chatId, reply);
  }

  // Store session and memory (best-effort)
  try {
    sessions.append(message.chatId, userContent, reply, message.channel);
    const memoryUserText =
      inputClassification.risk === 'high'
        ? `[high-risk user input omitted hash=${inputClassification.contentHash}]`
        : message.text;
    await config.memory.store(message.userId, memoryUserText, reply);
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
