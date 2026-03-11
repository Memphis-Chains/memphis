import { describe, expect, it } from 'vitest';
import { InsightGenerator } from '../../src/cognitive/insight-generator.js';
import type { Block } from '../../src/memory/chain.js';

const now = Date.now();
const blocks: Block[] = [
  { timestamp: new Date(now - 1000).toISOString(), chain: 'journal', data: { type: 'journal', content: 'AI notes', tags: ['ai', 'project:x'] } },
  { timestamp: new Date(now - 2000).toISOString(), chain: 'decision', data: { type: 'decision', content: 'choose stack', tags: ['ai'] } },
  { timestamp: new Date(now - 3000).toISOString(), chain: 'journal', data: { type: 'journal', content: 'sync chain', tags: ['sync'] } },
];

describe('InsightGenerator', () => {
  it('generates daily insights', async () => {
    const g = new InsightGenerator(blocks);
    const out = await g.generateDailyInsights();
    expect(out.length).toBeGreaterThan(0);
  });

  it('generates topic insights', async () => {
    const g = new InsightGenerator(blocks);
    const out = await g.generateTopicInsights('ai');
    expect(out.length).toBeGreaterThan(0);
    expect(out[0].title.toLowerCase()).toContain('topic insight');
  });
});
