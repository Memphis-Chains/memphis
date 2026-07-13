import { parseBool } from '../../core/env.js';
import { buildTier3EnvOverride } from '../../security/tier3-session.js';

export function isTelegramTier2FullAccess(rawEnv: NodeJS.ProcessEnv = process.env): boolean {
  return parseBool(rawEnv.MEMPHIS_TIER2_FULL_ACCESS, false);
}

export function buildTelegramTierEnvOverride(
  chatId: string,
  tier: 0 | 1 | 2 | 3,
): Record<string, string> | undefined {
  if (tier === 3) {
    const override = buildTier3EnvOverride('telegram', chatId);
    return Object.keys(override).length > 0 ? override : undefined;
  }
  if (tier === 2 && isTelegramTier2FullAccess()) {
    return {
      MEMPHIS_AUTONOMY_MODE: 'full',
      MEMPHIS_SURFACE_TELEGRAM_MAX_TOOL_TIER: '3',
      MEMPHIS_SURFACE_TELEGRAM_ALLOW_URL_FETCH: 'true',
      MEMPHIS_SURFACE_TELEGRAM_ALLOW_UNKNOWN_TOOLS: 'true',
      MEMPHIS_SURFACE_TELEGRAM_ALLOW_OPERATOR_OVERRIDE: 'true',
      MEMPHIS_TIER3_FS_UNRESTRICTED: 'true',
      GATEWAY_EXEC_RESTRICTED_MODE: 'false',
      MEMPHIS_WEB_FETCH_ALLOW_PRIVATE_NETWORK: 'true',
    };
  }
  if (tier === 2) return undefined;
  return {
    MEMPHIS_SURFACE_TELEGRAM_MAX_TOOL_TIER: String(tier),
    MEMPHIS_SURFACE_TELEGRAM_ALLOW_URL_FETCH: 'false',
    MEMPHIS_SURFACE_TELEGRAM_ALLOW_UNKNOWN_TOOLS: 'false',
    MEMPHIS_SURFACE_TELEGRAM_ALLOW_OPERATOR_OVERRIDE: 'false',
  };
}
