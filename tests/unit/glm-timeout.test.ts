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
});
