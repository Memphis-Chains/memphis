import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Bot } from 'grammy';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/gateway/channels/telegram-tier-session.js', () => ({
  getTelegramSessionTier: () => 3,
  isAllowedTelegramUser: () => true,
}));

import { registerTelegramTextTurns } from '../../src/gateway/channels/telegram-text-turns.js';
import { handleMessage } from '../../src/gateway/chat-loop.js';
import type { ChannelAdapter, ChatGatewayConfig } from '../../src/gateway/chat-types.js';
import { createInProcessToolExecutor } from '../../src/gateway/tool-executor.js';

describe('Telegram turn integration', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('keeps processing status updates while a real exec tool runs and delivers the eventual reply', async () => {
    vi.stubEnv('MEMPHIS_AUTONOMY_MODE', 'full');
    vi.stubEnv('MEMPHIS_SURFACE_TELEGRAM_MAX_TOOL_TIER', '3');
    const marker = join(tmpdir(), `telegram-exec-started-${process.pid}`);
    const bot = new Bot('123:fixture-not-a-real-token', {
      botInfo: {
        id: 123,
        is_bot: true,
        first_name: 'test',
        username: 'fixture_bot',
        can_join_groups: false,
        can_read_all_group_messages: false,
        supports_inline_queries: false,
      },
    });
    const sent: string[] = [];
    bot.api.config.use(async (_previous, method, payload) => {
      if (method === 'sendMessage') sent.push(String((payload as { text?: string }).text));
      return { ok: true, result: method === 'sendChatAction' ? true : { message_id: 1 } } as never;
    });
    const adapter: ChannelAdapter = {
      name: 'telegram',
      start: vi.fn(),
      stop: vi.fn(),
      send: async (chatId, text) => {
        await bot.api.sendMessage(chatId, text);
      },
    };
    const complete = vi
      .fn()
      .mockResolvedValueOnce({
        content: '',
        tool_calls: [
          {
            id: 'tool-1',
            name: 'memphis_exec',
            arguments: { command: `printf started > ${marker}; sleep 2; printf done` },
          },
        ],
      })
      .mockResolvedValueOnce({ content: 'fixture complete' });
    const append = vi.fn();
    const config: ChatGatewayConfig = {
      adapters: [adapter],
      memory: {
        recall: vi.fn(async () => ({ items: [] })),
        store: vi.fn(async () => undefined),
        isAvailable: () => true,
      },
      llm: { complete },
      toolExecutor: createInProcessToolExecutor({ surface: 'telegram' }),
      sessions: { get: () => [], append },
    };
    registerTelegramTextTurns(
      bot,
      { onStatus: () => 'operational' },
      (message) => handleMessage(message, config, new Map([['telegram', adapter]])),
      new Set(),
    );
    const update = (id: number, text: string) => ({
      update_id: id,
      message: {
        message_id: id,
        date: 100,
        text,
        chat: { id: 123, type: 'private' as const, first_name: 'test' },
        from: { id: 42, is_bot: false, first_name: 'test' },
      },
    });
    await bot.handleUpdate(update(1, 'wykonaj zadanie'));
    await vi.waitFor(() => expect(existsSync(marker)).toBe(true), { timeout: 15_000 });
    expect(complete).toHaveBeenCalledTimes(1);
    await bot.handleUpdate(update(2, 'status'));
    expect(sent).toContain('operational');
    await bot.handleUpdate(update(3, 'następne zadanie'));
    expect(sent.some((text) => text.includes('nie przetworzyłem'))).toBe(true);
    await vi.waitFor(() => expect(sent).toContain('fixture complete'), { timeout: 15_000 });
    await vi.waitFor(() => expect(append).toHaveBeenCalled(), { timeout: 15_000 });
  }, 25_000);
});
