import { describe, expect, it } from 'vitest';
import { memoryInspector } from '../../src/infra/cli/commands/debug.js';

describe('debug memory', () => {
  it('returns memory snapshot, growth and leak risk', () => {
    const result = memoryInspector(2, 10);
    expect(result.snapshot.rss).toBeGreaterThan(0);
    expect(result.series.length).toBe(2);
    expect(['low', 'medium', 'high']).toContain(result.leakRisk);
    expect(result.topConsumers.length).toBeGreaterThan(0);
  });
});
