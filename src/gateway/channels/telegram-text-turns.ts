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
import {
  createTelegramTurnGuard,
  TELEGRAM_BUSY_REPLY,
  type TelegramTurnGuard,
} from './telegram-turn-guard.js';
import { createLogger } from '../../infra/logging/logger.js';
import type { MessageHandler } from '../chat-types.js';

const log = createLogger('info', 'json', { component: 'telegram.turn' });

function describeTurnError(error: unknown): { category: string; reply: string } {
  const message = error instanceof Error ? error.message : String(error);
  const partial = ' Część działań mogła już zostać wykonana — sprawdź je przed ponowieniem.';
  if (/rate.?limit|too many requests|\b429\b/i.test(message)) {
    return {
      category: 'rate-limit',
      reply: 'Dostawca ograniczył liczbę żądań. Spróbuj później.' + partial,
    };
  }
  if (/timeout|timed out|deadline|nie odpowiedział.*czas/i.test(message)) {
    return { category: 'timeout', reply: 'Przekroczono czas oczekiwania na odpowiedź.' + partial };
  }
  if (/context.{0,40}(window|length|limit)|too many tokens/i.test(message)) {
    return {
      category: 'context',
      reply: 'Przekroczono limit kontekstu modelu. Spróbuj krótszej prośby.' + partial,
    };
  }
  if (/limit|halt/i.test(message)) {
    return { category: 'limit', reply: 'Przerwałem pracę po osiągnięciu limitu.' + partial };
  }
  return {
    category: 'other',
    reply: 'Nie udało mi się zakończyć odpowiedzi. Sprawdź status i spróbuj ponownie.' + partial,
  };
}

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
  guard: TelegramTurnGuard = createTelegramTurnGuard(),
): void {
  // grammY's built-in polling waits for each update handler. Keep polling
  // responsive while a turn runs, but never run two text turns in one chat
  // or in two chats that resolve to the same conversation actor.
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

    if (!guard.acquire(chatId, userId)) {
      await ctx
        .reply(TELEGRAM_BUSY_REPLY)
        .catch(() => log.warn('telegram busy notice delivery failed'));
      return;
    }
    const run = async (): Promise<void> => {
      let typingInterval: ReturnType<typeof setInterval> | undefined;
      try {
        // Typing indicators are optional; a network failure must not abort
        // the turn or create an unhandled interval rejection.
        void ctx.replyWithChatAction('typing').catch(() => undefined);
        typingInterval = setInterval(() => {
          void ctx.replyWithChatAction('typing').catch(() => undefined);
        }, 4000);

        let systemPromptAppend: string | undefined;
        if (!seenChatIds.has(chatId) && options.onStartupContext) {
          seenChatIds.add(chatId);
          try {
            systemPromptAppend = await options.onStartupContext(userId, sessionTier);
          } catch {
            // Non-fatal — continue without startup context.
          }
        } else {
          seenChatIds.add(chatId);
        }

        await handler({
          id: String(msg.message_id),
          channel: 'telegram',
          userId,
          chatId,
          text: msg.text!,
          timestamp: new Date(msg.date * 1000),
          rawEnvOverride,
          systemPromptAppend,
        });
      } catch (err) {
        const { category, reply } = describeTurnError(err);
        log.warn('telegram turn failed', { category });
        await ctx.reply(reply).catch(() => log.warn('telegram error reply delivery failed'));
      } finally {
        if (typingInterval) clearInterval(typingInterval);
        guard.release(chatId);
      }
    };
    void run();
  });
}
