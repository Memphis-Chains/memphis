import { beforeEach, describe, expect, it, vi } from 'vitest';

const runTurnRuntime = vi.fn(async (input: {
  sendReply?: (reply: string) => Promise<void>;
  persistSession?: (entry: { userText: string; assistantReply: string }) => Promise<void> | void;
}) => {
  await input.sendReply?.('assistant reply');
  await input.persistSession?.({
    userText: '<user_input>\nsummarize https://example.com/spec\n</user_input>',
    assistantReply: 'assistant reply',
  });
  return {
    provider: 'ollama',
    model: 'qwen2.5-coder:3b',
    timingMs: 14,
    output: 'assistant reply',
    messages: [],
    persistence: {
      sessionUpdated: true,
      memoryStoreAttempted: true,
      memoryStored: true,
      postResponseCognitiveAttempted: true,
      postResponseCognitiveOk: true,
      degraded: false,
      errors: [],
    },
  };
});

vi.mock('../../src/gateway/turn-runtime.js', () => ({
  runTurnRuntime,
}));

describe('gateway chat loop', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('routes message handling through the canonical turn runtime', async () => {
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

    expect(runTurnRuntime).toHaveBeenCalledWith(
      expect.objectContaining({
        input: 'summarize https://example.com/spec',
        messages: [],
        memory,
        memoryUserId: 'telegram:1',
        surface: 'gateway',
        auditSurface: 'telegram',
      }),
    );
    expect(sessions.append).toHaveBeenCalledWith(
      '1',
      expect.stringContaining('<user_input>'),
      'assistant reply',
      'telegram',
    );
    expect(adapter.send).toHaveBeenCalledWith('1', 'assistant reply');
  });
});
