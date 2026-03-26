import { runAgentLoop } from '../../gateway/agent-runtime.js';
import { providerToLlmClient } from '../../gateway/provider-adapter.js';
import type { ChatMessage, ChatToolCall, ChatToolDefinition } from '../../providers/index.js';
import type { RuntimeProvider } from '../../providers/runtime.js';

export type ChatState = {
  provider: RuntimeProvider;
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
  const t0 = Date.now();
  const toolExecutor =
    state.toolExecutor && state.tools
      ? { listTools: () => state.tools ?? [], execute: state.toolExecutor }
      : undefined;
  const messages = [...state.messages, { role: 'user', content: input } as const];
  trimMessages(messages);

  try {
    const result = await runAgentLoop({
      systemPrompt: state.systemPrompt ?? '',
      messages,
      llm: providerToLlmClient(state.provider, { model: state.model }),
      toolExecutor,
    });

    state.messages = result.messages;
    trimMessages(state.messages);
    return {
      provider: state.provider.name,
      model: state.model ?? state.provider.defaultModel(),
      timingMs: Date.now() - t0,
      output: result.reply,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      provider: state.provider.name,
      model: state.model ?? state.provider.defaultModel(),
      timingMs: Date.now() - t0,
      output: `error: ${message}`,
    };
  }
}

export async function runChatOnce(state: ChatState, input: string): Promise<string> {
  const result = await runChatTurn(state, input);
  return `[provider=${result.provider} model=${result.model} timing=${result.timingMs}ms]\n${result.output}`;
}
