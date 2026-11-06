import { Bot } from 'grammy';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/gateway/channels/telegram-tier-session.js', () => ({
  getTelegramSessionTier: () => 1,
  isAllowedTelegramUser: (id: number) => id === 42,
}));

import { registerTelegramTextTurns } from '../../src/gateway/channels/telegram-text-turns.js';
import {
  createTelegramTurnGuard,
  registerTelegramTurnGuardMiddleware,
} from '../../src/gateway/channels/telegram-turn-guard.js';

type UpdateHandler = (ctx: ReturnType<typeof context>) => Promise<void>;

function context(text: string, sender = 42, chatId = 123) {
  return {
    message: {
      text,
      message_id: 9,
      date: 100,
      from: { id: sender, is_bot: false },
      chat: { id: chatId },
    },
    reply: vi.fn().mockResolvedValue(undefined),
    replyWithChatAction: vi.fn().mockResolvedValue(undefined),
  };
}

function setup(handler: ReturnType<typeof vi.fn>, options = {}) {
  let update: UpdateHandler | undefined;
  const bot = {
    on: (_: string, fn: UpdateHandler) => {
      update = fn;
    },
  };
  registerTelegramTextTurns(bot as unknown as Bot, options, handler, new Set());
  if (!update) throw new Error('Telegram handler was not registered');
  return update;
}

describe('interactive Telegram turns', () => {
  afterEach(() => vi.useRealTimers());

  it('returns from the update while working, allows a status probe, and refuses a second turn explicitly', async () => {
    let finish!: () => void;
    const task = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const handler = vi.fn().mockReturnValueOnce(task).mockResolvedValue(undefined);
    const update = setup(handler, { onStatus: () => 'operational' });
    const first = context('Proszę wykonaj zadanie');
    await update(first);
    expect(handler).toHaveBeenCalledTimes(1);

    const second = context('następne zadanie');
    await update(second);
    expect(second.reply).toHaveBeenCalledWith(expect.stringContaining('nie przetworzyłem'));
    expect(handler).toHaveBeenCalledTimes(1);

    const status = context('status');
    await update(status);
    expect(status.reply).toHaveBeenCalledWith('operational');

    finish();
    await vi.waitFor(async () => {
      const third = context('nowe zadanie');
      await update(third);
      expect(handler).toHaveBeenCalledTimes(2);
    });
  });

  it('does not reject the turn or leave it locked if typing indicators fail', async () => {
    vi.useFakeTimers();
    let finish!: () => void;
    const task = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const handler = vi.fn().mockReturnValueOnce(task).mockResolvedValue(undefined);
    const update = setup(handler);
    const first = context('wykonaj');
    first.replyWithChatAction.mockRejectedValue(new Error('network failure'));
    await update(first);
    expect(handler).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(4000);
    expect(first.replyWithChatAction).toHaveBeenCalledTimes(2);
    finish();
    await Promise.resolve();
    await Promise.resolve();
    const second = context('kolejna');
    await update(second);
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it('denies a different sender without launching a turn', async () => {
    const handler = vi.fn();
    const update = setup(handler);
    const denied = context('hello', 99);
    await update(denied);
    expect(denied.reply).toHaveBeenCalledWith('Access denied.');
    expect(handler).not.toHaveBeenCalled();
  });

  it('does not run two turns for the same actor from different Telegram chats', async () => {
    let finish!: () => void;
    const task = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const handler = vi.fn().mockReturnValueOnce(task);
    const update = setup(handler);
    await update(context('pierwsza', 42, 123));
    const secondChat = context('druga', 42, 456);
    await update(secondChat);
    expect(secondChat.reply).toHaveBeenCalledWith(expect.stringContaining('nie przetworzyłem'));
    expect(handler).toHaveBeenCalledTimes(1);
    finish();
    await Promise.resolve();
  });

  it('reports provider failure safely, releases the chat, and does not expose raw error text', async () => {
    const handler = vi
      .fn()
      .mockRejectedValueOnce(new Error('fetch failed with fixture-secret-marker'))
      .mockResolvedValue(undefined);
    const update = setup(handler);
    const first = context('zadanie');
    await update(first);
    await vi.waitFor(() => expect(first.reply).toHaveBeenCalled());
    expect(first.reply.mock.calls[0]?.[0]).toContain('Nie udało mi się zakończyć');
    expect(first.reply.mock.calls[0]?.[0]).not.toContain('fixture-secret-marker');
    await new Promise((resolve) => setImmediate(resolve));
    const next = context('kolejne');
    await update(next);
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it('lets real grammY handle a status update while a text turn is in flight', async () => {
    let finish!: () => void;
    const running = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const handler = vi.fn().mockReturnValue(running);
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
    const guard = createTelegramTurnGuard();
    registerTelegramTurnGuardMiddleware(bot, guard);
    const evolve = vi.fn();
    const voice = vi.fn();
    bot.command('evolve', evolve);
    bot.on('message:voice', voice);
    registerTelegramTextTurns(bot, { onStatus: () => 'operational' }, handler, new Set(), guard);
    const mkUpdate = (id: number, text: string) => ({
      update_id: id,
      message: {
        message_id: id,
        date: 100,
        text,
        chat: { id: 123, type: 'private' as const, first_name: 'test' },
        from: { id: 42, is_bot: false, first_name: 'test' },
      },
    });
    await bot.handleUpdate(mkUpdate(1, 'wykonaj zadanie'));
    expect(handler).toHaveBeenCalledTimes(1);
    await bot.handleUpdate(mkUpdate(2, 'status'));
    expect(sent).toContain('operational');
    await bot.handleUpdate(mkUpdate(3, 'inne zadanie'));
    expect(sent.some((text) => text.includes('nie przetworzyłem'))).toBe(true);
    expect(handler).toHaveBeenCalledTimes(1);
    const command = mkUpdate(4, '/evolve');
    await bot.handleUpdate({
      ...command,
      message: { ...command.message, entities: [{ type: 'bot_command', offset: 0, length: 7 }] },
    });
    expect(evolve).not.toHaveBeenCalled();
    const media = mkUpdate(5, '');
    await bot.handleUpdate({
      ...media,
      message: {
        message_id: media.message.message_id,
        date: media.message.date,
        chat: media.message.chat,
        from: media.message.from,
        voice: { file_id: 'fixture', file_unique_id: 'fixture', duration: 1 },
      },
    });
    expect(voice).not.toHaveBeenCalled();
    finish();
    await Promise.resolve();
    await Promise.resolve();
  });
});
