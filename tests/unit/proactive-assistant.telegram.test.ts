import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ProactiveAssistant,
  type ProactiveMessage,
} from '../../src/cognitive/proactive-assistant.js';
import type { IStore } from '../../src/cognitive/store.js';

function makeStore(): IStore {
  return {
    append: vi.fn(async () => ({
      chain: 'proactive',
      index: 1,
      hash: 'hash-1',
      timestamp: new Date().toISOString(),
    })),
  };
}

function messageFixture(): ProactiveMessage {
  return {
    type: 'suggestion',
    priority: 'medium',
    title: 'Quick Wins',
    message: 'Do one thing now',
    emoji: '⚡',
    timestamp: new Date('2026-03-12T00:00:00.000Z'),
    actions: [{ label: 'Action', command: '/action now' }],
  };
}

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
  vi.restoreAllMocks();
});

describe('Proactive assistant telegram delivery', () => {
  it('skips telegram delivery unless explicit opt-in flag is enabled', async () => {
    const fetchImpl = vi.fn();
    const assistant = new ProactiveAssistant(
      [],
      { botToken: 'bot-token', chatId: '42' },
      makeStore(),
      {
        fetchImpl: fetchImpl as unknown as typeof fetch,
      },
    );

    const delivered = await assistant.sendMessagesViaTelegram([messageFixture()]);

    expect(delivered.skipped).toBe(true);
    expect(delivered.reason).toContain('disabled');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('delivers proactive messages to telegram when enabled and credentials are present', async () => {
    process.env.MEMPHIS_PROACTIVE_TELEGRAM_ENABLED = 'true';
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
    } as Partial<Response>);

    const assistant = new ProactiveAssistant(
      [],
      { botToken: 'bot-token', chatId: '42' },
      makeStore(),
      {
        fetchImpl: fetchImpl as unknown as typeof fetch,
      },
    );

    const delivered = await assistant.sendMessagesViaTelegram([messageFixture()]);

    expect(delivered.skipped).toBe(false);
    expect(delivered.delivered).toBe(1);
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://api.telegram.org/botbot-token/sendMessage',
      expect.objectContaining({
        method: 'POST',
      }),
    );
  });
});
