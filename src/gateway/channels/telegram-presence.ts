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

/**
 * The text of an inbound update, whatever shape it arrives in.
 *
 * grammY hands the middleware the RAW update object. A text message is
 * `{ update_id, message: { text } }` — there is no `text` at the top
 * level. A caption arrives as `message.caption` (a photo with a caption),
 * and a callback query carries its text one level deeper still.
 *
 * Exported so the behaviour can be tested against real update shapes
 * instead of a shape invented for the test.
 */
export function extractInboundText(update: unknown): string {
  if (!update || typeof update !== 'object') return '';
  const candidate = update as {
    message?: { text?: unknown; caption?: unknown };
    edited_message?: { text?: unknown; caption?: unknown };
    channel_post?: { text?: unknown; caption?: unknown };
    callback_query?: { message?: { text?: unknown; caption?: unknown } };
  };
  const holders = [
    candidate.message,
    candidate.edited_message,
    candidate.channel_post,
    candidate.callback_query?.message,
  ];
  for (const holder of holders) {
    if (!holder) continue;
    const value = holder.text ?? holder.caption;
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return '';
}

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
        //
        // The text lives under `ctx.update.message.text` (or
        // `ctx.update.callback_query.message.text`), NOT under
        // `ctx.update.text`. Measured 2026-11-20: the old code asked
        // `'text' in ctx.update`, which is false for every real Telegram
        // update, so the preview was an empty string in ALL 93 logged
        // inbound messages. The log line that was supposed to answer "what
        // did the operator write" showed nothing — the very question the
        // 2026-11-19 diagnosis of the silent Telegram gateway could not
        // answer. `ctx.msg` is grammY's own alias that covers every
        // message-bearing update, so it is the shape to read.
        const text = extractInboundText(ctx.update);
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
