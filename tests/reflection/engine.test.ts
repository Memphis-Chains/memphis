import { describe, expect, it } from 'vitest';

import { ReflectionEngine } from '../../src/reflection/engine.js';

describe('ReflectionEngine', () => {
  it('creates daily reflections for all 6 reflection types', async () => {
    const engine = new ReflectionEngine();
    const context = new Map<string, unknown>([
      ['score', 0.72],
      ['goal', 0.7],
      ['successes', 8],
      ['failures', 2],
    ]);

    const result = await engine.reflectDaily('scheduled', context);

    expect(result).toHaveLength(6);
    expect(new Set(result.map((item) => item.type))).toEqual(
      new Set(['performance', 'pattern', 'failure', 'success', 'alignment', 'evolution']),
    );
  });

  it('keeps confidence score inside 0..1 for every reflection', async () => {
    const engine = new ReflectionEngine();

    const result = await engine.reflectDaily('manual', new Map());

    for (const reflection of result) {
      expect(reflection.confidence).toBeGreaterThanOrEqual(0);
      expect(reflection.confidence).toBeLessThanOrEqual(1);
    }
  });

  it('completes daily reflection in under 1 second', async () => {
    const engine = new ReflectionEngine();

    const started = performance.now();
    await engine.reflectDaily('manual', new Map([['score', 0.8]]));
    const elapsed = performance.now() - started;

    expect(elapsed).toBeLessThan(1000);
  });
});
