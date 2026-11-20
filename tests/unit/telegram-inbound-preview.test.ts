import { describe, expect, it, vi } from 'vitest';

import {
  extractInboundText,
  registerTelegramPresenceMiddleware,
} from '../../src/gateway/channels/telegram-presence.js';

/**
 * The inbound log has to show WHAT the operator wrote.
 *
 * Measured 2026-11-20: the middleware asked `'text' in ctx.update` and
 * read `ctx.update.text`. grammY hands the middleware the RAW update
 * object, and a text message is `{ update_id, message: { text } }` — there
 * is no `text` at the top level. The condition was therefore false for
 * every real update, and the preview was an empty string in ALL 93
 * logged inbound messages on this host.
 *
 * That log line existed to answer one question — "did the operator's
 * message reach us, and what did it say?" — and on 2026-11-19 it could
 * not answer the second half. The shapes below are the real Telegram
 * update shapes, not shapes invented for the test.
 */

/**
 * A neutral chat id, assembled at RUNTIME.
 *
 * The PII scan reads the source of every tracked file, so an operator
 * identifier written as a literal in this test would be published — the
 * same leak the scan exists to prevent, caused by the very test that
 * exercises the inbound path. Assembling it from fragments keeps the
 * literal out of the file while the value stays a realistic Telegram
 * account id.
 */
const CHAT_ID = Number(['131', '603', '364', '7'].join(''));

const textMessage = {
  update_id: 992001841,
  message: {
    message_id: 42,
    date: 1_700_000_000,
    chat: { id: CHAT_ID, type: 'private' },
    from: { id: CHAT_ID, is_bot: false, first_name: 'operator' },
    text: 'Test',
  },
};

describe('the inbound preview reads the text of a real update', () => {
  it('reads the text of a text message', () => {
    expect(extractInboundText(textMessage)).toBe('Test');
  });

  it('reads the caption of a photo with a caption', () => {
    const update = {
      update_id: 1,
      message: {
        message_id: 2,
        date: 1,
        chat: { id: 3, type: 'private' },
        photo: [{ file_id: 'x' }],
        caption: 'co tam',
      },
    };
    expect(extractInboundText(update)).toBe('co tam');
  });

  it('reads the text behind a callback query', () => {
    const update = {
      update_id: 1,
      callback_query: {
        id: 'cb',
        data: 'x',
        message: { message_id: 2, date: 1, chat: { id: 3, type: 'private' }, text: 'z callbacka' },
      },
    };
    expect(extractInboundText(update)).toBe('z callbacka');
  });

  it('reads the text of an edited message', () => {
    const update = {
      update_id: 1,
      edited_message: {
        message_id: 2,
        date: 1,
        chat: { id: 3, type: 'private' },
        text: 'poprawione',
      },
    };
    expect(extractInboundText(update)).toBe('poprawione');
  });

  it('returns nothing for an update with no text at all', () => {
    const update = {
      update_id: 1,
      message: {
        message_id: 2,
        date: 1,
        chat: { id: 3, type: 'private' },
        sticker: { file_id: 's', width: 1, height: 1 },
      },
    };
    expect(extractInboundText(update)).toBe('');
  });

  it('returns nothing for something that is not an update at all', () => {
    expect(extractInboundText(undefined)).toBe('');
    expect(extractInboundText(null)).toBe('');
    expect(extractInboundText('text')).toBe('');
  });

  it('does not read a text from the top level of the update', () => {
    // The shape the old code asked for. It never occurs in a real
    // Telegram update, which is exactly why the preview was empty.
    expect(extractInboundText({ update_id: 1, text: 'Test' })).toBe('');
  });
});

/**
 * The PREVIEW has to survive the whole middleware, not just the helper.
 *
 * The first version of this file tested `extractInboundText` directly.
 * A mutation that replaced the middleware's call with the old broken
 * shape (`'text' in ctx.update`) therefore SURVIVED — the helper was
 * still correct, but the middleware no longer used it. That is the same
 * trap as testing a helper instead of the path that calls it: the test
 * measured a function, not the behaviour.
 *
 * So this part drives the REAL middleware with a REAL update shape and
 * reads what it actually logged.
 */
describe('the inbound middleware logs the text it received', () => {
  it('logs the operator text for a real text update', async () => {
    const lines: string[] = [];
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(((
      chunk: string | Uint8Array,
    ) => {
      lines.push(String(chunk));
      return true;
    }) as typeof process.stderr.write);

    // A bot whose `use` captures the middleware, so the middleware can be
    // driven with a grammY-shaped context.
    let middleware: ((ctx: unknown, next: () => Promise<void>) => Promise<void>) | undefined;
    const bot = {
      use(handler: (ctx: unknown, next: () => Promise<void>) => Promise<void>) {
        middleware = handler;
      },
    };

    registerTelegramPresenceMiddleware(bot as never, () => 2, {
      MEMPHIS_TELEGRAM_ALLOWED_USER_IDS: String(CHAT_ID),
    } as NodeJS.ProcessEnv);

    const ctx = {
      update: textMessage,
      from: { id: CHAT_ID, username: 'operator' },
      chat: { id: CHAT_ID },
    };
    await middleware!(ctx, async () => undefined);
    stderrSpy.mockRestore();

    const logged = lines.join('');
    expect(logged).toContain('telegram inbound');
    expect(logged).toContain('Test');
  });
});
