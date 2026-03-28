/**
 * Gateway-specific types for the chat gateway.
 *
 * LLM types (ChatMessage, ChatToolDefinition, ChatToolCall, ChatResponse)
 * are imported from src/providers/index.ts — no duplication.
 */

import type { RecallMode } from '../mcp/tools/recall.js';
import type { ChatMessage, ChatToolDefinition, ChatToolCall } from '../providers/index.js';

export type ChannelName = 'telegram' | 'discord' | 'terminal';

export type IncomingMessage = {
  id: string;
  channel: ChannelName;
  userId: string;
  chatId: string;
  text: string;
  timestamp: Date;
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

export type MemoryClient = {
  recall(userId: string, query: string, limit?: number): Promise<RecalledContext>;
  store(userId: string, userText: string, assistantReply: string): Promise<void>;
  isAvailable(): boolean;
};

// Re-export as gateway-compatible aliases
export type LlmMessage = ChatMessage;
export type ToolDefinition = ChatToolDefinition;
export type ToolCall = ChatToolCall;

export type LlmResponse = {
  content: string;
  tool_calls?: ChatToolCall[];
};

export type LlmClient = {
  complete(input: {
    system: string;
    messages: ChatMessage[];
    tools?: ChatToolDefinition[];
  }): Promise<LlmResponse>;
};

export type ToolExecutor = {
  execute(call: ChatToolCall): Promise<string>;
  listTools(): ChatToolDefinition[];
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

export type SessionStore = {
  get(chatId: string): ChatMessage[];
  append(chatId: string, userText: string, assistantReply: string, channel?: string): void;
};

export type ChatGatewayConfig = {
  adapters: ChannelAdapter[];
  memory: MemoryClient;
  llm: LlmClient;
  systemPrompt?: string;
  toolExecutor?: ToolExecutor;
  loopLimits?: LoopLimits;
  sessions?: SessionStore;
};
