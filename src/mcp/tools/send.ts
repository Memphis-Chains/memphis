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
 * Requires TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID env vars.
 */
export async function runMemphisSend(input: SendInput): Promise<SendOutput> {
  if (input.channel !== 'telegram') {
    return { sent: false, channel: input.channel, error: `Unsupported channel: ${input.channel}` };
  }

  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = input.chatId ?? process.env.TELEGRAM_CHAT_ID;

  if (!token) {
    return { sent: false, channel: 'telegram', error: 'TELEGRAM_BOT_TOKEN not configured' };
  }
  if (!chatId) {
    return {
      sent: false,
      channel: 'telegram',
      error: 'No chat ID provided (set TELEGRAM_CHAT_ID or pass chatId)',
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
    signal: AbortSignal.timeout(10_000),
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
