import { describe, expect, it } from 'vitest';

import { ChainCache } from '../../src/infra/cache/chain-cache.js';

describe('ChainCache', () => {
  it('evicts least recently used block and tracks metrics', () => {
    const cache = new ChainCache({ maxBlocks: 2 });

    cache.set('main', 1, { id: 'a' });
    cache.set('main', 2, { id: 'b' });
    cache.get('main', 1);
    cache.set('main', 3, { id: 'c' });

    expect(cache.get('main', 2)).toBeUndefined();
    expect(cache.get('main', 1)).toEqual({ id: 'a' });

    const stats = cache.getStats();
    expect(stats.hits).toBeGreaterThan(0);
    expect(stats.misses).toBeGreaterThan(0);
    expect(stats.size).toBe(2);
  });

  it('invalidates an entire chain', () => {
    const cache = new ChainCache({ maxBlocks: 10 });
    cache.set('a', 1, { ok: true });
    cache.set('a', 2, { ok: true });
    cache.set('b', 1, { ok: true });

    const removed = cache.invalidateChain('a');
    expect(removed).toBe(2);
    expect(cache.get('a', 1)).toBeUndefined();
    expect(cache.get('b', 1)).toEqual({ ok: true });
  });
});
