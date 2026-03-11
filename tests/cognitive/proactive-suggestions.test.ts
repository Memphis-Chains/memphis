import { describe, expect, it } from 'vitest';
import { ProactiveSuggestionEngine } from '../../src/cognitive/proactive-suggestions.js';
import type { Block } from '../../src/memory/chain.js';

const blocks: Block[] = [
  { timestamp: new Date().toISOString(), chain: 'journal', data: { type: 'journal', content: 'working on sync pipeline', tags: ['sync', 'pipeline'] } },
  { timestamp: new Date().toISOString(), chain: 'journal', data: { type: 'journal', content: 'stuck on issue', tags: ['blocker'] } },
];

describe('ProactiveSuggestionEngine', () => {
  it('generates contextual suggestions', async () => {
    const engine = new ProactiveSuggestionEngine(blocks);
    const out = await engine.generateContextAware('sync pipeline pending next step');
    expect(out.length).toBeGreaterThan(0);
    expect(out.some((s) => s.type === 'decide')).toBe(true);
  });

  it('generates aggregate suggestions', async () => {
    const engine = new ProactiveSuggestionEngine(blocks);
    const out = await engine.generateSuggestions();
    expect(out.length).toBeGreaterThan(0);
  });
});
