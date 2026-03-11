import { describe, expect, it } from 'vitest';

import { ChainCache } from '../../src/infra/cache/chain-cache.js';
import { BufferPool } from '../../src/infra/memory/buffer-pool.js';

describe('memory usage controls', () => {
  it('keeps cache/pool growth bounded and exposes memory monitoring stats', () => {
    const baselineRss = process.memoryUsage().rss;

    const cache = new ChainCache({ maxBlocks: 128 });
    const pool = new BufferPool({ maxBytes: 1024 * 1024, maxBuffersPerBucket: 16 });

    for (let i = 0; i < 5000; i += 1) {
      cache.set('main', i, { i, payload: 'x'.repeat(256) });
      const buf = pool.acquire(4096);
      buf.writeUInt32LE(i, 0);
      pool.release(buf);
    }

    pool.trim(256 * 1024);

    const cacheStats = cache.getStats();
    const poolStats = pool.getStats();
    const rssDeltaMb = (poolStats.rssBytes - baselineRss) / 1024 / 1024;

    expect(cacheStats.size).toBeLessThanOrEqual(128);
    expect(cacheStats.estimatedBytes).toBeGreaterThan(0);
    expect(poolStats.pooledBytes).toBeLessThanOrEqual(poolStats.maxBytes);
    expect(poolStats.heapUsedBytes).toBeGreaterThan(0);
    // Keep test stable across CI by asserting bounded growth, not absolute process RSS.
    expect(rssDeltaMb).toBeLessThan(80);
  });
});
