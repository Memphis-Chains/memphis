import { afterEach, describe, expect, it, vi } from 'vitest';

import { runAgentLoop } from '../../src/gateway/agent-runtime.js';
import type { LlmClient, ToolExecutor } from '../../src/gateway/chat-types.js';
import { providerToLlmClient } from '../../src/gateway/provider-adapter.js';

describe('Telegram interactive agent bounds', () => {
  afterEach(() => vi.useRealTimers());

  it('stops before executing calls beyond the budget and gives an honest partial-work notice', async () => {
    const llm: LlmClient = {
      complete: vi.fn(async () => ({
        content: 'This unexecuted work is complete',
        tool_calls: [{ id: 'one', name: 'example', arguments: {} }],
      })),
    };
    const execute = vi.fn(async () => '{"ok":true}');
    const toolExecutor: ToolExecutor = {
      listTools: () => [
        { name: 'example', description: 'example', inputSchema: { type: 'object' } },
      ],
      execute,
    };
    const result = await runAgentLoop({
      systemPrompt: 'system',
      messages: [{ role: 'user', content: 'work' }],
      llm,
      toolExecutor,
      surface: 'telegram',
      loopLimits: { max_steps: 100, max_tool_calls: 2, max_errors: 10, max_wait_ms: 1000 },
    });
    expect(execute).toHaveBeenCalledTimes(2);
    expect(result.reply).toContain('Część działań mogła już zostać wykonana');
    expect(result.reply).not.toContain('unexecuted work is complete');
    expect(result.haltReason).toBe('max_tool_calls_exceeded');
  });

  it('aborts a stalled provider call and releases the waiting caller', async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const llm: LlmClient = {
      complete: vi.fn((input) => {
        signal = input.signal;
        return new Promise(() => {});
      }),
    };
    const result = runAgentLoop({
      systemPrompt: 'system',
      messages: [],
      llm,
      surface: 'telegram',
      providerTimeoutMs: 1000,
    });
    const rejected = expect(result).rejects.toThrow('Dostawca odpowiedzi nie odpowiedział');
    await vi.advanceTimersByTimeAsync(1000);
    await rejected;
    expect(signal?.aborted).toBe(true);
    expect(llm.complete).toHaveBeenCalledTimes(1);
  });

  it('forwards the cancellation signal to the underlying provider', async () => {
    const provider = {
      chat: vi.fn(async () => ({ content: 'ok', model: 'test', provider: 'test' })),
    };
    const llm = providerToLlmClient(provider);
    const signal = new AbortController().signal;
    await llm.complete({ system: 'system', messages: [], signal });
    expect(provider.chat).toHaveBeenCalledWith([], expect.objectContaining({ signal }));
  });

  it('does not start another provider request after the turn time budget', async () => {
    vi.useFakeTimers();
    const start = Date.now();
    const llm: LlmClient = {
      complete: vi.fn(async () => ({
        content: '',
        tool_calls: [{ id: 'one', name: 'example', arguments: {} }],
      })),
    };
    const execute = vi.fn(async () => {
      vi.setSystemTime(start + 2_100);
      return '{"ok":true}';
    });
    const toolExecutor: ToolExecutor = {
      listTools: () => [
        { name: 'example', description: 'example', inputSchema: { type: 'object' } },
      ],
      execute,
    };
    const result = await runAgentLoop({
      systemPrompt: 'system',
      messages: [],
      llm,
      toolExecutor,
      surface: 'telegram',
      turnTimeoutMs: 2000,
    });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(llm.complete).toHaveBeenCalledTimes(1);
    expect(result.haltReason).toBe('turn_deadline_exceeded');
    expect(result.reply).toContain('Część działań mogła już zostać wykonana');
  });

  it('aborts an outstanding provider request at the total turn deadline', async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const llm: LlmClient = {
      complete: vi.fn((input) => {
        signal = input.signal;
        return new Promise(() => {});
      }),
    };
    const result = runAgentLoop({
      systemPrompt: 'system',
      messages: [],
      llm,
      surface: 'telegram',
      providerTimeoutMs: 5000,
      turnTimeoutMs: 1000,
    });
    await vi.advanceTimersByTimeAsync(1000);
    await expect(result).resolves.toMatchObject({ haltReason: 'turn_deadline_exceeded' });
    expect(signal?.aborted).toBe(true);
  });
});
