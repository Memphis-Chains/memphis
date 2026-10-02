import type { Bot } from 'grammy';

import { parseTelegramAllowedUserIds } from './telegram-readiness.js';
import { recordSurfaceActivity } from '../../core/surface-presence.js';
import { createLogger } from '../../infra/logging/logger.js';

/** Longest text preview kept per inbound update. Enough to identify the
 * message, short enough that a pasted log cannot flood the log file. */
const PREVIEW_LIMIT = 200;

/**
 * Inbound logging. Installed as middleware, so it covers every update the
 * gateway sees — free text, slash commands, voice, media — not just the
 * paths that reach a handler.
 *
 * Why this exists: the gateway had zero logging on the inbound side. An
 * operator seeing 12 executions with no content had no way to tell whether
 * Telegram delivered nothing, the allowlist rejected everything, or the
 * message died further downstream. This line answers that without a live
 * session.
 */
const log = createLogger('info', 'json', { component: 'telegram.inbound' });

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
        // The update reached the gateway, but we may drop it below. Log the
        // whole thing on the way in, not just the accepted branch.
        const text = 'text' in ctx.update ? String(ctx.update.text ?? '') : '';
        log.info('telegram inbound', {
          updateId: ctx.update.update_id,
          fromId: fromId === undefined ? null : String(fromId),
          username: ctx.from?.username ?? null,
          chatId: String(chatId),
          allowed: true,
          tier: getSessionTier(String(chatId)),
          preview: text.slice(0, PREVIEW_LIMIT),
        });
        recordSurfaceActivity({
          surface: 'telegram',
          actorId: `telegram:${String(fromId ?? 'unknown')}`,
          tier: getSessionTier(String(chatId)),
          telegramChatId: String(chatId),
        });
      } else {
        // Rejected by allowlist. This is the case that was invisible before:
        // the gateway was receiving traffic it would never act on.
        log.warn('telegram inbound rejected by allowlist', {
          updateId: ctx.update.update_id,
          fromId: fromId === undefined ? null : String(fromId),
          username: ctx.from?.username ?? null,
          chatId: String(chatId),
          allowed: false,
        });
      }
    }
    await next();
  });
}
