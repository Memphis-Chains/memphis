import { describe, expect, it, vi } from 'vitest';

import { runTelegramSmokeTest } from '../../src/infra/cli/commands/telegram-smoke.js';

function mkFetch(responses: Array<Record<string, unknown>>): typeof fetch {
  let call = 0;
  return (async () => {
    const body = responses[call++] ?? { ok: false, description: 'no more stubs' };
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
}

describe('telegram smoke test (Phase 3.1 production sprint)', () => {
  it('fails fast when MEMPHIS_TELEGRAM_BOT_TOKEN is unset', async () => {
    const result = await runTelegramSmokeTest({
      rawEnv: {} as NodeJS.ProcessEnv,
      fetchFn: vi.fn() as unknown as typeof fetch,
    });
    expect(result.ok).toBe(false);
    expect(result.steps[0]!.name).toBe('token-set');
    expect(result.steps[0]!.ok).toBe(false);
  });

  it('fails on getMe returning ok=false (invalid token)', async () => {
    const fetchFn = mkFetch([{ ok: false, description: 'Unauthorized', error_code: 401 }]);
    const result = await runTelegramSmokeTest({
      rawEnv: {
        MEMPHIS_TELEGRAM_BOT_TOKEN: 'bad-token',
        MEMPHIS_TELEGRAM_ALLOWED_USER_IDS: '12345',
      } as NodeJS.ProcessEnv,
      fetchFn,
    });
    expect(result.ok).toBe(false);
    const getMeStep = result.steps.find((s) => s.name === 'getMe');
    expect(getMeStep?.ok).toBe(false);
    expect(getMeStep?.detail).toMatch(/Unauthorized.*401/);
  });

  it('fails when allowlist empty and no --chat-id override', async () => {
    const fetchFn = mkFetch([
      { ok: true, result: { id: 42, username: 'testbot' } },
    ]);
    const result = await runTelegramSmokeTest({
      rawEnv: {
        MEMPHIS_TELEGRAM_BOT_TOKEN: 'valid-token',
      } as NodeJS.ProcessEnv,
      fetchFn,
    });
    expect(result.ok).toBe(false);
    const allowStep = result.steps.find((s) => s.name === 'allowlist');
    expect(allowStep?.ok).toBe(false);
    expect(result.botUsername).toBe('testbot');
  });

  it('dry-run returns ok without sending', async () => {
    const fetchFn = mkFetch([
      { ok: true, result: { id: 42, username: 'testbot' } },
    ]);
    const result = await runTelegramSmokeTest({
      rawEnv: {
        MEMPHIS_TELEGRAM_BOT_TOKEN: 'valid-token',
        MEMPHIS_TELEGRAM_ALLOWED_USER_IDS: '12345',
      } as NodeJS.ProcessEnv,
      fetchFn,
      dryRun: true,
    });
    expect(result.ok).toBe(true);
    expect(result.sentMessageId).toBeUndefined();
    const sendStep = result.steps.find((s) => s.name === 'send');
    expect(sendStep?.detail).toMatch(/skipped.*dry-run/);
  });

  it('full happy path: token → getMe → allowlist → send', async () => {
    const fetchFn = mkFetch([
      { ok: true, result: { id: 42, username: 'testbot' } },
      { ok: true, result: { message_id: 1001 } },
    ]);
    const result = await runTelegramSmokeTest({
      rawEnv: {
        MEMPHIS_TELEGRAM_BOT_TOKEN: 'valid-token',
        MEMPHIS_TELEGRAM_ALLOWED_USER_IDS: '12345,67890',
      } as NodeJS.ProcessEnv,
      fetchFn,
    });
    expect(result.ok).toBe(true);
    expect(result.botUsername).toBe('testbot');
    expect(result.chatId).toBe('12345'); // first in allowlist
    expect(result.sentMessageId).toBe(1001);
  });

  it('--chat-id override beats allowlist', async () => {
    const fetchFn = mkFetch([
      { ok: true, result: { id: 42, username: 'testbot' } },
      { ok: true, result: { message_id: 999 } },
    ]);
    const result = await runTelegramSmokeTest({
      rawEnv: {
        MEMPHIS_TELEGRAM_BOT_TOKEN: 'valid-token',
        MEMPHIS_TELEGRAM_ALLOWED_USER_IDS: '12345',
      } as NodeJS.ProcessEnv,
      fetchFn,
      chatId: '99999',
    });
    expect(result.ok).toBe(true);
    expect(result.chatId).toBe('99999');
  });

  it('send failure surfaces cleanly', async () => {
    const fetchFn = mkFetch([
      { ok: true, result: { id: 42, username: 'testbot' } },
      { ok: false, description: 'chat not found', error_code: 400 },
    ]);
    const result = await runTelegramSmokeTest({
      rawEnv: {
        MEMPHIS_TELEGRAM_BOT_TOKEN: 'valid-token',
        MEMPHIS_TELEGRAM_ALLOWED_USER_IDS: '12345',
      } as NodeJS.ProcessEnv,
      fetchFn,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/chat not found/);
  });

  it('network throw during getMe is surfaced', async () => {
    const fetchFn = (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    const result = await runTelegramSmokeTest({
      rawEnv: {
        MEMPHIS_TELEGRAM_BOT_TOKEN: 'valid-token',
        MEMPHIS_TELEGRAM_ALLOWED_USER_IDS: '12345',
      } as NodeJS.ProcessEnv,
      fetchFn,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/getMe failed/);
  });
});
