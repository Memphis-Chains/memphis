import { resolveTelegramBotToken } from './telegram-readiness.js';

export type TelegramSendResult = {
  ok: boolean;
  messageId?: number;
  chatId?: string;
  error?: string;
};

/**
 * parseMode controls Telegram entity rendering.
 * - 'plain' (default): no parse_mode sent; Telegram renders text literally with
 *   zero entity-parse risk. Safe-by-default after Zawoja 2026-05-06 incident
 *   where unescaped Markdown crashed report delivery ("can't parse entities at
 *   byte offset 442").
 * - 'MarkdownV2': caller pre-escapes interpolated content via escapeMarkdownV2
 *   from ./telegram-escape.js and provides static markup raw (e.g. *bold*).
 */
export type TelegramParseMode = 'plain' | 'MarkdownV2';

export async function sendTelegramMessage(options: {
  message: string;
  chatId?: string;
  rawEnv?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  parseMode?: TelegramParseMode;
}): Promise<TelegramSendResult> {
  const rawEnv = options.rawEnv ?? process.env;
  const fetchImpl = options.fetchImpl ?? fetch;
  const token = resolveTelegramBotToken(rawEnv);
  const resolvedChatId = options.chatId ?? rawEnv.MEMPHIS_TELEGRAM_CHAT_ID?.trim();
  const parseMode = options.parseMode ?? 'plain';

  if (!token) {
    return { ok: false, error: 'MEMPHIS_TELEGRAM_BOT_TOKEN not configured' };
  }

  if (!resolvedChatId) {
    return {
      ok: false,
      error: 'No chat ID. Set MEMPHIS_TELEGRAM_CHAT_ID or use --to <chatId>',
    };
  }

  try {
    const body: Record<string, unknown> = {
      chat_id: resolvedChatId,
      text: options.message,
    };
    if (parseMode === 'MarkdownV2') {
      body.parse_mode = 'MarkdownV2';
    }
    const response = await fetchImpl(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: options.signal ?? AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => 'unknown');
      return { ok: false, error: `Telegram API ${response.status}: ${body}` };
    }

    const data = (await response.json()) as { result?: { message_id?: number } };
    return {
      ok: true,
      messageId: data.result?.message_id,
      chatId: resolvedChatId,
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
