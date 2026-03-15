import type { Provider, ChatMessage, ChatToolDefinition, ChatToolCall, ChatResponse } from '../../providers/index.js';

export type ChatState = {
  provider: Provider;
  systemPrompt?: string;
  tools?: ChatToolDefinition[];
  toolExecutor?: (call: ChatToolCall) => Promise<string>;
  messages: ChatMessage[];
};

const MAX_MESSAGES = 40;

function trimMessages(messages: ChatMessage[]): void {
  // Keep system message + last MAX_MESSAGES
  while (messages.length > MAX_MESSAGES + 1) {
    const idx = messages[0]?.role === 'system' ? 1 : 0;
    messages.splice(idx, 1);
  }
}

export async function runChatOnce(
  state: ChatState,
  input: string,
): Promise<string> {
  state.messages.push({ role: 'user', content: input });
  trimMessages(state.messages);

  const t0 = Date.now();
  let response: ChatResponse;

  try {
    response = await state.provider.chat(state.messages, {
      systemPrompt: state.systemPrompt,
      tools: state.tools,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    state.messages.pop(); // remove failed user message
    return `error: ${msg}`;
  }

  const timingMs = Date.now() - t0;
  const lines: string[] = [];
  lines.push(`[provider=${response.provider} model=${response.model} timing=${timingMs}ms]`);

  // Handle tool calls
  if (response.tool_calls?.length && state.toolExecutor) {
    state.messages.push({
      role: 'assistant',
      content: response.content || '',
      tool_calls: response.tool_calls,
    });

    const toolLines: string[] = [];
    for (const call of response.tool_calls) {
      toolLines.push(`  tool: ${call.name}(${JSON.stringify(call.arguments)})`);
      try {
        const result = await state.toolExecutor(call);
        state.messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: result,
        });
        toolLines.push(`  result: ${result.slice(0, 200)}${result.length > 200 ? '...' : ''}`);
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        state.messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: JSON.stringify({ error: errMsg }),
        });
        toolLines.push(`  error: ${errMsg}`);
      }
    }

    // Second call with tool results
    const t1 = Date.now();
    try {
      const followUp = await state.provider.chat(state.messages, {
        systemPrompt: state.systemPrompt,
        tools: state.tools,
      });
      const timing2 = Date.now() - t1;
      state.messages.push({ role: 'assistant', content: followUp.content });
      lines.push(...toolLines);
      lines.push(`[follow-up timing=${timing2}ms]`);
      lines.push(followUp.content);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      lines.push(...toolLines);
      lines.push(`error on follow-up: ${msg}`);
    }
  } else {
    // No tool calls — simple response
    state.messages.push({ role: 'assistant', content: response.content });
    lines.push(response.content);
  }

  return lines.join('\n');
}
