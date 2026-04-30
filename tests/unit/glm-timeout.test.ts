import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AppError } from '../../src/core/errors.js';
import { GlmProvider } from '../../src/providers/glm/adapter.js';

describe('GlmProvider timeout + cascade-aware error mapping (S4-3)', () => {
  const realFetch = global.fetch;

  beforeEach(() => {
    delete process.env.GLM_TIMEOUT_MS;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    global.fetch = realFetch;
  });

  it('throws PROVIDER_TIMEOUT (504) when fetch aborts past the configured timeout', async () => {
    const provider = new GlmProvider({ apiKey: 'k', timeoutMs: 30 });
    global.fetch = vi.fn().mockImplementation(
      (_url, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          const signal = init?.signal as AbortSignal | undefined;
          signal?.addEventListener('abort', () => {
            const err = new Error('aborted');
            err.name = 'AbortError';
            reject(err);
          });
        }),
    ) as unknown as typeof fetch;

    await expect(provider.chat([{ role: 'user', content: 'hi' }])).rejects.toMatchObject({
      code: 'PROVIDER_TIMEOUT',
      statusCode: 504,
    });
  });

  it('maps HTTP 429 to PROVIDER_RATE_LIMIT so the circuit breaker counts the trip', async () => {
    const provider = new GlmProvider({ apiKey: 'k' });
    global.fetch = vi
      .fn()
      .mockResolvedValue(new Response('{"error":"rate"}', { status: 429 })) as unknown as typeof fetch;

    await expect(provider.chat([{ role: 'user', content: 'hi' }])).rejects.toMatchObject({
      code: 'PROVIDER_RATE_LIMIT',
      statusCode: 429,
    });
  });

  it('maps HTTP 5xx to PROVIDER_UNAVAILABLE so the cascade falls through', async () => {
    const provider = new GlmProvider({ apiKey: 'k' });
    global.fetch = vi
      .fn()
      .mockResolvedValue(new Response('{"error":"down"}', { status: 503 })) as unknown as typeof fetch;

    const err = await provider.chat([{ role: 'user', content: 'hi' }]).catch((e) => e);
    expect(err).toBeInstanceOf(AppError);
    expect(err.code).toBe('PROVIDER_UNAVAILABLE');
    expect(err.statusCode).toBe(503);
  });

  it('aborts when headers arrive but body stalls past timeout (Codex P1 round 1)', async () => {
    // fetch() resolves on response headers, not on full body consumption.
    // Without keeping the timeout active across `r.json()`, a slow body
    // would hang the call forever and bypass GLM_TIMEOUT_MS. This test
    // sends headers immediately, then leaves the body unresolved
    // until the AbortController fires — the call must reject as
    // PROVIDER_TIMEOUT, not hang.
    const provider = new GlmProvider({ apiKey: 'k', timeoutMs: 50 });
    global.fetch = vi.fn().mockImplementation((_url, init?: RequestInit) => {
      const signal = init?.signal as AbortSignal | undefined;
      const body = new ReadableStream({
        start(controller) {
          signal?.addEventListener('abort', () => {
            controller.error(Object.assign(new Error('aborted'), { name: 'AbortError' }));
          });
          // Never push any data — simulate stalled body.
        },
      });
      return Promise.resolve(
        new Response(body, { status: 200, headers: { 'Content-Type': 'application/json' } }),
      );
    }) as unknown as typeof fetch;

    const start = Date.now();
    await expect(provider.chat([{ role: 'user', content: 'hi' }])).rejects.toMatchObject({
      code: 'PROVIDER_TIMEOUT',
      statusCode: 504,
    });
    expect(Date.now() - start).toBeLessThan(2000);
  });

  it('honors GLM_TIMEOUT_MS env override', async () => {
    process.env.GLM_TIMEOUT_MS = '50';
    const provider = new GlmProvider({ apiKey: 'k' });
    global.fetch = vi.fn().mockImplementation(
      (_url, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          const signal = init?.signal as AbortSignal | undefined;
          signal?.addEventListener('abort', () => {
            const err = new Error('aborted');
            err.name = 'AbortError';
            reject(err);
          });
        }),
    ) as unknown as typeof fetch;

    const start = Date.now();
    await expect(provider.chat([{ role: 'user', content: 'hi' }])).rejects.toMatchObject({
      code: 'PROVIDER_TIMEOUT',
    });
    expect(Date.now() - start).toBeLessThan(2000);
  });

  it('clamps oversized timeout below Node setTimeout max (Codex P2 round 4)', async () => {
    // Node clamps delays above 2^31-1 ms to 1ms with a
    // TimeoutOverflowWarning. An operator setting GLM_TIMEOUT_MS=
    // 999999999999 would otherwise see *every* call immediately abort
    // as PROVIDER_TIMEOUT. Clamping at NODE_TIMEOUT_MAX_MS preserves
    // the configured value's intent (very long wait) without overflow.
    process.env.GLM_TIMEOUT_MS = String(Number.MAX_SAFE_INTEGER);
    const provider = new GlmProvider({ apiKey: 'k' });
    // Mock fetch to resolve immediately so the test doesn't actually wait.
    global.fetch = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), {
          status: 200,
        }),
      ) as unknown as typeof fetch;

    const start = Date.now();
    const result = await provider.chat([{ role: 'user', content: 'hi' }]);
    // Should NOT abort early — call resolves normally.
    expect(result.content).toBe('ok');
    expect(Date.now() - start).toBeLessThan(2000);
  });
});
