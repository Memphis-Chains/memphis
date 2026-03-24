import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SearchCache, SearchResult } from '../../../src/resilience/cache.js';

describe('SearchCache', () => {
  let cache: SearchCache;

  const mockResult = (id: string): SearchResult => ({
    id,
    content: `content-${id}`,
    score: 0.9,
    timestamp: new Date().toISOString(),
  });

  beforeEach(() => {
    cache = new SearchCache();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns null for missing key', () => {
    expect(cache.get('nonexistent')).toBeNull();
  });

  it('stores and retrieves a result', () => {
    const result = mockResult('1');
    cache.set('query1', result);
    expect(cache.get('query1')).toEqual(result);
  });

  it('evicts expired entries', () => {
    const result = mockResult('1');
    cache.set('query1', result);

    // Advance time past TTL (5 minutes)
    vi.advanceTimersByTime(5 * 60 * 1000 + 1);

    expect(cache.get('query1')).toBeNull();
  });

  it('evicts half the cache when max size is reached', () => {
    for (let i = 0; i < 500; i++) {
      cache.set(`query${i}`, mockResult(String(i)));
    }
    expect(cache.size).toBe(500);

    // Add one more - evicts 250 oldest, then adds 1 new = 251
    cache.set('newQuery', mockResult('new'));
    expect(cache.size).toBe(251);
    expect(cache.get('newQuery')).not.toBeNull();
  });

  it('LRU: recently accessed entry is not evicted when cache is full', () => {
    for (let i = 0; i < 500; i++) {
      cache.set(`query${i}`, mockResult(String(i)));
    }

    // Access query0 to make it recently used
    const result0 = cache.get('query0');
    expect(result0).not.toBeNull();

    // Add one more - should evict 250 oldest
    cache.set('newQuery', mockResult('new'));

    // query0 should still be there (was touched)
    expect(cache.get('query0')).not.toBeNull();
    // query1 should be evicted (wasn't touched, among oldest)
    expect(cache.get('query1')).toBeNull();
  });

  it('clear removes all entries', () => {
    cache.set('q1', mockResult('1'));
    cache.set('q2', mockResult('2'));
    expect(cache.size).toBe(2);

    cache.clear();
    expect(cache.size).toBe(0);
  });
});
