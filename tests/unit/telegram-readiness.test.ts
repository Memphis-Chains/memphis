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
});
