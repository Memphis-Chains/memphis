import { describe, expect, it } from 'vitest';

import { runAgentLoop } from '../../src/gateway/agent-runtime.js';
import type { LlmClient, ToolExecutor } from '../../src/gateway/chat-types.js';
import type { ChatToolCall, ChatToolDefinition } from '../../src/providers/index.js';

/**
 * A stopped turn must still carry the answer the model produced.
 *
 * Measured 2026-11-20: on the telegram surface the halted branch
 * returned a fixed sentence and DISCARDED `response.content` — the text
 * the model had already written. The session history on this host shows
 * the cost: eight consecutive identical replies
 * ("Zatrzymałem tę odpowiedź po osiągnięciu limitu pracy") to "No
 * siema", "?", ".", "I" and "Pracujemy". The operator got a placeholder
 * instead of the answer, and the placeholder reads like a broken bot
 * rather than a turn that ran out of budget.
 *
 * Every other surface already kept the content
 * (`response.content || fallback`). Telegram was the only one that threw
 * the answer away — and Telegram is the surface where the operator reads
 * the reply on a phone.
 */

function makeLlm(turns: Array<{ content: string; tool_calls?: ChatToolCall[] }>): LlmClient {
  let i = 0;
  return {
    async complete() {
      const turn = turns[i] ?? turns[turns.length - 1]!;
      i += 1;
      return turn;
    },
  };
}

function makeExecutor(handlers: Record<string, () => string>): ToolExecutor {
  const tools: ChatToolDefinition[] = Object.keys(handlers).map((name) => ({
    name,
    description: `${name} (test)`,
    inputSchema: { type: 'object', properties: {} },
  }));
  return {
    listTools: () => tools,
    async execute(call) {
      const handler = handlers[call.name];
      if (!handler) return JSON.stringify({ error: `unknown tool: ${call.name}` });
      return handler();
    },
    maxParallel: 4,
  };
}

/** A limit of one tool call, so the second one trips the limit. */
const ONE_TOOL_CALL = { max_steps: 100, max_tool_calls: 1, max_wait_ms: 120_000, max_errors: 32 };

describe('a stopped telegram turn keeps what the model said', () => {
  it('keeps the answer the model produced before the limit', async () => {
    const call: ChatToolCall = { id: 'call-1', name: 'memphis_health', arguments: {} };
    const llm = makeLlm([
      { content: '', tool_calls: [call] },
      { content: 'Runtime zdrowy: baza OK, 26 044 bloków.', tool_calls: [call] },
    ]);
    const toolExecutor = makeExecutor({ memphis_health: () => '{"status":"healthy"}' });

    const result = await runAgentLoop({
      systemPrompt: 'system',
      messages: [{ role: 'user', content: 'Test' }],
      llm,
      toolExecutor,
      surface: 'telegram',
      loopLimits: ONE_TOOL_CALL,
    });

    expect(result.reply).toContain('Runtime zdrowy: baza OK, 26 044 bloków.');
    expect(result.reply).toContain('Zatrzymałem tę odpowiedź po osiągnięciu limitu pracy');
  });

  it('keeps the answer on every surface, not only on telegram', async () => {
    const call: ChatToolCall = { id: 'call-1', name: 'memphis_health', arguments: {} };
    const llm = makeLlm([
      { content: '', tool_calls: [call] },
      { content: 'Odpowiedź modelu.', tool_calls: [call] },
    ]);
    const toolExecutor = makeExecutor({ memphis_health: () => '{"status":"healthy"}' });

    const result = await runAgentLoop({
      systemPrompt: 'system',
      messages: [{ role: 'user', content: 'Test' }],
      llm,
      toolExecutor,
      surface: 'http',
      loopLimits: ONE_TOOL_CALL,
    });

    expect(result.reply).toContain('Odpowiedź modelu.');
  });

  it('drops a completion claim, because the cut makes it untrue', async () => {
    const call: ChatToolCall = { id: 'call-1', name: 'memphis_health', arguments: {} };
    const llm = makeLlm([
      { content: '', tool_calls: [call] },
      { content: 'This unexecuted work is complete', tool_calls: [call] },
    ]);
    const toolExecutor = makeExecutor({ memphis_health: () => '{"status":"healthy"}' });

    const result = await runAgentLoop({
      systemPrompt: 'system',
      messages: [{ role: 'user', content: 'work' }],
      llm,
      toolExecutor,
      surface: 'telegram',
      loopLimits: ONE_TOOL_CALL,
    });

    // The guarantee `telegram-interactive-agent.test.ts` protects: a
    // halted turn must not tell the operator the work is done.
    expect(result.reply).not.toContain('unexecuted work is complete');
    expect(result.reply).toContain('Zatrzymałem tę odpowiedź po osiągnięciu limitu pracy');
  });

  it('still says the turn was stopped when the model said nothing', async () => {
    const call: ChatToolCall = { id: 'call-1', name: 'memphis_health', arguments: {} };
    const llm = makeLlm([
      { content: '', tool_calls: [call] },
      { content: '   ', tool_calls: [call] },
    ]);
    const toolExecutor = makeExecutor({ memphis_health: () => '{"status":"healthy"}' });

    const result = await runAgentLoop({
      systemPrompt: 'system',
      messages: [{ role: 'user', content: 'Test' }],
      llm,
      toolExecutor,
      surface: 'telegram',
      loopLimits: ONE_TOOL_CALL,
    });

    expect(result.reply).toContain('Zatrzymałem tę odpowiedź po osiągnięciu limitu pracy');
    expect(result.reply.trim().startsWith('Zatrzymałem')).toBe(true);
  });
});
