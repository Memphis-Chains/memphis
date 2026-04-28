/**
 * Sprint 1.2 — lazy-singleton helper unit tests.
 *
 * Verifies the Promise-based init guard pattern that callers (sprint 2.1
 * scheduler/loop/vault, future async lazy initializers) will adopt.
 */

import { describe, expect, it, vi } from 'vitest';

import { lazySingleton } from '../../src/infra/runtime/lazy-singleton.js';

describe('lazySingleton', () => {
  it('runs the factory exactly once across concurrent callers', async () => {
    const factory = vi.fn(async () => ({ id: Math.random() }));
    const get = lazySingleton(factory);

    const results = await Promise.all(Array.from({ length: 100 }, () => get()));
    expect(factory).toHaveBeenCalledTimes(1);
    const ids = new Set(results.map((r) => r.id));
    expect(ids.size).toBe(1);
  });

  it('caches the resolved value across sequential calls', async () => {
    let count = 0;
    const get = lazySingleton(async () => ({ count: ++count }));

    const a = await get();
    const b = await get();
    const c = await get();

    expect(count).toBe(1);
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  it('rejects the cached promise on factory failure but allows retry', async () => {
    let attempts = 0;
    const get = lazySingleton(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('first failure');
      return { ok: true };
    });

    await expect(get()).rejects.toThrow('first failure');

    // After failure the cache should be cleared so the next call retries.
    const result = await get();
    expect(result).toEqual({ ok: true });
    expect(attempts).toBe(2);
  });

  it('reset() clears the cache so the factory re-runs', async () => {
    const factory = vi.fn(async () => Math.random());
    const get = lazySingleton(factory);

    const a = await get();
    const b = await get();
    expect(a).toBe(b);
    expect(factory).toHaveBeenCalledTimes(1);

    get.reset();
    const c = await get();
    expect(c).not.toBe(a);
    expect(factory).toHaveBeenCalledTimes(2);
  });

  it('isInitialized() reflects cache state correctly', async () => {
    const get = lazySingleton(async () => 42);
    expect(get.isInitialized()).toBe(false);

    const promise = get();
    expect(get.isInitialized()).toBe(true);
    await promise;
    expect(get.isInitialized()).toBe(true);

    get.reset();
    expect(get.isInitialized()).toBe(false);
  });

  it('concurrent calls during a slow factory share the same Promise', async () => {
    let resolveFactory!: (value: { ready: true }) => void;
    const factoryPromise = new Promise<{ ready: true }>((resolve) => {
      resolveFactory = resolve;
    });
    const factory = vi.fn(() => factoryPromise);
    const get = lazySingleton(factory);

    const callA = get();
    const callB = get();
    expect(factory).toHaveBeenCalledTimes(1);

    resolveFactory({ ready: true });
    const [a, b] = await Promise.all([callA, callB]);
    expect(a).toBe(b);
  });
});
