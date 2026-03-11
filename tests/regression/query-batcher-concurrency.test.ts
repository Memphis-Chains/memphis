import { describe, expect, it } from 'vitest';

import { QueryBatcher } from '../../src/infra/storage/query-batcher.js';

describe('QueryBatcher flush concurrency regression', () => {
  it('serializes concurrent flush() calls', async () => {
    const batcher = new QueryBatcher({ maxBatchSize: 1 });

    let activeWrites = 0;
    let maxConcurrentWrites = 0;

    for (let i = 0; i < 20; i += 1) {
      batcher.enqueueWrite(async () => {
        activeWrites += 1;
        maxConcurrentWrites = Math.max(maxConcurrentWrites, activeWrites);
        await new Promise((resolve) => setTimeout(resolve, 5));
        activeWrites -= 1;
      });
    }

    await Promise.all([batcher.flush(), batcher.flush(), batcher.flush()]);

    expect(maxConcurrentWrites).toBe(1);
    expect(batcher.getStats().writeBatches).toBe(20);
  });
});
