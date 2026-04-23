/**
 * Gateway-specific types for the chat gateway.
 *
 * LLM types (ChatMessage, ChatToolDefinition, ChatToolCall, ChatResponse)
 * are imported from src/providers/index.ts — no duplication.
 */

import type { ConversationContextService } from './conversation-context-service.js';
import type { TokenUsage } from '../core/types.js';
import type { RecallMode } from '../mcp/tools/recall.js';
import type { ChatMessage, ChatToolDefinition, ChatToolCall } from '../providers/index.js';

export type ChannelName = 'telegram' | 'discord' | 'terminal';

export type IncomingMessage = {
  id: string;
  channel: ChannelName;
  userId: string;
  chatId: string;
  actorId?: string;
  conversationId?: string;
  replyTargetId?: string;
  text: string;
  timestamp: Date;
  /** Per-session env overrides (e.g. tier elevation from /tier command). */
  rawEnvOverride?: Record<string, string>;
  /** Appended to the base system prompt for this turn only (e.g. startup context on first message). */
  systemPromptAppend?: string;
};

export type MessageHandler = (message: IncomingMessage) => Promise<void>;

export type ChannelAdapter = {
  readonly name: ChannelName;
  start(handler: MessageHandler): Promise<void>;
  send(chatId: string, text: string): Promise<void>;
  stop(): Promise<void>;
};

export type RecalledContext = {
  items: Array<{ content: string; score: number }>;
  mode?: RecallMode;
  degraded?: boolean;
  warning?: string;
};

export type MemoryStoreBinding = {
  /** Turn-runtime turn UUID (per-turn identifier). */
  turnId?: string;
  /**
   * Conversation-level identifier that groups multiple turns. Passed
   * through to `storeDurableMemory` so the trajectory exporter can
   * bucket related turns into a single multi-event trajectory (N8.2).
   */
  conversationId?: string;
  /** Optional session identifier (operator ask-session slot, workspace). */
  sessionId?: string;
};

export type MemoryClient = {
  recall(userId: string, query: string, limit?: number): Promise<RecalledContext>;
  store(
    userId: string,
    userText: string,
    assistantReply: string,
    binding?: MemoryStoreBinding,
  ): Promise<void>;
  isAvailable(): boolean;
};

// Re-export as gateway-compatible aliases
export type LlmMessage = ChatMessage;
export type ToolDefinition = ChatToolDefinition;
export type ToolCall = ChatToolCall;

export type LlmResponse = {
  content: string;
  tool_calls?: ChatToolCall[];
  usage?: TokenUsage;
};

export type LlmClient = {
  complete(input: {
    system: string;
    messages: ChatMessage[];
    tools?: ChatToolDefinition[];
    /**
     * Per-call generation tuning override. When supplied, the underlying
     * provider call must use these instead of any defaults baked into the
     * client at construction. Used by cognitive-mode dispatch to apply
     * mode-specific temperature/maxTokens (Codex P1 fix on PR #81).
     */
    temperature?: number;
    maxTokens?: number;
  }): Promise<LlmResponse>;
};

export type ToolExecutor = {
  execute(call: ChatToolCall): Promise<string>;
  listTools(): ChatToolDefinition[];
  maxParallel?: number;
  /**
   * Produce a new executor bound to a specific conversation / session
   * context. Used by turn-runtime to stamp tool-emitted writes with
   * the same `conversation_id` / `session_id` as the surrounding
   * memory-client writes (N8.2). Returning `this` is a valid no-op
   * for executors that don't care about session binding.
   *
   * Shape matches the `MemoryStoreBinding` contract so turn-runtime
   * can pass the same object to both paths without conversion.
   */
  withBinding?(binding: MemoryStoreBinding): ToolExecutor;
};

export type LoopLimits = {
  max_steps: number;
  max_tool_calls: number;
  max_wait_ms: number;
  max_errors: number;
};

export type LoopState = {
  steps: number;
  tool_calls: number;
  wait_ms: number;
  errors: number;
  completed: boolean;
  halt_reason: string | null;
};

export type SessionMetadata = {
  channel?: ChannelName;
  actorId?: string;
  conversationId?: string;
  replyTargetId?: string;
};

export type SessionStore = {
  get(conversationId: string): ChatMessage[];
  append(
    conversationId: string,
    userText: string,
    assistantReply: string,
    metadata?: SessionMetadata,
  ): void;
};

export type ChatGatewayConfig = {
  adapters: ChannelAdapter[];
  memory: MemoryClient;
  llm: LlmClient;
  systemPrompt?: string;
  toolExecutor?: ToolExecutor;
  loopLimits?: LoopLimits;
  sessions?: SessionStore;
  conversationContext?: ConversationContextService;
};
