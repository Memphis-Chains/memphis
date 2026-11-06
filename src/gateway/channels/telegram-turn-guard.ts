import type { Bot } from 'grammy';

import {
  isTelegramModelProbe,
  isTelegramStatusProbe,
  isTelegramToolsProbe,
} from './telegram-probes.js';
import { isAllowedTelegramUser } from './telegram-tier-session.js';
import { createLogger } from '../../infra/logging/logger.js';
import { resolveActorId } from '../conversation-identity.js';

const log = createLogger('info', 'json', { component: 'telegram.turn' });
export const TELEGRAM_BUSY_REPLY =
  'Nadal pracuję nad poprzednią wiadomością. Tej jeszcze nie przetworzyłem — wyślij ją ponownie po zakończeniu pracy.';

export function createTelegramTurnGuard() {
  const chats = new Set<string>();
  const actors = new Set<string>();
  const owners = new Map<string, string>();
  return {
    busy(chatId: string, userId: string): boolean {
      return chats.has(chatId) || actors.has(resolveActorId(userId));
    },
    acquire(chatId: string, userId: string): boolean {
      const actorId = resolveActorId(userId);
      if (chats.has(chatId) || actors.has(actorId)) return false;
      chats.add(chatId);
      actors.add(actorId);
      owners.set(chatId, actorId);
      return true;
    },
    release(chatId: string): void {
      chats.delete(chatId);
      const actorId = owners.get(chatId);
      if (actorId) actors.delete(actorId);
      owners.delete(chatId);
    },
  };
}

export type TelegramTurnGuard = ReturnType<typeof createTelegramTurnGuard>;

function isSafeDuringTurn(text: string): boolean {
  return (
    /^\/(status|help|start|model|tools|restart)(?:@[a-z0-9_]+)?(?:\s|$)/i.test(text) ||
    /^\/tier(?:@[a-z0-9_]+)?(?:\s+(?:status|revoke))?\s*$/i.test(text) ||
    isTelegramStatusProbe(text) ||
    isTelegramModelProbe(text) ||
    isTelegramToolsProbe(text)
  );
}

/** Reject media and mutating commands while a detached text turn is active. */
export function registerTelegramTurnGuardMiddleware(bot: Bot, guard: TelegramTurnGuard): void {
  bot.use(async (ctx, next) => {
    const msg = ctx.message;
    const fromId = msg?.from?.id;
    if (!msg || fromId === undefined || !isAllowedTelegramUser(fromId)) return next();
    const chatId = String(msg.chat.id);
    const userId = `telegram:${fromId}`;
    if (!guard.busy(chatId, userId) || (msg.text && isSafeDuringTurn(msg.text))) return next();
    await ctx
      .reply(TELEGRAM_BUSY_REPLY)
      .catch(() => log.warn('telegram busy notice delivery failed'));
  });
}
