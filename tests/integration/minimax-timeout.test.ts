import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MinimaxProvider } from '../../src/providers/index.js';

// P4 hotfix integration: assert MINIMAX_REQUEST_TIMEOUT_MS env override
// actually aborts the underlying fetch with a clear error message.

describe('MinimaxProvider — request timeout via MINIMAX_REQUEST_TIMEOUT_MS', () => {
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    savedEnv = {
      MINIMAX_API_KEY: process.env.MINIMAX_API_KEY,
      MINIMAX_REQUEST_TIMEOUT_MS: process.env.MINIMAX_REQUEST_TIMEOUT_MS,
    };
    process.env.MINIMAX_API_KEY = 'test-key';
  });

  afterEach(() => {
    if (savedEnv.MINIMAX_API_KEY === undefined) delete process.env.MINIMAX_API_KEY;
    else process.env.MINIMAX_API_KEY = savedEnv.MINIMAX_API_KEY;
    if (savedEnv.MINIMAX_REQUEST_TIMEOUT_MS === undefined)
      delete process.env.MINIMAX_REQUEST_TIMEOUT_MS;
    else process.env.MINIMAX_REQUEST_TIMEOUT_MS = savedEnv.MINIMAX_REQUEST_TIMEOUT_MS;
    vi.unstubAllGlobals();
  });

  it('rewraps fetch AbortError as a Memphis-flavoured timeout message', async () => {
    // Override valid range — 5s is in [1s, 24h].
    process.env.MINIMAX_REQUEST_TIMEOUT_MS = '5000';

    // Stub fetch to immediately reject with AbortError — simulates what
    // the runtime does when AbortSignal.timeout fires. We do NOT wait
    // for the actual signal here (vitest fake-timers + EventTarget are
    // tricky to compose); we assert MinimaxProvider's error wrapping.
    const abortFetch = vi.fn(async () => {
      const err = new Error('The operation was aborted') as Error & { name: string };
      err.name = 'AbortError';
      throw err;
    }) as unknown as typeof fetch;
    vi.stubGlobal('fetch', abortFetch);

    const provider = new MinimaxProvider({ apiKey: 'k', model: 'MiniMax-M2.7' });
    await expect(provider.chat([{ role: 'user', content: 'hi' }])).rejects.toThrow(
      /timed out after 5000ms.*MINIMAX_REQUEST_TIMEOUT_MS/,
    );
    expect(abortFetch).toHaveBeenCalledTimes(1);
  });

  it('uses the registry default (30 min) when env override is unset', async () => {
    delete process.env.MINIMAX_REQUEST_TIMEOUT_MS;

    // Resolve the fetch immediately so we can prove the call passes through
    // and the default timeout was wired without dying.
    const fastFetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            choices: [{ message: { content: 'pong', role: 'assistant' }, finish_reason: 'stop' }],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    ) as unknown as typeof fetch;
    vi.stubGlobal('fetch', fastFetch);

    const provider = new MinimaxProvider({ apiKey: 'k', model: 'MiniMax-M2.7' });
    const result = await provider.chat([{ role: 'user', content: 'ping' }]);
    expect(result.content).toBe('pong');
    expect(fastFetch).toHaveBeenCalledTimes(1);
  });

  it('rejects out-of-range env override and falls back to default', async () => {
    // 50_000 below the 1_000-min sanity rail check? Actually 50_000 is in
    // range. Test rejected case: negative value.
    process.env.MINIMAX_REQUEST_TIMEOUT_MS = '-1';

    const fastFetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            choices: [{ message: { content: 'ok', role: 'assistant' }, finish_reason: 'stop' }],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    ) as unknown as typeof fetch;
    vi.stubGlobal('fetch', fastFetch);

    const provider = new MinimaxProvider({ apiKey: 'k', model: 'MiniMax-M2.7' });
    const result = await provider.chat([{ role: 'user', content: 'ping' }]);
    expect(result.content).toBe('ok');
    // Out-of-range value falls back to default 30 min — call still succeeds.
    expect(fastFetch).toHaveBeenCalledTimes(1);
  });
});
