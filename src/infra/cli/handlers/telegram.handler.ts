import type { CliContext } from '../context.js';
import type { CommandHandler } from './command-handler.js';
import { print } from '../utils/render.js';

export const telegramCommandHandler: CommandHandler = {
  name: 'telegram',
  commands: ['telegram'],
  canHandle(context: CliContext): boolean {
    return context.args.command === 'telegram';
  },
  async handle(context: CliContext): Promise<boolean> {
    const { subcommand } = context.args;
    const handlers: Record<string, () => Promise<boolean>> = {
      send: () => handleTelegramSend(context),
      status: () => handleTelegramStatus(context),
    };
    const handler = subcommand ? handlers[subcommand] : handlers.status;
    return handler();
  },
};

async function handleTelegramSend(context: CliContext): Promise<boolean> {
  const { json, value: message, to: chatId } = context.args;
  if (!message) {
    throw new Error('telegram send requires --value <message>');
  }

  const token = process.env.TELEGRAM_BOT_TOKEN;
  const resolvedChatId = chatId ?? process.env.TELEGRAM_CHAT_ID;

  if (!token) {
    print({ ok: false, error: 'TELEGRAM_BOT_TOKEN not configured' }, json);
    return true;
  }
  if (!resolvedChatId) {
    print({ ok: false, error: 'No chat ID. Set TELEGRAM_CHAT_ID or use --to <chatId>' }, json);
    return true;
  }

  const url = `https://api.telegram.org/bot${token}/sendMessage`;

  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: resolvedChatId,
        text: message,
        parse_mode: 'Markdown',
      }),
      signal: AbortSignal.timeout(10_000),
    });

    if (!resp.ok) {
      const body = await resp.text().catch(() => 'unknown');
      print({ ok: false, error: `Telegram API ${resp.status}: ${body}` }, json);
      return true;
    }

    const data = (await resp.json()) as { result?: { message_id?: number } };
    print({ ok: true, messageId: data.result?.message_id, chatId: resolvedChatId }, json);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    print({ ok: false, error: msg }, json);
  }
  return true;
}

async function handleTelegramStatus(context: CliContext): Promise<boolean> {
  const { json } = context.args;
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  const configured = !!token;
  let botName: string | undefined;

  if (token) {
    try {
      const resp = await fetch(`https://api.telegram.org/bot${token}/getMe`, {
        signal: AbortSignal.timeout(5_000),
      });
      if (resp.ok) {
        const data = (await resp.json()) as { result?: { username?: string } };
        botName = data.result?.username;
      }
    } catch {
      // Network error — bot name unavailable
    }
  }

  if (json) {
    print({ configured, botName: botName ?? null, chatId: chatId ?? null }, true);
  } else {
    console.log(`Telegram: ${configured ? 'configured' : 'not configured'}`);
    if (botName) console.log(`  Bot: @${botName}`);
    if (chatId) console.log(`  Chat ID: ${chatId}`);
    if (!configured) {
      console.log('  Set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in your .env');
    }
  }
  return true;
}
