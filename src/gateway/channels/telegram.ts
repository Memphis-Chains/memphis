import { Bot } from 'grammy';

import type { ChannelAdapter, MessageHandler } from '../chat-types.js';
import { splitText } from './utils.js';

export type TelegramAdapterOptions = {
  onStatus?: () => string;
  onRecall?: (userId: string) => Promise<string>;
};

export function createTelegramAdapter(
  token: string,
  options: TelegramAdapterOptions = {},
): ChannelAdapter {
  const bot = new Bot(token);
  let started = false;

  return {
    name: 'telegram',

    async start(handler: MessageHandler): Promise<void> {
      bot.command(['start', 'help'], async (ctx) => {
        await ctx.reply(
          "Hey! I'm Soul, your personal AI assistant. Just send me a message and I'll reply.\n\nCommands:\n/status — show current status\n/recall — show what I remember about you",
        );
      });

      bot.command('status', async (ctx) => {
        const text = options.onStatus?.() ?? 'Soul is online.';
        await ctx.reply(text);
      });

      bot.command('recall', async (ctx) => {
        const userId = `telegram:${String(ctx.from?.id ?? 'unknown')}`;
        if (options.onRecall) {
          await ctx.replyWithChatAction('typing');
          const text = await options.onRecall(userId);
          await ctx.reply(text);
        } else {
          await ctx.reply('Memory not available.');
        }
      });

      bot.on('message:text', async (ctx) => {
        const msg = ctx.message;
        if (!msg.text || msg.from?.is_bot) return;
        if (msg.text.startsWith('/')) return;

        // User allowlist check
        const allowedIds = (process.env.MEMPHIS_TELEGRAM_ALLOWED_USER_IDS ?? '')
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
        const fromId = msg.from?.id;
        if (allowedIds.length > 0 && (fromId === undefined || !allowedIds.includes(String(fromId)))) {
          await ctx.reply('Access denied.');
          return;
        }

        await ctx.replyWithChatAction('typing');
        const typingInterval = setInterval(() => {
          void ctx.replyWithChatAction('typing');
        }, 4000);

        try {
          await handler({
            id: String(msg.message_id),
            channel: 'telegram',
            userId: `telegram:${String(msg.from?.id ?? 'unknown')}`,
            chatId: String(msg.chat.id),
            text: msg.text,
            timestamp: new Date(msg.date * 1000),
          });
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          if (errMsg.includes('limit') || errMsg.includes('halt')) {
            await ctx.reply(
              'Przekroczyłem limit narzędzi w tej odpowiedzi. Zapytaj mnie ponownie.',
            );
          } else {
            await ctx.reply(`Wystąpił błąd: ${errMsg.slice(0, 200)}`);
          }
        } finally {
          clearInterval(typingInterval);
        }
      });

      void bot.start({ drop_pending_updates: true });
      started = true;
    },

    async send(chatId: string, text: string): Promise<void> {
      const trimmed = text?.trim();
      if (!trimmed) {
        await bot.api.sendMessage(chatId, '(brak odpowiedzi — spróbuj ponownie)');
        return;
      }
      const chunks = splitText(trimmed, 4096);
      for (const chunk of chunks) {
        await bot.api.sendMessage(chatId, chunk);
      }
    },

    async stop(): Promise<void> {
      if (started) await bot.stop();
    },
  };
}
