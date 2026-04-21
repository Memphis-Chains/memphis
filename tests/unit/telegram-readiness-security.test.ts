import { describe, expect, it } from 'vitest';

import {
  channelGatewayEnabled,
  parseTelegramAllowedUserIds,
  telegramAllowAllUsers,
} from '../../src/gateway/channels/telegram-readiness.js';

describe('telegramAllowAllUsers', () => {
  it('returns false when env var is absent', () => {
    expect(telegramAllowAllUsers({})).toBe(false);
  });

  it('accepts 1/true/yes case-insensitively', () => {
    for (const value of ['1', 'true', 'TRUE', 'Yes']) {
      expect(telegramAllowAllUsers({ MEMPHIS_TELEGRAM_ALLOW_ALL: value })).toBe(true);
    }
  });

  it('rejects other truthy-looking strings', () => {
    for (const value of ['0', 'false', 'no', 'on', 'maybe']) {
      expect(telegramAllowAllUsers({ MEMPHIS_TELEGRAM_ALLOW_ALL: value })).toBe(false);
    }
  });
});

describe('parseTelegramAllowedUserIds + channelGatewayEnabled (sanity)', () => {
  it('parses comma-separated user ids and ignores empty slots', () => {
    expect(
      parseTelegramAllowedUserIds({ MEMPHIS_TELEGRAM_ALLOWED_USER_IDS: '111, 222 ,, 333' }),
    ).toEqual(['111', '222', '333']);
  });

  it('channelGatewayEnabled only accepts exactly "true"', () => {
    expect(channelGatewayEnabled({ MEMPHIS_CHANNEL_GATEWAY_ENABLED: 'true' })).toBe(true);
    expect(channelGatewayEnabled({ MEMPHIS_CHANNEL_GATEWAY_ENABLED: 'TRUE' })).toBe(true);
    expect(channelGatewayEnabled({ MEMPHIS_CHANNEL_GATEWAY_ENABLED: '1' })).toBe(false);
    expect(channelGatewayEnabled({})).toBe(false);
  });
});
