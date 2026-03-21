import { describe, expect, it } from 'vitest';

import { channelGatewayEnabled, resolveChannelGatewayToken } from '../../src/app/bootstrap.js';

describe('bootstrap channel gateway gating', () => {
  it('keeps channel gateway disabled by default', () => {
    expect(channelGatewayEnabled({} as NodeJS.ProcessEnv)).toBe(false);
    expect(resolveChannelGatewayToken({} as NodeJS.ProcessEnv)).toBeNull();
  });

  it('supports opt-in Telegram token resolution', () => {
    const env = {
      MEMPHIS_CHANNEL_GATEWAY_ENABLED: 'true',
      MEMPHIS_TELEGRAM_BOT_TOKEN: '  memphis-token  ',
    } as NodeJS.ProcessEnv;

    expect(channelGatewayEnabled(env)).toBe(true);
    expect(resolveChannelGatewayToken(env)).toBe('memphis-token');
  });

  it('falls back to legacy TELEGRAM_BOT_TOKEN for compatibility', () => {
    const env = {
      MEMPHIS_CHANNEL_GATEWAY_ENABLED: 'true',
      TELEGRAM_BOT_TOKEN: 'legacy-token',
    } as NodeJS.ProcessEnv;

    expect(resolveChannelGatewayToken(env)).toBe('legacy-token');
  });
});
