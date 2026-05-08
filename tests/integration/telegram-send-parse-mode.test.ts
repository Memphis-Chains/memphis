import { describe, expect, it, vi } from 'vitest';

import { escapeMarkdownV2 } from '../../src/gateway/channels/telegram-escape.js';
import {
  sendTelegramMessage,
  type TelegramSendResult,
} from '../../src/gateway/channels/telegram-send.js';

function mockFetch(status = 200, responseBody = { result: { message_id: 1 } }) {
  return vi.fn(async () =>
    Promise.resolve(
      new Response(JSON.stringify(responseBody), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
    ),
  ) as unknown as typeof fetch;
}

const env = {
  MEMPHIS_TELEGRAM_BOT_TOKEN: 'test-token',
  MEMPHIS_TELEGRAM_CHAT_ID: '12345',
} as unknown as NodeJS.ProcessEnv;

describe('sendTelegramMessage parse mode', () => {
  it('defaults to plain mode (no parse_mode in request body)', async () => {
    const fetchImpl = mockFetch();
    const result: TelegramSendResult = await sendTelegramMessage({
      message: 'hello [world] *test*',
      rawEnv: env,
      fetchImpl,
    });
    expect(result.ok).toBe(true);

    const call = (fetchImpl as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]!;
    const init = call[1] as RequestInit;
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.text).toBe('hello [world] *test*');
    expect(body.parse_mode).toBeUndefined();
  });

  it('opts into MarkdownV2 when explicitly requested', async () => {
    const fetchImpl = mockFetch();
    const escaped = escapeMarkdownV2('Hello world. 50%');
    const result = await sendTelegramMessage({
      message: `*${escaped}*`, // bold + escaped data
      rawEnv: env,
      fetchImpl,
      parseMode: 'MarkdownV2',
    });
    expect(result.ok).toBe(true);

    const call = (fetchImpl as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]!;
    const init = call[1] as RequestInit;
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.parse_mode).toBe('MarkdownV2');
    expect(body.text).toBe('*Hello world\\. 50%*');
  });

  it('Zawoja-class payload (reserved chars in body) does not trigger Telegram entity error in plain mode', async () => {
    // Plain mode = Telegram treats the whole text as literal, no entity parse.
    // Confirms the safe-by-default contract.
    const offending =
      'Daily report:\n\n* Memphis: 100% ok\n* Backups: [restore-drill] _failed_ — 2 archives\n* Vault: 6 entries (integrity ok).';
    const fetchImpl = mockFetch();
    const result = await sendTelegramMessage({
      message: offending,
      rawEnv: env,
      fetchImpl,
    });
    expect(result.ok).toBe(true);

    const call = (fetchImpl as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]!;
    const init = call[1] as RequestInit;
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.text).toBe(offending);
    expect(body.parse_mode).toBeUndefined();
  });

  it('returns ok:false when bot token is missing', async () => {
    const result = await sendTelegramMessage({
      message: 'x',
      rawEnv: {} as NodeJS.ProcessEnv,
      fetchImpl: mockFetch(),
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/MEMPHIS_TELEGRAM_BOT_TOKEN/);
  });
});
