import { describe, expect, it, vi } from 'vitest';

const runAgentLoop = vi.fn(async () => ({
  reply: 'assistant raw reply',
  messages: [
    { role: 'user', content: 'placeholder user' },
    { role: 'assistant', content: 'assistant raw reply' },
  ],
}));
const prepareCognitivePrelude = vi.fn(async () => ({
  blocks: [],
  exact: { query: 'summarize', count: 1, hits: [] },
  inferred: [],
  predictions: [],
  promptFragment: '[chain_hits]\n- decisions#2 score=0.90 prior decision summary',
}));
const fetchUrlsFromMessage = vi.fn(async () => [
  { url: 'https://example.com/spec', content: 'external context' },
]);
const runPostResponseCognitivePass = vi.fn();

vi.mock('../../src/gateway/agent-runtime.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/gateway/agent-runtime.js')>(
    '../../src/gateway/agent-runtime.js',
  );
  return {
    ...actual,
    runAgentLoop,
  };
});

vi.mock('../../src/gateway/cognitive-runtime.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/gateway/cognitive-runtime.js')>(
    '../../src/gateway/cognitive-runtime.js',
  );
  return {
    ...actual,
    prepareCognitivePrelude,
    runPostResponseCognitivePass,
  };
});

vi.mock('../../src/gateway/url-extract.js', () => ({
  fetchUrlsFromMessage,
}));

describe('turn runtime', () => {
  it('sends the reply early but waits for post-response persistence before resolving', async () => {
    let resolvePostlude: ((value: { ok: true }) => void) | undefined;
    runPostResponseCognitivePass.mockImplementation(
      () =>
        new Promise<{ ok: true }>((resolve) => {
          resolvePostlude = resolve;
        }),
    );

    const { runTurnRuntime } = await import('../../src/gateway/turn-runtime.js');

    const sendReply = vi.fn(async () => undefined);
    const persistSession = vi.fn(async () => undefined);
    const memory = {
      recall: vi.fn(async () => ({ items: [{ content: 'prior note', score: 0.91 }] })),
      store: vi.fn(async () => undefined),
      isAvailable: vi.fn(() => true),
    };

    const pending = runTurnRuntime({
      input: 'summarize https://example.com/spec',
      messages: [],
      provider: {
        name: 'ollama',
        isConfigured: () => true,
        isAvailable: async () => true,
        listModels: async () => ['qwen2.5-coder:3b'],
        defaultModel: () => 'qwen2.5-coder:3b',
        healthCheck: async () => ({ name: 'ollama', ok: true }),
        chat: vi.fn(),
        generate: vi.fn(),
      },
      memory,
      memoryUserId: 'http:test',
      surface: 'http.chat.generate',
      sendReply,
      persistSession,
    });

    await vi.waitFor(() => {
      expect(sendReply).toHaveBeenCalledWith('assistant raw reply');
    });
    expect(persistSession).toHaveBeenCalledWith(
      expect.objectContaining({
        userText: expect.stringContaining('<user_input>'),
        assistantReply: 'assistant raw reply',
      }),
    );

    const runCall = runAgentLoop.mock.calls[0]?.[0];
    expect(runCall.messages[0].content).toContain('<user_input>');
    expect(runCall.messages[0].content).toContain(
      '<fetched_content url="https://example.com/spec">',
    );
    expect(runCall.systemPrompt).toContain('[chain_hits]');

    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    resolvePostlude?.({ ok: true });
    const result = await pending;
    expect(result.persistence.postResponseCognitiveOk).toBe(true);
    expect(memory.store).toHaveBeenCalledWith(
      'http:test',
      'summarize https://example.com/spec',
      'assistant raw reply',
    );
  });
});
