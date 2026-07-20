import type { Bot } from 'grammy';

import { subscribeTier3Lifecycle } from '../../security/tier3-session.js';

export function subscribeTelegramTierLifecycle(bot: Bot): void {
  subscribeTier3Lifecycle((event) => {
    if (event.session.surface !== 'telegram') return;
    const chatId = event.session.actorId;
    const remainingMin = 'remainingMs' in event ? Math.round(event.remainingMs / 60_000) : 0;
    const text =
      event.kind === 'expiring-soon'
        ? `⏰ Tier 3 wygasa za ~${remainingMin} min. Jeśli chcesz kontynuować, ` +
          'odpal `/tier 3 <pass>` lub poczekaj na koniec.'
        : event.kind === 'expired'
          ? '⚠ Tier 3 wygasł. Wracam do tier 2 (chat surface). ' +
            'Aby ponownie odblokować — `/tier 3 <pass>`.'
          : `↩ Tier 3 cofnięty (${event.reason}). Jesteś na tier 2.`;
    bot.api.sendMessage(chatId, text).catch(() => {
      // Best-effort: the lifecycle audit already preserves the event.
    });
  });
}
