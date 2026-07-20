import type { Bot } from 'grammy';

import {
  isTelegramModelProbe,
  isTelegramStatusProbe,
  isTelegramToolsProbe,
} from './telegram-probes.js';
import { buildTelegramTierEnvOverride } from './telegram-tier-policy.js';
import {
  getTelegramSessionTier,
  isAllowedTelegramUser,
  type TelegramOperatorContext,
} from './telegram-tier-session.js';
import type { MessageHandler } from '../chat-types.js';

type TextTurnOptions = {
  onStatus?: () => string;
  onTools?: (context: TelegramOperatorContext) => string | Promise<string>;
  onModel?: (context: TelegramOperatorContext) => string | Promise<string>;
  onStartupContext?: (userId: string, sessionTier: 0 | 1 | 2 | 3) => Promise<string>;
};

export function registerTelegramTextTurns(
  bot: Bot,
  options: TextTurnOptions,
  handler: MessageHandler,
  seenChatIds: Set<string>,
): void {
  bot.on('message:text', async (ctx) => {
    const msg = ctx.message;
    if (!msg.text || msg.from?.is_bot) return;
    if (msg.text.startsWith('/')) return;

    // User allowlist check
    const fromId = msg.from?.id;
    if (!isAllowedTelegramUser(fromId)) {
      await ctx.reply('Access denied.');
      return;
    }

    const chatId = String(msg.chat.id);
    const userId = `telegram:${String(msg.from?.id ?? 'unknown')}`;
    const sessionTier = getTelegramSessionTier(chatId);
    const rawEnvOverride = buildTelegramTierEnvOverride(chatId, sessionTier);
    const operatorContext: TelegramOperatorContext = {
      chatId,
      userId,
      sessionTier,
      rawEnvOverride,
    };

    if (isTelegramToolsProbe(msg.text) && options.onTools) {
      await ctx.reply(await options.onTools(operatorContext));
      return;
    }
    if (isTelegramModelProbe(msg.text) && options.onModel) {
      await ctx.reply(await options.onModel(operatorContext));
      return;
    }
    if (isTelegramStatusProbe(msg.text) && options.onStatus) {
      await ctx.reply(options.onStatus());
      return;
    }

    await ctx.replyWithChatAction('typing');
    const typingInterval = setInterval(() => {
      void ctx.replyWithChatAction('typing');
    }, 4000);

    // (Surface activity already recorded by the global middleware above —
    // S2.5 Bug 2 fix: every inbound message goes through there now.)

    // Startup context: injected once per chatId per bot session
    let systemPromptAppend: string | undefined;
    if (!seenChatIds.has(chatId) && options.onStartupContext) {
      seenChatIds.add(chatId);
      try {
        systemPromptAppend = await options.onStartupContext(userId, sessionTier);
      } catch {
        // non-fatal — continue without startup context
      }
    } else {
      seenChatIds.add(chatId);
    }

    try {
      await handler({
        id: String(msg.message_id),
        channel: 'telegram',
        userId,
        chatId,
        text: msg.text,
        timestamp: new Date(msg.date * 1000),
        rawEnvOverride,
        systemPromptAppend,
      });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      if (errMsg.includes('limit') || errMsg.includes('halt')) {
        await ctx.reply('Przekroczyłem limit narzędzi w tej odpowiedzi. Zapytaj mnie ponownie.');
      } else {
        await ctx.reply(`Wystąpił błąd: ${errMsg.slice(0, 200)}`);
      }
    } finally {
      clearInterval(typingInterval);
    }
  });
}
