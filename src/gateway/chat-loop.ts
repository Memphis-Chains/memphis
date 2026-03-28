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

import { newLoopState } from './agent-runtime.js';
import type {
  ChannelAdapter,
  ChatGatewayConfig,
  IncomingMessage,
  SessionStore,
} from './chat-types.js';
import { runTurnRuntime } from './turn-runtime.js';
import { createPinoLogger } from '../infra/logging/pino.js';
import type { ChatMessage } from '../providers/index.js';

const log = createPinoLogger({ level: process.env.LOG_LEVEL ?? 'info' });

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
  const sessions = config.sessions ?? fallbackSessionStore;
  const history = sessions.get(message.chatId);
  const adapter = adapterMap.get(message.channel);
  const result = await runTurnRuntime({
    input: message.text,
    messages: history,
    llm: config.llm,
    memory: config.memory,
    memoryUserId: message.userId,
    systemPrompt: config.systemPrompt,
    toolExecutor: config.toolExecutor,
    loopLimits: config.loopLimits,
    surface: 'gateway',
    auditSurface: message.channel,
    sendReply: adapter ? (reply) => adapter.send(message.chatId, reply) : undefined,
    persistSession: ({ userText, assistantReply }) => {
      sessions.append(message.chatId, userText, assistantReply, message.channel);
    },
  });

  if (result.persistence.degraded) {
    log.warn(
      {
        userId: message.userId,
        surface: message.channel,
        errors: result.persistence.errors,
      },
      'gateway turn persistence degraded',
    );
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
