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

/**
 * Detects an unresolved vault reference like `VAULT:telegram_bot_token`.
 *
 * The memphis-config layer expands `VAULT:<key>` references into the actual
 * secret. If the vault entry is missing, the config layer logs a warning but
 * leaves the literal `VAULT:...` string in the env var. Treating that literal
 * as a valid bot token is what produced the 2026-04-20 crash loop where
 * Telegram API returned `getMe 404` on every service start, driving the
 * systemd restart counter past 3000 in under 3 hours.
 */
function isUnresolvedVaultRef(token: string): boolean {
  return /^VAULT:/i.test(token);
}

export function resolveTelegramBotToken(rawEnv: NodeJS.ProcessEnv = process.env): string | null {
  const candidates: Array<string | undefined> = [
    rawEnv.MEMPHIS_TELEGRAM_TOKEN_OVERRIDE,
    rawEnv.MEMPHIS_TELEGRAM_BOT_TOKEN,
    rawEnv.TELEGRAM_BOT_TOKEN,
  ];
  for (const raw of candidates) {
    const trimmed = raw?.trim();
    if (!trimmed) continue;
    if (isUnresolvedVaultRef(trimmed)) continue;
    return trimmed;
  }
  return null;
}

export function resolveTelegramTokenSource(
  rawEnv: NodeJS.ProcessEnv = process.env,
): TelegramTokenSource {
  const override = rawEnv.MEMPHIS_TELEGRAM_TOKEN_OVERRIDE?.trim();
  if (override && !isUnresolvedVaultRef(override)) return 'memphis';
  const memphis = rawEnv.MEMPHIS_TELEGRAM_BOT_TOKEN?.trim();
  if (memphis && !isUnresolvedVaultRef(memphis)) return 'memphis';
  const legacy = rawEnv.TELEGRAM_BOT_TOKEN?.trim();
  if (legacy && !isUnresolvedVaultRef(legacy)) return 'legacy';
  return null;
}

export function channelGatewayEnabled(rawEnv: NodeJS.ProcessEnv = process.env): boolean {
  return (rawEnv.MEMPHIS_CHANNEL_GATEWAY_ENABLED ?? '').toLowerCase() === 'true';
}

export function parseTelegramAllowedUserIds(rawEnv: NodeJS.ProcessEnv = process.env): string[] {
  return (rawEnv.MEMPHIS_TELEGRAM_ALLOWED_USER_IDS ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
    // S2.5 fix: drop unresolved `VAULT:` literal references the same way
    // `resolveTelegramBotToken` does (line 36-37). Operator hit this on
    // 2026-04-26 — daemon's process.env had `MEMPHIS_TELEGRAM_ALLOWED_USER_IDS=
    // VAULT:telegram_allowed_user_ids` (vault propagation didn't reach this
    // path or env got reset). The split+trim above produced
    // `['VAULT:telegram_allowed_user_ids']` (length 1) — `/status` reported
    // "Allowlist: 1 ids" while every free-text message returned "Access
    // denied" because the literal could never match a real numeric Telegram
    // user id. Treating these as empty makes the readiness gate behave the
    // same as a missing token (operator gets a clear refuse-to-start signal
    // via MEMPHIS_TELEGRAM_ALLOW_ALL=1 escape hatch) instead of silently
    // locking out every authorized user.
    .filter((value) => !isUnresolvedVaultRef(value));
}

/**
 * Operator-acknowledged override for running the Telegram gateway without
 * any allowlist. Accepts any of '1', 'true', 'yes' (case-insensitive).
 *
 * Without this opt-in, an empty allowlist is a refusal-to-start condition
 * — the prior behaviour (gate short-circuits to pass-through when
 * allowedIds.length === 0) meant any Telegram user that guessed the bot
 * token could talk to the runtime, which is not a safe default. Codex
 * caught the regression in #202's setup wizard copy ("will reject every
 * inbound message") directly contradicting the gate logic.
 */
export function telegramAllowAllUsers(rawEnv: NodeJS.ProcessEnv = process.env): boolean {
  const raw = rawEnv.MEMPHIS_TELEGRAM_ALLOW_ALL?.trim().toLowerCase() ?? '';
  return raw === '1' || raw === 'true' || raw === 'yes';
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
