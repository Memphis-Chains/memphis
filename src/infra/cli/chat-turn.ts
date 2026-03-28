import type { MemoryClient } from '../../gateway/chat-types.js';
import { runTurnRuntime } from '../../gateway/turn-runtime.js';
import type { ChatMessage, ChatToolCall, ChatToolDefinition } from '../../providers/index.js';
import type { RuntimeProvider } from '../../providers/runtime.js';

export type ChatState = {
  cognitiveRuntimeEnabled?: boolean;
  provider: RuntimeProvider;
  userId?: string;
  memory?: MemoryClient;
  model?: string;
  systemPrompt?: string;
  tools?: ChatToolDefinition[];
  toolExecutor?: (call: ChatToolCall) => Promise<string>;
  messages: ChatMessage[];
};

const MAX_MESSAGES = 40;

function trimMessages(messages: ChatMessage[]): void {
  while (messages.length > MAX_MESSAGES + 1) {
    const idx = messages[0]?.role === 'system' ? 1 : 0;
    messages.splice(idx, 1);
  }
}

export type ChatTurnResult = {
  provider: string;
  model: string;
  timingMs: number;
  output: string;
};

export async function runChatTurn(state: ChatState, input: string): Promise<ChatTurnResult> {
  const startedAt = Date.now();
  trimMessages(state.messages);
  try {
    const result = await runTurnRuntime({
      input,
      messages: state.messages,
      provider: state.provider,
      model: state.model,
      memory: state.memory,
      memoryUserId: state.userId,
      systemPrompt: state.systemPrompt,
      tools: state.tools,
      toolExecutor: state.toolExecutor
        ? { listTools: () => state.tools ?? [], execute: state.toolExecutor }
        : undefined,
      cognitiveRuntimeEnabled: state.cognitiveRuntimeEnabled,
      surface: 'cli.chat',
    });

    state.messages = result.messages;
    trimMessages(state.messages);
    return {
      provider: result.provider,
      model: result.model,
      timingMs: result.timingMs,
      output: result.output,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      provider: state.provider.name,
      model: state.model ?? state.provider.defaultModel(),
      timingMs: Date.now() - startedAt,
      output: `error: ${message}`,
    };
  }
}

export async function runChatOnce(state: ChatState, input: string): Promise<string> {
  const result = await runChatTurn(state, input);
  return `[provider=${result.provider} model=${result.model} timing=${result.timingMs}ms]\n${result.output}`;
}
