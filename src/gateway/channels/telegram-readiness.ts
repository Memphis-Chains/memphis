export type TelegramTokenSource = 'memphis' | 'legacy' | null;

export type TelegramReadinessState = 'disabled' | 'missing-token' | 'configured' | 'ready';

export type TelegramReadinessStatus = {
  state: TelegramReadinessState;
  gatewayEnabled: boolean;
  configured: boolean;
  ready: boolean;
  tokenSource: TelegramTokenSource;
  chatId: string | null;
  allowlistEnabled: boolean;
  allowlistCount: number;
  botName: string | null;
};

export function resolveTelegramBotToken(rawEnv: NodeJS.ProcessEnv = process.env): string | null {
  const overrideToken = rawEnv.MEMPHIS_TELEGRAM_TOKEN_OVERRIDE?.trim();
  if (overrideToken) return overrideToken;
  const memphisToken = rawEnv.MEMPHIS_TELEGRAM_BOT_TOKEN?.trim();
  if (memphisToken) return memphisToken;
  const legacyToken = rawEnv.TELEGRAM_BOT_TOKEN?.trim();
  return legacyToken || null;
}

export function resolveTelegramTokenSource(
  rawEnv: NodeJS.ProcessEnv = process.env,
): TelegramTokenSource {
  if (rawEnv.MEMPHIS_TELEGRAM_TOKEN_OVERRIDE?.trim()) return 'memphis';
  if (rawEnv.MEMPHIS_TELEGRAM_BOT_TOKEN?.trim()) return 'memphis';
  if (rawEnv.TELEGRAM_BOT_TOKEN?.trim()) return 'legacy';
  return null;
}

export function channelGatewayEnabled(rawEnv: NodeJS.ProcessEnv = process.env): boolean {
  return (rawEnv.MEMPHIS_CHANNEL_GATEWAY_ENABLED ?? '').toLowerCase() === 'true';
}

export function parseTelegramAllowedUserIds(
  rawEnv: NodeJS.ProcessEnv = process.env,
): string[] {
  return (rawEnv.MEMPHIS_TELEGRAM_ALLOWED_USER_IDS ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
}

export async function getTelegramReadinessStatus(
  rawEnv: NodeJS.ProcessEnv = process.env,
  options: {
    fetchImpl?: typeof fetch;
    includeRemoteBotLookup?: boolean;
  } = {},
): Promise<TelegramReadinessStatus> {
  const gateway = channelGatewayEnabled(rawEnv);
  const token = resolveTelegramBotToken(rawEnv);
  const tokenSource = resolveTelegramTokenSource(rawEnv);
  const configured = !!token;
  const ready = gateway && configured;
  const allowlistCount = parseTelegramAllowedUserIds(rawEnv).length;
  const chatId = rawEnv.MEMPHIS_TELEGRAM_CHAT_ID?.trim() || null;
  let botName: string | null = null;

  if (token && options.includeRemoteBotLookup !== false) {
    try {
      const fetchImpl = options.fetchImpl ?? fetch;
      const response = await fetchImpl(`https://api.telegram.org/bot${token}/getMe`, {
        signal: AbortSignal.timeout(5_000),
      });
      if (response.ok) {
        const payload = (await response.json()) as { result?: { username?: string } };
        botName = payload.result?.username ?? null;
      }
    } catch {
      botName = null;
    }
  }

  const state: TelegramReadinessState = !gateway
    ? 'disabled'
    : configured
      ? 'ready'
      : 'missing-token';

  return {
    state: configured && !gateway ? 'configured' : state,
    gatewayEnabled: gateway,
    configured,
    ready,
    tokenSource,
    chatId,
    allowlistEnabled: allowlistCount > 0,
    allowlistCount,
    botName,
  };
}
