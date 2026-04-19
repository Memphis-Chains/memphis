import { resolveTelegramBotToken } from './telegram-readiness.js';

export type TelegramSendResult = {
  ok: boolean;
  messageId?: number;
  chatId?: string;
  error?: string;
};

export async function sendTelegramMessage(options: {
  message: string;
  chatId?: string;
  rawEnv?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}): Promise<TelegramSendResult> {
  const rawEnv = options.rawEnv ?? process.env;
  const fetchImpl = options.fetchImpl ?? fetch;
  const token = resolveTelegramBotToken(rawEnv);
  const resolvedChatId = options.chatId ?? rawEnv.MEMPHIS_TELEGRAM_CHAT_ID?.trim();

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
    const response = await fetchImpl(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: resolvedChatId,
        text: options.message,
        parse_mode: 'Markdown',
      }),
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
