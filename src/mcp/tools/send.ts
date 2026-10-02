/* eslint-disable no-restricted-syntax */
//
// memphis_send tool — reads the Telegram bot token + chat id at
// invocation time. Single-consumer keys for this proactive-send path;
// adding registry accessors with one reader = registry bloat.
//
// 2026-10-01: this used to read `process.env` directly, and looked up
// two values this file was never going to find:
//
//   - `MEMPHIS_TELEGRAM_BOT_TOKEN` on the operator's machine holds
//     `VAULT:telegram_bot_token` — a reference, not a token. Sending it
//     verbatim puts `botVAULT:telegram_bot_token` in the URL; Telegram
//     answers 404 and the tool reports `sent: false` with a 404 in the
//     error string.
//   - `TELEGRAM_CHAT_ID` without the `MEMPHIS_` prefix. The operator's
//     `.env` sets `MEMPHIS_TELEGRAM_CHAT_ID`; the unprefixed name is
//     unset, so the call failed at chat resolution before the network
//     was ever touched.
//
// Both were invisible to the tests in `mcp-tools-extended.test.ts`,
// which set `TELEGRAM_BOT_TOKEN=test-token` and `TELEGRAM_CHAT_ID=12345`
// and stubbed `fetch` -- a fixture shaped to pass regardless of what the
// real configuration looks like. Those two cases are now pinned there
// against the operator-shaped environment.
//
import { MEMPHIS_SEND_TIMEOUT_MS } from '../../config/env-registry.js';
import { isUnresolvedVaultRef } from '../../infra/config/vault-ref.js';

/**
 * Resolves the Telegram bot token from the environment.
 *
 * Deliberately a local copy of the logic in
 * `gateway/channels/telegram-readiness.ts::resolveTelegramBotToken`
 * rather than an import of it. The shared module pulls in the
 * allowlist parser and the readiness probe, which reach the config
 * layer and its vault adapters; keeping that chain out of a tool that
 * only needs "which string is the token" keeps the tool importable
 * from a test without a mock ladder. The nine lines below are the whole
 * contract; the shared module stays the reference for anything that
 * needs the wider readiness surface.
 */
function resolveTelegramBotToken(rawEnv: NodeJS.ProcessEnv = process.env): string | null {
  const candidates = [
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

export interface SendInput {
  channel: 'telegram';
  message: string;
  chatId?: string;
}

export interface SendOutput {
  sent: boolean;
  channel: string;
  messageId?: number;
  error?: string;
}

/**
 * Send a message via an external channel (currently Telegram only).
 *
 * Token and chat id are resolved exactly as the inbound gateway resolves
 * them: a `VAULT:`-prefixed value is treated as a reference rather than
 * a credential, and both the `MEMPHIS_`-prefixed and legacy unprefixed
 * names are accepted for each. A reference reaching the API is a 404
 * that looks like a network problem, so the resolver is not optional
 * here even though it reads like ceremony.
 */
export async function runMemphisSend(input: SendInput): Promise<SendOutput> {
  if (input.channel !== 'telegram') {
    return { sent: false, channel: input.channel, error: `Unsupported channel: ${input.channel}` };
  }

  const token = resolveTelegramBotToken();
  if (!token) {
    return { sent: false, channel: 'telegram', error: 'TELEGRAM_BOT_TOKEN not configured' };
  }

  // `input.chatId` wins, then the `MEMPHIS_`-prefixed name the
  // operator's `.env` actually sets, then the legacy unprefixed one.
  const chatId =
    input.chatId?.trim() ||
    process.env.MEMPHIS_TELEGRAM_CHAT_ID?.trim() ||
    process.env.TELEGRAM_CHAT_ID?.trim();
  if (!chatId) {
    return {
      sent: false,
      channel: 'telegram',
      error: 'No chat ID provided (set MEMPHIS_TELEGRAM_CHAT_ID or pass chatId)',
    };
  }

  const url = `https://api.telegram.org/bot${token}/sendMessage`;

  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text: input.message,
      parse_mode: 'Markdown',
    }),
    // Phase 1.5.3 closeout: env-driven via MEMPHIS_SEND_TIMEOUT_MS
    // (default 1 min, was 10s hardcode).
    signal: AbortSignal.timeout(MEMPHIS_SEND_TIMEOUT_MS.read(process.env)),
  });

  if (!resp.ok) {
    const body = await resp.text().catch(() => 'unknown');
    return { sent: false, channel: 'telegram', error: `Telegram API ${resp.status}: ${body}` };
  }

  const data = (await resp.json()) as { result?: { message_id?: number } };
  return {
    sent: true,
    channel: 'telegram',
    messageId: data.result?.message_id,
  };
}
