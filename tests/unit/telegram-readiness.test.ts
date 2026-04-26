import { describe, expect, it, vi } from 'vitest';

import {
  getTelegramReadinessStatus,
  parseTelegramAllowedUserIds,
  resolveTelegramBotToken,
  resolveTelegramTokenSource,
} from '../../src/gateway/channels/telegram-readiness.js';

describe('telegram readiness', () => {
  it('parses allowlist ids consistently', () => {
    const ids = parseTelegramAllowedUserIds({
      MEMPHIS_TELEGRAM_ALLOWED_USER_IDS: ' 123,456 , ,789 ',
    } as NodeJS.ProcessEnv);
    expect(ids).toEqual(['123', '456', '789']);
  });

  // S2.5 fix Bug 1: regression for the 2026-04-26 incident where the
  // operator's daemon had `MEMPHIS_TELEGRAM_ALLOWED_USER_IDS=
  // VAULT:telegram_allowed_user_ids` (vault propagation didn't reach the
  // gateway env). The split+trim logic produced length=1 with the literal
  // VAULT: string, so /status reported "Allowlist: 1 ids" while every
  // free-text message returned "Access denied" because the literal could
  // never match a real numeric Telegram user id. Filtering at parse time
  // makes the readiness gate behave the same as a missing token: the
  // "Refusing to start Telegram gateway" startup check fires loudly and
  // the operator sees an actionable error instead of a silent lockout.
  it('drops unresolved VAULT: literals from the allowlist', () => {
    const ids = parseTelegramAllowedUserIds({
      MEMPHIS_TELEGRAM_ALLOWED_USER_IDS: 'VAULT:telegram_allowed_user_ids',
    } as NodeJS.ProcessEnv);
    expect(ids).toEqual([]);
  });

  it('drops VAULT: literals while keeping legitimate ids in mixed input', () => {
    const ids = parseTelegramAllowedUserIds({
      MEMPHIS_TELEGRAM_ALLOWED_USER_IDS: 'VAULT:foo, 1316033647 , VAULT:bar, 42',
    } as NodeJS.ProcessEnv);
    expect(ids).toEqual(['1316033647', '42']);
  });

  it('drops VAULT: literals case-insensitively (matches isUnresolvedVaultRef)', () => {
    const ids = parseTelegramAllowedUserIds({
      MEMPHIS_TELEGRAM_ALLOWED_USER_IDS: 'vault:foo,Vault:bar,VAULT:baz',
    } as NodeJS.ProcessEnv);
    expect(ids).toEqual([]);
  });

  it('prefers override token and reports ready gateway state', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ result: { username: 'memphis_bot' } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const env = {
      MEMPHIS_CHANNEL_GATEWAY_ENABLED: 'true',
      MEMPHIS_TELEGRAM_TOKEN_OVERRIDE: 'override-token',
      MEMPHIS_TELEGRAM_CHAT_ID: '42',
      MEMPHIS_TELEGRAM_ALLOWED_USER_IDS: '11,12',
    } as NodeJS.ProcessEnv;

    expect(resolveTelegramBotToken(env)).toBe('override-token');
    expect(resolveTelegramTokenSource(env)).toBe('memphis');

    const status = await getTelegramReadinessStatus(env, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(status.state).toBe('ready');
    expect(status.ready).toBe(true);
    expect(status.gatewayEnabled).toBe(true);
    expect(status.allowlistEnabled).toBe(true);
    expect(status.allowlistCount).toBe(2);
    expect(status.botName).toBe('memphis_bot');
  });

  it('reports configured when token exists but gateway is disabled', async () => {
    const status = await getTelegramReadinessStatus(
      {
        MEMPHIS_TELEGRAM_BOT_TOKEN: 'token',
      } as NodeJS.ProcessEnv,
      { includeRemoteBotLookup: false },
    );

    expect(status.state).toBe('configured');
    expect(status.gatewayEnabled).toBe(false);
    expect(status.ready).toBe(false);
    expect(status.tokenSource).toBe('memphis');
  });

  it('reports missing token when gateway is enabled without credentials', async () => {
    const status = await getTelegramReadinessStatus(
      {
        MEMPHIS_CHANNEL_GATEWAY_ENABLED: 'true',
      } as NodeJS.ProcessEnv,
      { includeRemoteBotLookup: false },
    );

    expect(status.state).toBe('missing-token');
    expect(status.configured).toBe(false);
    expect(status.ready).toBe(false);
    expect(status.tokenSource).toBeNull();
  });

  // Regression guard for the 2026-04-20 crash loop (systemd restart counter
  // passed 3000 in under 3 hours) triggered when `MEMPHIS_TELEGRAM_BOT_TOKEN`
  // resolved to a literal `VAULT:telegram_bot_token` string because the vault
  // entry was missing. The gateway accepted the literal, called Telegram
  // `getMe`, and took a 404 → `unhandled rejection` → process exit.
  describe('unresolved VAULT: reference guard', () => {
    it('skips literal VAULT: reference and returns null', () => {
      const env = {
        MEMPHIS_TELEGRAM_BOT_TOKEN: 'VAULT:telegram_bot_token',
      } as NodeJS.ProcessEnv;
      expect(resolveTelegramBotToken(env)).toBeNull();
      expect(resolveTelegramTokenSource(env)).toBeNull();
    });

    it('skips VAULT: literal case-insensitively', () => {
      const env = {
        TELEGRAM_BOT_TOKEN: 'vault:something',
      } as NodeJS.ProcessEnv;
      expect(resolveTelegramBotToken(env)).toBeNull();
      expect(resolveTelegramTokenSource(env)).toBeNull();
    });

    it('falls through to the next candidate when the first is a VAULT: literal', () => {
      const env = {
        MEMPHIS_TELEGRAM_TOKEN_OVERRIDE: 'VAULT:unresolved',
        MEMPHIS_TELEGRAM_BOT_TOKEN: 'real-token',
      } as NodeJS.ProcessEnv;
      expect(resolveTelegramBotToken(env)).toBe('real-token');
      expect(resolveTelegramTokenSource(env)).toBe('memphis');
    });

    it('reports missing-token readiness when only a VAULT: literal is set', async () => {
      const status = await getTelegramReadinessStatus(
        {
          MEMPHIS_CHANNEL_GATEWAY_ENABLED: 'true',
          MEMPHIS_TELEGRAM_BOT_TOKEN: 'VAULT:telegram_bot_token',
        } as NodeJS.ProcessEnv,
        { includeRemoteBotLookup: false },
      );
      expect(status.state).toBe('missing-token');
      expect(status.configured).toBe(false);
      expect(status.ready).toBe(false);
      expect(status.tokenSource).toBeNull();
    });
  });
});
