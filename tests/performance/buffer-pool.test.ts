import { describe, expect, it } from 'vitest';

import { BufferPool } from '../../src/infra/memory/buffer-pool.js';

describe('BufferPool', () => {
  it('reuses buffers and tracks usage stats', () => {
    const pool = new BufferPool({ maxBytes: 1024 * 1024 });

    const a = pool.acquire(200);
    pool.release(a);

    const b = pool.acquire(200);
    expect(b.byteLength).toBe(a.byteLength);

    const stats = pool.getStats();
    expect(stats.reuseCount).toBeGreaterThan(0);
    expect(stats.allocCount).toBeGreaterThan(0);
  });
});
