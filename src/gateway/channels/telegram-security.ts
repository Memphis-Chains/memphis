import { parseTelegramAllowedUserIds, telegramAllowAllUsers } from './telegram-readiness.js';

export function assertTelegramAccessConfigured(rawEnv: NodeJS.ProcessEnv = process.env): void {
  const allowed = parseTelegramAllowedUserIds(rawEnv);
  const allowAll = telegramAllowAllUsers(rawEnv);
  if (allowed.length === 0 && !allowAll) {
    throw new Error(
      'Refusing to start Telegram gateway: allowlist is empty and ' +
        'MEMPHIS_TELEGRAM_ALLOW_ALL is not set. Either ' +
        'set MEMPHIS_TELEGRAM_ALLOWED_USER_IDS=<csv of user ids> in .env ' +
        '(preferred) or explicitly opt into open access with ' +
        'MEMPHIS_TELEGRAM_ALLOW_ALL=1 (ONLY for solo-operator sandboxes ' +
        'where the bot token is not shared). Re-run `memphis setup telegram ' +
        '--allowed-user-ids <ids>` to configure.',
    );
  }
  if (allowed.length === 0 && allowAll) {
    console.warn(
      '[telegram] MEMPHIS_TELEGRAM_ALLOW_ALL=1 and allowlist empty — ' +
        'the bot will accept messages from every Telegram user. ' +
        'This is a single-operator sandbox opt-in; do not use in production.',
    );
  }
}

export function isTelegramUserAllowed(
  fromId: number | undefined,
  rawEnv: NodeJS.ProcessEnv = process.env,
): boolean {
  const allowed = parseTelegramAllowedUserIds(rawEnv);
  return allowed.length === 0 || (fromId !== undefined && allowed.includes(String(fromId)));
}
