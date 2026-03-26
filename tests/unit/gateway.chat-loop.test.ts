import { beforeEach, describe, expect, it, vi } from 'vitest';

const runAgentLoop = vi.fn(async () => ({ reply: 'assistant reply' }));
const buildRuntimeSystemPrompt = vi.fn(() => 'system prompt');
const fetchUrlsFromMessage = vi.fn(async () => [
  { url: 'https://example.com/spec', content: 'external context' },
]);

vi.mock('../../src/gateway/agent-runtime.js', () => ({
  runAgentLoop,
  buildRuntimeSystemPrompt,
  newLoopState: vi.fn(),
}));

vi.mock('../../src/gateway/url-extract.js', () => ({
  fetchUrlsFromMessage,
}));

describe('gateway chat loop', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('keeps wrapped user input when fetched content is attached', async () => {
    const { handleMessage } = await import('../../src/gateway/chat-loop.js');

    const adapter = {
      name: 'telegram' as const,
      start: vi.fn(),
      stop: vi.fn(),
      send: vi.fn(async () => undefined),
    };
    const sessions = {
      get: vi.fn(() => []),
      append: vi.fn(),
    };
    const memory = {
      recall: vi.fn(async () => ({ items: [] })),
      store: vi.fn(async () => undefined),
      isAvailable: vi.fn(() => true),
    };

    await handleMessage(
      {
        id: 'msg-1',
        channel: 'telegram',
        userId: 'telegram:1',
        chatId: '1',
        text: 'summarize https://example.com/spec',
        timestamp: new Date('2026-03-26T12:00:00.000Z'),
      },
      {
        adapters: [adapter],
        memory,
        llm: {
          complete: vi.fn(async () => ({ content: 'unused' })),
        },
        sessions,
      },
      new Map([['telegram', adapter]]),
    );

    const runCall = runAgentLoop.mock.calls[0]?.[0];
    expect(runCall.messages[0].content).toContain('<user_input>');
    expect(runCall.messages[0].content).toContain(
      '<fetched_content url="https://example.com/spec">',
    );
    expect(runCall.messages[0].content).toContain('summarize https://example.com/spec');

    expect(sessions.append).toHaveBeenCalledWith(
      '1',
      expect.stringContaining('<user_input>'),
      'assistant reply',
      'telegram',
    );
    expect(adapter.send).toHaveBeenCalledWith('1', 'assistant reply');
    expect(fetchUrlsFromMessage).toHaveBeenCalledOnce();
  });
});
