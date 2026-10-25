import { describe, expect, it, vi } from 'vitest';

import { providerToLlmClient } from '../../src/gateway/provider-adapter.js';

describe('providerToLlmClient', () => {
  it('forwards temperature and maxTokens defaults into provider.chat', async () => {
    const chat = vi.fn(async () => ({ content: 'hi', tool_calls: undefined }));
    const llm = providerToLlmClient({ chat } as never, {
      temperature: 0.42,
      maxTokens: 2048,
      model: 'test-model',
    });

    await llm.complete({ system: 'system', messages: [{ role: 'user', content: 'ping' }] });

    expect(chat).toHaveBeenCalledTimes(1);
    const [, options] = chat.mock.calls[0]!;
    expect(options).toMatchObject({
      temperature: 0.42,
      maxTokens: 2048,
      model: 'test-model',
      systemPrompt: 'system',
    });
  });

  it('omits temperature/maxTokens when defaults are not provided', async () => {
    const chat = vi.fn(async () => ({ content: 'hi', tool_calls: undefined }));
    const llm = providerToLlmClient({ chat } as never);

    await llm.complete({ system: 'system', messages: [{ role: 'user', content: 'ping' }] });

    const [, options] = chat.mock.calls[0]! as [unknown, Record<string, unknown>];
    expect(options.temperature).toBeUndefined();
    expect(options.maxTokens).toBeUndefined();
  });

  it('keeps MiniMax reasoning state opaque while forwarding it to the agent loop', async () => {
    const chat = vi.fn(async () => ({
      content: '',
      tool_calls: [{ id: 'call_1', name: 'memphis_code_read', arguments: { path: 'README.md' } }],
      reasoning_content: 'private interleaved state',
    }));
    const llm = providerToLlmClient({ chat } as never);

    const result = await llm.complete({
      system: 'system',
      messages: [{ role: 'user', content: 'inspect' }],
    });

    expect(result.reasoning_content).toBe('private interleaved state');
    expect(result.content).toBe('');
  });
});
