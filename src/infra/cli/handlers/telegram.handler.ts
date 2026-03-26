import type { CliContext } from '../context.js';
import type { CommandHandler } from './command-handler.js';
import {
  getTelegramReadinessStatus,
  resolveTelegramBotToken,
} from '../../../gateway/channels/telegram-readiness.js';
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

  const token = resolveTelegramBotToken(process.env);
  const resolvedChatId = chatId ?? process.env.MEMPHIS_TELEGRAM_CHAT_ID;

  if (!token) {
    print({ ok: false, error: 'MEMPHIS_TELEGRAM_BOT_TOKEN not configured' }, json);
    return true;
  }
  if (!resolvedChatId) {
    print({ ok: false, error: 'No chat ID. Set MEMPHIS_TELEGRAM_CHAT_ID or use --to <chatId>' }, json);
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
  const status = await getTelegramReadinessStatus(process.env, {
    fetchImpl: fetch,
    includeRemoteBotLookup: true,
  });

  if (json) {
    print(status, true);
  } else {
    console.log(`Telegram: ${status.state}`);
    console.log(`  Gateway enabled: ${status.gatewayEnabled ? 'yes' : 'no'}`);
    console.log(`  Token: ${status.configured ? `present (${status.tokenSource ?? 'unknown'})` : 'missing'}`);
    console.log(`  Allowlist: ${status.allowlistEnabled ? `${status.allowlistCount} ids` : 'open'}`);
    if (status.botName) console.log(`  Bot: @${status.botName}`);
    if (status.chatId) console.log(`  Chat ID: ${status.chatId}`);
    if (!status.configured) {
      console.log(
        '  Set MEMPHIS_TELEGRAM_BOT_TOKEN and MEMPHIS_TELEGRAM_CHAT_ID in your .env',
      );
    } else if (!status.gatewayEnabled) {
      console.log('  Set MEMPHIS_CHANNEL_GATEWAY_ENABLED=true to enable inbound Telegram chat');
    }
  }
  return true;
}
