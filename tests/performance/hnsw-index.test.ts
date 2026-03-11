import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { HnswIndex } from '../../src/infra/embeddings/hnsw-index.js';

describe('HnswIndex', () => {
  it('adds vectors and returns nearest match', () => {
    const index = new HnswIndex({ dimensions: 3 });
    index.add('v1', [1, 0, 0]);
    index.add('v2', [0, 1, 0]);
    index.add('v3', [0.8, 0.2, 0]);

    const result = index.search([0.9, 0.1, 0], 1);
    expect(result[0]?.id).toBe('v1');
  });

  it('persists and reloads index from disk', async () => {
    const root = mkdtempSync(join(tmpdir(), 'memphis-hnsw-'));
    const file = join(root, 'index.json');

    const index = new HnswIndex({ dimensions: 2 });
    index.add('x', [1, 0]);
    index.add('y', [0, 1]);
    await index.save(file);

    const reloaded = new HnswIndex({ dimensions: 2 });
    await reloaded.load(file);
    expect(reloaded.size()).toBe(2);
    expect(reloaded.search([1, 0], 1)[0]?.id).toBe('x');
  });
});
