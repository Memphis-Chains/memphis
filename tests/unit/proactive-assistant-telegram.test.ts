import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ProactiveAssistant,
  type ProactiveMessage,
} from '../../src/cognitive/proactive-assistant.js';
import type { IStore } from '../../src/cognitive/store.js';

function createStore(): IStore {
  return {
    append: vi.fn(async () => ({
      index: 1,
      hash: 'hash-1',
      chain: 'proactive',
      timestamp: new Date().toISOString(),
    })),
  };
}

function createMessage(): ProactiveMessage {
  return {
    type: 'tip',
    priority: 'medium',
    title: 'Daily tip',
    message: 'Keep notes concise.',
    emoji: '🎯',
    timestamp: new Date(),
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

describe('ProactiveAssistant telegram delivery', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    delete process.env.MEMPHIS_PROACTIVE_TELEGRAM_ENABLED;
  });

  it('sends generated messages to Telegram when configured', async () => {
    vi.useFakeTimers();
    process.env.MEMPHIS_PROACTIVE_TELEGRAM_ENABLED = 'true';
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    const assistant = new ProactiveAssistant(
      [],
      {
        botToken: 'abc123',
        chatId: '42',
        checkIntervalMinutes: 1,
        minHoursBetweenMessages: 0,
      },
      createStore(),
      { fetchImpl: fetchMock as unknown as typeof fetch, requestTimeoutMs: 500 },
    );
    vi.spyOn(assistant, 'check').mockResolvedValue([createMessage()]);

    const timer = assistant.startPeriodicCheck();
    await vi.advanceTimersByTimeAsync(60_000);
    clearInterval(timer);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.telegram.org/botabc123/sendMessage',
      expect.objectContaining({
        method: 'POST',
      }),
    );
  });

  it('does not call Telegram API when bot config is missing', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn();

    const assistant = new ProactiveAssistant(
      [],
      {
        checkIntervalMinutes: 1,
        minHoursBetweenMessages: 0,
      },
      createStore(),
      { fetchImpl: fetchMock as unknown as typeof fetch, requestTimeoutMs: 500 },
    );
    vi.spyOn(assistant, 'check').mockResolvedValue([createMessage()]);

    const timer = assistant.startPeriodicCheck();
    await vi.advanceTimersByTimeAsync(60_000);
    clearInterval(timer);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('skips telegram delivery unless explicit opt-in flag is enabled', async () => {
    const fetchImpl = vi.fn();
    const assistant = new ProactiveAssistant(
      [],
      { botToken: 'bot-token', chatId: '42' },
      createStore(),
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
      createStore(),
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
