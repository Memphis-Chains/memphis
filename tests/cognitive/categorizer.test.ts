import { describe, expect, it } from 'vitest';
import { Categorizer, buildInferenceContext } from '../../src/cognitive/categorizer.js';
import type { Block } from '../../src/memory/chain.js';

describe('cognitive model A categorizer', () => {
  it('matches at least 10 pattern-derived tags', async () => {
    const categorizer = new Categorizer({
      enableContextInference: false,
      enableLLMFallback: false,
      confidenceThreshold: 0,
      maxSuggestions: 30,
    });

    const text = [
      'Meeting with @john about React and TypeScript API bug fix.',
      'Decision: use PostgreSQL with Docker.',
      'Question: how to improve tests?',
      'Great progress and idea for new feature.',
      'Work update this morning.',
    ].join(' ');

    const out = await categorizer.suggestCategories(text);
    expect(out.tags.length).toBeGreaterThanOrEqual(10);
  });

  it('keeps accuracy-oriented high-confidence core tags', async () => {
    const categorizer = new Categorizer({
      enableContextInference: false,
      enableLLMFallback: false,
      confidenceThreshold: 0.75,
      maxSuggestions: 5,
    });

    const out = await categorizer.suggestCategories('Decision: We decided to fix critical bug in API today');
    const tags = out.tags.map((t) => t.tag);

    expect(tags).toContain('decision');
    expect(tags).toContain('bug');
    expect(out.overallConfidence).toBeGreaterThanOrEqual(0.75);
  });

  it('suggests tags from context and frequent usage', async () => {
    const categorizer = new Categorizer({
      enableContextInference: true,
      enableLLMFallback: false,
      confidenceThreshold: 0.3,
      maxSuggestions: 10,
    });

    const recentBlocks: Block[] = [
      { data: { content: 'Progress on Atlas', tags: ['project:Atlas', 'tech:typescript', 'work'] } },
      { data: { content: 'Atlas deploy', tags: ['project:Atlas', 'work'] } },
    ];

    const context = buildInferenceContext(recentBlocks);
    const out = await categorizer.suggestCategories('Atlas API update', context);
    const tags = out.tags.map((t) => t.tag);

    expect(tags.some((t) => t.startsWith('project:'))).toBe(true);
    expect(tags).toContain('work');
  });

  it('categorizes under 10ms average', async () => {
    const categorizer = new Categorizer({
      enableContextInference: false,
      enableLLMFallback: false,
      confidenceThreshold: 0,
      maxSuggestions: 8,
    });

    const sample = 'Feature: implemented React TypeScript API with tests and docs';
    const iterations = 200;
    const start = performance.now();
    for (let i = 0; i < iterations; i += 1) {
      await categorizer.suggestCategories(sample);
    }
    const avg = (performance.now() - start) / iterations;

    expect(avg).toBeLessThan(10);
  });
});
