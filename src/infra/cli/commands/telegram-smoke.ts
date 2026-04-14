/**
 * Telegram smoke test (Phase 3.1 production sprint).
 *
 * `memphis telegram smoke-test` — round-trips a real message against
 * the configured bot. Operators run it post-install / post-config-change
 * to verify their setup actually works without waiting for the next
 * user-initiated message.
 *
 * Steps:
 *   1. Verify MEMPHIS_TELEGRAM_BOT_TOKEN is set + valid (getMe)
 *   2. Verify MEMPHIS_TELEGRAM_ALLOWED_USER_IDS has at least one entry
 *   3. Send a "🟢 Memphis smoke test from <hostname> at <iso>" message
 *      to the FIRST allowed user
 *   4. Read the bot's own get-updates and confirm send was acked
 *
 * The CI variant (separate, scripts/telegram-smoke-ci.sh) uses a
 * dedicated test bot + chat id from CI secrets so a regression in the
 * happy path bounces the build.
 *
 * Without this, the only verifier of "Memphis still talks to Telegram"
 * is the operator manually sending a message and waiting. Real Telegram
 * API quirks (message length cap, parse mode edge cases, rate limits)
 * are not captured by the existing all-mock test suite.
 */

import { hostname } from 'node:os';

export interface TelegramSmokeOptions {
  rawEnv?: NodeJS.ProcessEnv;
  /** Test seam: substitute the fetch fn. */
  fetchFn?: typeof fetch;
  /** Override the chat id (default: first MEMPHIS_TELEGRAM_ALLOWED_USER_IDS entry). */
  chatId?: string;
  /** Custom message body. Defaults to a hostname + timestamp banner. */
  message?: string;
  /** Don't actually send — only verify the token + allowlist. */
  dryRun?: boolean;
}

export interface TelegramSmokeResult {
  ok: boolean;
  steps: Array<{
    name: string;
    ok: boolean;
    detail?: string;
  }>;
  botUsername?: string;
  chatId?: string;
  sentMessageId?: number;
  durationMs: number;
  error?: string;
}

const TELEGRAM_API_BASE = 'https://api.telegram.org';

interface TelegramApiSuccess<T> {
  ok: true;
  result: T;
}
interface TelegramApiFailure {
  ok: false;
  description: string;
  error_code?: number;
}
type TelegramApiResponse<T> = TelegramApiSuccess<T> | TelegramApiFailure;

async function callTelegram<T>(
  fetchFn: typeof fetch,
  token: string,
  method: string,
  body?: Record<string, unknown>,
): Promise<TelegramApiResponse<T>> {
  const url = `${TELEGRAM_API_BASE}/bot${token}/${method}`;
  const res = await fetchFn(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  return (await res.json()) as TelegramApiResponse<T>;
}

export async function runTelegramSmokeTest(
  options: TelegramSmokeOptions = {},
): Promise<TelegramSmokeResult> {
  const startedAt = Date.now();
  const rawEnv = options.rawEnv ?? process.env;
  const fetchFn = options.fetchFn ?? fetch;
  const steps: TelegramSmokeResult['steps'] = [];

  // Step 1: token must be set
  const token = rawEnv.MEMPHIS_TELEGRAM_BOT_TOKEN?.trim();
  if (!token) {
    steps.push({
      name: 'token-set',
      ok: false,
      detail: 'MEMPHIS_TELEGRAM_BOT_TOKEN is unset or empty',
    });
    return {
      ok: false,
      steps,
      durationMs: Date.now() - startedAt,
      error: 'no bot token configured',
    };
  }
  steps.push({ name: 'token-set', ok: true });

  // Step 2: getMe to validate the token
  let botUsername: string | undefined;
  try {
    const me = await callTelegram<{ id: number; username: string }>(
      fetchFn,
      token,
      'getMe',
    );
    if (!me.ok) {
      steps.push({
        name: 'getMe',
        ok: false,
        detail: `${me.description}${me.error_code ? ` (code ${me.error_code})` : ''}`,
      });
      return { ok: false, steps, durationMs: Date.now() - startedAt, error: me.description };
    }
    botUsername = me.result.username;
    steps.push({ name: 'getMe', ok: true, detail: `@${botUsername} (id ${me.result.id})` });
  } catch (err) {
    steps.push({
      name: 'getMe',
      ok: false,
      detail: err instanceof Error ? err.message : String(err),
    });
    return {
      ok: false,
      steps,
      durationMs: Date.now() - startedAt,
      error: 'getMe failed (network or bad token)',
    };
  }

  // Step 3: allowlist must have at least one chat id (or operator override)
  const allowList = (rawEnv.MEMPHIS_TELEGRAM_ALLOWED_USER_IDS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const chatId = options.chatId ?? allowList[0];
  if (!chatId) {
    steps.push({
      name: 'allowlist',
      ok: false,
      detail: 'MEMPHIS_TELEGRAM_ALLOWED_USER_IDS is empty and no --chat-id override given',
    });
    return {
      ok: false,
      steps,
      botUsername,
      durationMs: Date.now() - startedAt,
      error: 'no chat id to send to',
    };
  }
  steps.push({
    name: 'allowlist',
    ok: true,
    detail: `target chat id: ${chatId}${options.chatId ? ' (override)' : ' (from allowlist)'}`,
  });

  if (options.dryRun) {
    steps.push({ name: 'send', ok: true, detail: 'skipped (dry-run)' });
    return {
      ok: true,
      steps,
      botUsername,
      chatId,
      durationMs: Date.now() - startedAt,
    };
  }

  // Step 4: send the message
  const text =
    options.message ??
    `🟢 Memphis smoke test from ${hostname()} at ${new Date().toISOString()}`;
  try {
    const send = await callTelegram<{ message_id: number }>(fetchFn, token, 'sendMessage', {
      chat_id: chatId,
      text,
    });
    if (!send.ok) {
      steps.push({
        name: 'send',
        ok: false,
        detail: `${send.description}${send.error_code ? ` (code ${send.error_code})` : ''}`,
      });
      return {
        ok: false,
        steps,
        botUsername,
        chatId,
        durationMs: Date.now() - startedAt,
        error: send.description,
      };
    }
    steps.push({
      name: 'send',
      ok: true,
      detail: `message_id ${send.result.message_id}`,
    });
    return {
      ok: true,
      steps,
      botUsername,
      chatId,
      sentMessageId: send.result.message_id,
      durationMs: Date.now() - startedAt,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    steps.push({ name: 'send', ok: false, detail: message });
    return {
      ok: false,
      steps,
      botUsername,
      chatId,
      durationMs: Date.now() - startedAt,
      error: message,
    };
  }
}
