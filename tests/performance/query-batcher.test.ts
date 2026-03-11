import { describe, expect, it } from 'vitest';

import { QueryBatcher } from '../../src/infra/storage/query-batcher.js';

describe('QueryBatcher', () => {
  it('batches reads in parallel and writes sequentially', async () => {
    const batcher = new QueryBatcher({ maxBatchSize: 10 });
    const output: number[] = [];

    const reads = Array.from({ length: 10 }, (_, i) =>
      batcher.enqueueRead(async () => {
        output.push(i);
        return i;
      }),
    );

    const writes = Array.from({ length: 10 }, (_, i) =>
      batcher.enqueueWrite(async () => {
        output.push(i + 100);
        return i;
      }),
    );

    await batcher.flush();

    expect((await Promise.all(reads)).length).toBe(10);
    expect((await Promise.all(writes)).length).toBe(10);

    const stats = batcher.getStats();
    expect(stats.readBatches).toBe(1);
    expect(stats.writeBatches).toBe(1);
  });
});
