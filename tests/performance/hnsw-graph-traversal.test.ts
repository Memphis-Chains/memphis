import { describe, expect, it } from 'vitest';

import { HnswIndex } from '../../src/infra/embeddings/hnsw-index.js';

describe('HnswIndex graph traversal', () => {
  it('limits visited nodes via efSearch candidate expansion (no full scan)', () => {
    const index = new HnswIndex({ dimensions: 16, maxNeighbors: 8, efSearch: 24 });

    for (let i = 0; i < 2000; i += 1) {
      const vec = Array.from({ length: 16 }, (_, d) => Math.sin(i * 0.01 + d));
      index.add(`doc-${i}`, vec);
    }

    const query = Array.from({ length: 16 }, (_, d) => Math.cos(42 * 0.01 + d));
    const { results, diagnostics } = index.searchWithDiagnostics(query, 10);

    expect(results).toHaveLength(10);
    expect(diagnostics.totalNodes).toBe(2000);
    expect(diagnostics.visited).toBeLessThan(2000);
    // Traversal should stay below a full scan budget.
    expect(diagnostics.visited).toBeLessThan(1000);
  });
});
