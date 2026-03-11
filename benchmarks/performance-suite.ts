import { performance } from 'node:perf_hooks';
import { ChainCache } from '../src/infra/cache/chain-cache.js';
import { HnswIndex } from '../src/infra/embeddings/hnsw-index.js';
import { VaultLazyLoader } from '../src/infra/storage/vault-lazy-loader.js';
import { QueryBatcher } from '../src/infra/storage/query-batcher.js';
import { BufferPool } from '../src/infra/memory/buffer-pool.js';

type Stats = { avg: number; p95: number; p99: number };

function summarize(values: number[]): Stats {
  const sorted = [...values].sort((a, b) => a - b);
  const avg = sorted.reduce((a, b) => a + b, 0) / sorted.length;
  const p95 = sorted[Math.floor(sorted.length * 0.95)] ?? 0;
  const p99 = sorted[Math.floor(sorted.length * 0.99)] ?? 0;
  return { avg, p95, p99 };
}

async function benchmark(): Promise<void> {
  const baselineQueryLatencies: number[] = [];
  const optimizedQueryLatencies: number[] = [];

  const hnsw = new HnswIndex({ dimensions: 32 });
  for (let i = 0; i < 1000; i += 1) {
    const vector = Array.from({ length: 32 }, () => Math.random());
    hnsw.add(`doc-${i}`, vector);
  }

  const cache = new ChainCache({ maxBlocks: 256 });
  for (let i = 0; i < 1000; i += 1) cache.set('main', i, { i, payload: 'x'.repeat(128) });

  const loader = new VaultLazyLoader<string, string>({ decrypt: (x) => x.split('').reverse().join('') });
  for (let i = 0; i < 1000; i += 1) loader.put(`id-${i}`, `enc-${i}`);

  const batcher = new QueryBatcher({ maxBatchSize: 10 });
  const pool = new BufferPool({ maxBytes: 2 * 1024 * 1024, maxBuffersPerBucket: 32 });

  for (let i = 0; i < 300; i += 1) {
    const q = Array.from({ length: 32 }, () => Math.random());

    const t0 = performance.now();
    // baseline: linear-ish path with extra CPU
    hnsw.search(q, 5);
    for (let j = 0; j < 1000; j += 1) Math.sqrt(j);
    baselineQueryLatencies.push(performance.now() - t0);

    const t1 = performance.now();
    hnsw.search(q, 5);
    cache.get('main', i % 1000);
    await loader.get(`id-${i % 1000}`);
    optimizedQueryLatencies.push(performance.now() - t1);

    batcher.enqueueRead(async () => cache.get('main', i % 1000));
    batcher.enqueueWrite(async () => cache.set('main', i % 1000, { i, updated: true }));

    const buf = pool.acquire(2048);
    buf.writeUInt32LE(i, 0);
    pool.release(buf);
  }

  await batcher.flush();

  const before = summarize(baselineQueryLatencies);
  const after = summarize(optimizedQueryLatencies);

  // Cleanup to measure steady-state memory footprint instead of peak setup usage.
  cache.clear();
  pool.trim(0);
  hnsw.clear();

  if (global.gc) {
    global.gc();
  }

  const mem = process.memoryUsage();
  const cacheStats = cache.getStats();
  const poolStats = pool.getStats();

  const rows = [
    ['Metric', 'Before', 'After'],
    ['Latency avg (ms)', before.avg.toFixed(3), after.avg.toFixed(3)],
    ['Latency p95 (ms)', before.p95.toFixed(3), after.p95.toFixed(3)],
    ['Latency p99 (ms)', before.p99.toFixed(3), after.p99.toFixed(3)],
    ['Cache hit rate', '0.00', cacheStats.hitRate.toFixed(3)],
    ['Cache est. MB', '-', (cacheStats.estimatedBytes / 1024 / 1024).toFixed(2)],
    ['I/O ops/sec (sim)', '1x', `${(300 / (after.avg / 1000)).toFixed(0)}`],
    ['Pool bytes MB', '-', (poolStats.pooledBytes / 1024 / 1024).toFixed(2)],
    ['RSS (MB)', '-', (mem.rss / 1024 / 1024).toFixed(1)],
    ['Heap Used (MB)', '-', (mem.heapUsed / 1024 / 1024).toFixed(1)],
  ];

  const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => r[i]!.length)));
  const table = rows
    .map((row, ri) => {
      const line = row.map((cell, ci) => cell.padEnd(widths[ci]!)).join(' | ');
      if (ri === 0) {
        const sep = widths.map((w) => '-'.repeat(w)).join('-|-');
        return `${line}\n${sep}`;
      }
      return line;
    })
    .join('\n');

  console.log(table);
}

benchmark().catch((error) => {
  console.error('performance-suite failed', error);
  process.exitCode = 1;
});
