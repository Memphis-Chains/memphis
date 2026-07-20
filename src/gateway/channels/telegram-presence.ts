import type { Bot } from 'grammy';

import { parseTelegramAllowedUserIds } from './telegram-readiness.js';
import { recordSurfaceActivity } from '../../core/surface-presence.js';

export function registerTelegramPresenceMiddleware(
  bot: Bot,
  getSessionTier: (chatId: string) => 0 | 1 | 2 | 3,
  rawEnv: NodeJS.ProcessEnv = process.env,
): void {
  bot.use(async (ctx, next) => {
    const fromId = ctx.from?.id;
    const chatId = ctx.chat?.id;
    if (chatId !== undefined) {
      const allowedIds = parseTelegramAllowedUserIds(rawEnv);
      const fromAllowed =
        allowedIds.length === 0 || (fromId !== undefined && allowedIds.includes(String(fromId)));
      if (fromAllowed) {
        recordSurfaceActivity({
          surface: 'telegram',
          actorId: `telegram:${String(fromId ?? 'unknown')}`,
          tier: getSessionTier(String(chatId)),
          telegramChatId: String(chatId),
        });
      }
    }
    await next();
  });
}
