import { afterEach, describe, expect, it, vi } from 'vitest';

import { providerToLlmClient } from '../../src/gateway/provider-adapter.js';
import { envSchema } from '../../src/infra/config/schema.js';
import {
  createProvider,
  defaultProviderConfig,
  MinimaxProvider,
  OllamaProvider,
  OpenAICompatibleProvider,
  type ChatMessage,
} from '../../src/providers/index.js';
import {
  DEFAULT_MINIMAX_MODEL,
  MINIMAX_REASONING_EFFORTS,
  type MinimaxReasoningEffort,
} from '../../src/providers/minimax/config.js';
import { createConfiguredRuntimeProviders } from '../../src/providers/runtime-registry.js';
import { adaptChatProvider, adaptGenerateProvider } from '../../src/providers/runtime.js';

function mockResponse(message: Record<string, unknown> = { content: 'public answer' }, extra = {}) {
  const requests: Array<{ url: string; body: Record<string, unknown>; init: RequestInit }> = [];
  const fetch = vi.fn(async (url: string, init: RequestInit) => {
    requests.push({ url, body: JSON.parse(init.body as string), init });
    return Response.json({ choices: [{ message, finish_reason: 'stop' }], ...extra });
  });
  vi.stubGlobal('fetch', fetch);
  return { fetch, requests };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('MiniMax M3.1 stable request contract', () => {
  it('threads isolated runtime-registry config through the provider without ambient model or effort', async () => {
    const { requests } = mockResponse();
    vi.stubEnv('MINIMAX_MODEL', 'MiniMax-M2.7');
    vi.stubEnv('MINIMAX_REASONING_EFFORT', 'max');
    const rawEnv = { MINIMAX_API_KEY: 'synthetic-registry-key', MINIMAX_REASONING_EFFORT: 'low' };
    const registry = createConfiguredRuntimeProviders(envSchema.parse({}), rawEnv);
    const provider = registry.providers.find((candidate) => candidate.name === 'minimax')!;
    expect(provider.defaultModel()).toBe(DEFAULT_MINIMAX_MODEL);
    await provider.chat([{ role: 'user', content: 'hello' }]);
    expect(requests[0].body.reasoning_effort).toBe('low');
    expect(requests[0].body.model).toBe(DEFAULT_MINIMAX_MODEL);
  });

  it('defaults to stable, a bounded completion budget and explicit medium effort', async () => {
    const { requests } = mockResponse();
    const provider = new MinimaxProvider({ apiKey: 'test-key', rawEnv: {} });
    await provider.chat([{ role: 'user', content: 'hello' }], { temperature: 0.2 });
    expect(provider.defaultModel()).toBe(DEFAULT_MINIMAX_MODEL);
    expect(requests[0].url).toBe('https://api.minimax.io/v1/chat/completions');
    expect(requests[0].body).toEqual({
      model: 'MiniMax-M3.1-Flash',
      messages: [{ role: 'user', content: 'hello' }],
      reasoning_effort: 'medium',
      max_completion_tokens: 32768,
    });
    expect(requests[0].init.signal).toBeInstanceOf(AbortSignal);
  });

  it.each(MINIMAX_REASONING_EFFORTS)(
    'accepts explicit %s effort and preserves caller output budget',
    async (effort) => {
      const { requests } = mockResponse();
      await new MinimaxProvider({ apiKey: 'test-key', rawEnv: {} }).chat(
        [{ role: 'user', content: 'hello' }],
        { reasoningEffort: effort, maxTokens: 123 },
      );
      expect(requests[0].body.reasoning_effort).toBe(effort);
      expect(requests[0].body.max_completion_tokens).toBe(123);
    },
  );

  it('uses opts > constructor > immutable rawEnv > default without reading ambient config', async () => {
    const { requests } = mockResponse();
    vi.stubEnv('MINIMAX_MODEL', 'ambient-model');
    vi.stubEnv('MINIMAX_REASONING_EFFORT', 'max');
    vi.stubEnv('MINIMAX_BASE_URL', 'https://ambient.invalid');
    const rawEnv = {
      MINIMAX_REASONING_EFFORT: 'high',
      MINIMAX_BASE_URL: 'https://example.invalid/v1/',
    };
    const snapshot = new MinimaxProvider({ apiKey: 'test-key', rawEnv });
    rawEnv.MINIMAX_REASONING_EFFORT = 'low';
    const constructor = new MinimaxProvider({
      apiKey: 'test-key',
      rawEnv,
      reasoningEffort: 'xhigh',
    });
    await snapshot.chat([{ role: 'user', content: 'hello' }]);
    await constructor.chat([{ role: 'user', content: 'hello' }]);
    await constructor.chat([{ role: 'user', content: 'hello' }], { reasoningEffort: 'low' });
    expect(requests.map((r) => r.body.reasoning_effort)).toEqual(['high', 'xhigh', 'low']);
    expect(requests.every((r) => r.body.model === DEFAULT_MINIMAX_MODEL)).toBe(true);
    expect(requests.every((r) => r.url === 'https://example.invalid/v1/chat/completions')).toBe(
      true,
    );
  });

  it('honors process env for a directly constructed provider and explicit factory model first', () => {
    vi.stubEnv('MINIMAX_MODEL', 'MiniMax-M2.7');
    vi.stubEnv('MINIMAX_REASONING_EFFORT', 'low');
    expect(new MinimaxProvider({ apiKey: 'test-key' }).defaultModel()).toBe('MiniMax-M2.7');
    expect(createProvider({ type: 'minimax', apiKey: 'test-key' }).defaultModel()).toBe(
      'MiniMax-M2.7',
    );
    expect(
      createProvider({
        type: 'minimax',
        apiKey: 'test-key',
        model: DEFAULT_MINIMAX_MODEL,
      }).defaultModel(),
    ).toBe(DEFAULT_MINIMAX_MODEL);
  });

  it('uses the stable model in defaultProviderConfig without overriding explicit legacy selections', () => {
    for (const key of [
      'ANTHROPIC_VAULT_KEY',
      'MINIMAX_VAULT_KEY',
      'GLM_VAULT_KEY',
      'DEEPSEEK_VAULT_KEY',
    ])
      vi.stubEnv(key, '');
    vi.stubEnv('MINIMAX_API_KEY', 'synthetic-test-key');
    vi.stubEnv('MINIMAX_MODEL', undefined);
    let config = defaultProviderConfig().providers.find((provider) => provider.type === 'minimax')!;
    expect(config.model).toBe(DEFAULT_MINIMAX_MODEL);
    expect(createProvider(config).defaultModel()).toBe(DEFAULT_MINIMAX_MODEL);
    vi.stubEnv('MINIMAX_MODEL', 'MiniMax-M2.7');
    config = defaultProviderConfig().providers.find((provider) => provider.type === 'minimax')!;
    expect(config.model).toBe('MiniMax-M2.7');
    expect(createProvider(config).defaultModel()).toBe('MiniMax-M2.7');
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 524289])(
    'rejects invalid completion limit %s before fetch',
    async (maxTokens) => {
      const { fetch } = mockResponse();
      await expect(
        new MinimaxProvider({ apiKey: 'test-key', rawEnv: {} }).chat(
          [{ role: 'user', content: 'hello' }],
          { maxTokens },
        ),
      ).rejects.toMatchObject({ code: 'VALIDATION_ERROR', statusCode: 400, retriable: false });
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it('accepts the documented completion ceiling when the request fits the context', async () => {
    const { requests } = mockResponse();
    await new MinimaxProvider({ apiKey: 'test-key', rawEnv: {} }).chat(
      [{ role: 'user', content: 'hello' }],
      { maxTokens: 524288 },
    );
    expect(requests[0].body.max_completion_tokens).toBe(524288);
  });

  it('reserves output tokens and refuses an oversized reasoning exchange intact', async () => {
    const { fetch } = mockResponse();
    const history: ChatMessage[] = [
      { role: 'user', content: 'continue' },
      {
        role: 'assistant',
        content: '',
        reasoning_content: 'x'.repeat(3_200_000),
        tool_calls: [{ id: 'call-a', name: 'lookup', arguments: {} }],
      },
      { role: 'tool', tool_call_id: 'call-a', content: '42' },
    ];
    await expect(
      new MinimaxProvider({ apiKey: 'test-key', rawEnv: {} }).chat(history, { maxTokens: 131072 }),
    ).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      statusCode: 400,
      retriable: false,
      details: { reservedOutputTokens: 131072, contextWindowTokens: 1_000_000 },
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(history).toHaveLength(3);
    expect(history[1]).toMatchObject({
      reasoning_content: 'x'.repeat(3_200_000),
      tool_calls: [{ id: 'call-a', name: 'lookup', arguments: {} }],
    });
  });

  it('counts tool schemas in the per-request context estimate', async () => {
    const { fetch } = mockResponse();
    await expect(
      new MinimaxProvider({ apiKey: 'test-key', rawEnv: {} }).chat(
        [{ role: 'user', content: 'hello' }],
        {
          tools: [
            { name: 'lookup', description: 'x'.repeat(3_600_000), inputSchema: { type: 'object' } },
          ],
        },
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(['none', 'disabled', '', 'HIGH'])(
    'rejects invalid reasoning effort %j before network I/O',
    async (effort) => {
      const { fetch } = mockResponse();
      expect(
        () =>
          new MinimaxProvider({ apiKey: 'test-key', rawEnv: { MINIMAX_REASONING_EFFORT: effort } }),
      ).toThrow(/reasoning effort/);
      const provider = new MinimaxProvider({ apiKey: 'test-key', rawEnv: {} });
      await expect(
        provider.chat([{ role: 'user', content: 'hello' }], {
          reasoningEffort: effort as MinimaxReasoningEffort,
        }),
      ).rejects.toThrow(/reasoning effort/);
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it.each(['MiniMax-M2.7', 'abab6.5s-chat', 'MiniMax-M3.1-Flash-Preview'])(
    'retains the legacy request contract for explicit %s',
    async (model) => {
      const { requests } = mockResponse();
      await new MinimaxProvider({ apiKey: 'test-key', model, rawEnv: {} }).chat(
        [{ role: 'user', content: 'hello' }],
        { temperature: 0.4, maxTokens: 456, reasoningEffort: 'low' },
      );
      expect(requests[0].body).toEqual({
        model,
        messages: [{ role: 'user', content: 'hello' }],
        temperature: 0.4,
        max_tokens: 456,
      });
      expect(requests[0].url).toBe(
        `https://api.minimax.io/v1/${model.startsWith('abab') ? 'text/chatcompletion_v2' : 'chat/completions'}`,
      );
    },
  );

  it('selects the request contract from the per-call model override', async () => {
    const { requests } = mockResponse();
    const provider = new MinimaxProvider({ apiKey: 'test-key', model: 'MiniMax-M2.7', rawEnv: {} });
    await provider.chat([{ role: 'user', content: 'hello' }], { model: DEFAULT_MINIMAX_MODEL });
    expect(requests[0].body.reasoning_effort).toBe('medium');
    expect(requests[0].body.max_tokens).toBeUndefined();
  });
});

describe('MiniMax response and continuation contract', () => {
  it('preserves reasoning apart from content, actual model, finish reason and cached usage', async () => {
    mockResponse(
      { content: 'public answer', reasoning_content: 'private continuation' },
      {
        model: DEFAULT_MINIMAX_MODEL,
        usage: {
          prompt_tokens: 100,
          completion_tokens: 20,
          total_tokens: 120,
          prompt_tokens_details: { cached_tokens: 80 },
        },
      },
    );
    const response = await new MinimaxProvider({
      apiKey: 'test-key',
      model: 'MiniMax-M2.7',
      rawEnv: {},
    }).chat([{ role: 'user', content: 'hello' }]);
    expect(response.content).toBe('public answer');
    expect(response.reasoning_content).toBe('private continuation');
    expect(response.model).toBe(DEFAULT_MINIMAX_MODEL);
    expect(response.finishReason).toBe('stop');
    expect(response.tokens).toEqual({ prompt: 100, completion: 20, total: 120, cache_read: 80 });
  });

  it.each([undefined, '', 'private\nUnicode: ąę 🚀\u0000'])(
    'preserves optional reasoning %j without requiring it for direct tool use',
    async (reasoning) => {
      const toolCalls = [
        {
          id: 'call-a',
          type: 'function',
          function: { name: 'lookup', arguments: '{"key":"value"}' },
        },
      ];
      const { requests } = mockResponse({
        content: null,
        tool_calls: toolCalls,
        ...(reasoning !== undefined ? { reasoning_content: reasoning } : {}),
      });
      const provider = new MinimaxProvider({ apiKey: 'test-key', rawEnv: {} });
      const first = await provider.chat([{ role: 'user', content: 'lookup' }]);
      const history: ChatMessage[] = [
        { role: 'user', content: 'lookup' },
        {
          role: 'assistant',
          content: first.content,
          tool_calls: first.tool_calls,
          ...(first.reasoning_content !== undefined
            ? { reasoning_content: first.reasoning_content }
            : {}),
        },
        { role: 'tool', tool_call_id: 'call-a', content: 'result' },
      ];
      await provider.chat(history);
      const assistant = (requests[1].body.messages as Array<Record<string, unknown>>)[1];
      expect(assistant).toEqual({
        role: 'assistant',
        content: null,
        tool_calls: toolCalls,
        ...(reasoning !== undefined ? { reasoning_content: reasoning } : {}),
      });
      expect(first.content).toBe('');
    },
  );

  it('retains reasoning on assistant messages without tool calls', async () => {
    const { requests } = mockResponse();
    await new MinimaxProvider({ apiKey: 'test-key', rawEnv: {} }).chat([
      { role: 'assistant', content: 'answer', reasoning_content: 'continuation' },
      { role: 'user', content: 'follow up' },
    ]);
    expect((requests[0].body.messages as unknown[])[0]).toEqual({
      role: 'assistant',
      content: 'answer',
      reasoning_content: 'continuation',
    });
  });

  it('passes reasoning through the gateway adapter and honors per-call effort', async () => {
    const { requests } = mockResponse({
      content: 'public answer',
      reasoning_content: 'private continuation',
    });
    const llm = providerToLlmClient(new MinimaxProvider({ apiKey: 'test-key', rawEnv: {} }), {
      reasoningEffort: 'high',
    });
    const result = await llm.complete({
      system: 'system',
      messages: [{ role: 'user', content: 'hello' }],
      reasoningEffort: 'low',
    });
    expect(result.content).toBe('public answer');
    expect(result.reasoning_content).toBe('private continuation');
    expect(requests[0].body.reasoning_effort).toBe('low');
  });

  it('keeps provider-only generate output free of reasoning and reports the actual model', async () => {
    mockResponse(
      { content: 'public answer', reasoning_content: 'private continuation' },
      { model: DEFAULT_MINIMAX_MODEL },
    );
    const runtime = adaptChatProvider(
      new MinimaxProvider({ apiKey: 'test-key', model: 'MiniMax-M2.7', rawEnv: {} }),
    );
    const result = await runtime.generate({ input: 'hello' });
    expect(result.output).toBe('public answer');
    expect(result.modelUsed).toBe(DEFAULT_MINIMAX_MODEL);
    expect(JSON.stringify(result)).not.toContain('private continuation');
  });

  it('does not forward MiniMax reasoning to Ollama or an OpenAI-compatible fallback', async () => {
    const { requests } = mockResponse();
    const history: ChatMessage[] = [
      { role: 'assistant', content: 'public answer', reasoning_content: 'private continuation' },
    ];
    await new OllamaProvider({ model: 'local', rawEnv: {} }).chat(history);
    await new OpenAICompatibleProvider({
      name: 'other',
      baseUrl: 'https://example.invalid',
      apiKey: 'test-key',
      model: 'other',
    }).chat(history);
    for (const request of requests)
      expect(JSON.stringify(request.body)).not.toContain('private continuation');
  });

  it('does not serialize reasoning into generate-only fallback prompts', async () => {
    const generate = vi.fn(async () => ({
      id: 'test',
      providerUsed: 'local-fallback' as const,
      output: 'answer',
      timingMs: 0,
    }));
    const provider = adaptGenerateProvider({
      name: 'local-fallback',
      healthCheck: async () => ({ name: 'local-fallback', ok: true }),
      generate,
    });
    await provider.chat([
      { role: 'assistant', content: 'public answer', reasoning_content: 'private continuation' },
    ]);
    expect(JSON.stringify(generate.mock.calls[0][0])).not.toContain('private continuation');
  });
});
