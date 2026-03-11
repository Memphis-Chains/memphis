import { describe, expect, it } from 'vitest';

import { KnowledgeSynthesizer } from '../../src/cognitive/knowledge-synthesizer.js';
import type { Block } from '../../src/memory/chain.js';

const blocks: Block[] = [
  {
    timestamp: new Date().toISOString(),
    chain: 'journal',
    data: { content: 'AI agent reasoning and blockchain settlement', tags: ['ai', 'blockchain'] },
  },
  {
    timestamp: new Date().toISOString(),
    chain: 'decision',
    data: { type: 'decision', content: 'Adopt vector embeddings', tags: ['ai', 'embeddings'] },
  },
];

describe('KnowledgeSynthesizer', () => {
  it('finds connections between two topics', async () => {
    const s = new KnowledgeSynthesizer(blocks, {
      embedSearchFn: () => ({ hits: [{ id: 'x', score: 0.72 }] }),
    });
    const out = await s.findConnections('AI', 'blockchain');
    expect(out.length).toBeGreaterThan(0);
    expect(out[0].topics).toEqual(['AI', 'blockchain']);
    expect(out[0].strength).toBeGreaterThan(0.5);
  });

  it('synthesizes insights from selected chains', async () => {
    const s = new KnowledgeSynthesizer(blocks);
    const out = await s.synthesizeInsights(['journal', 'decision']);
    expect(out.length).toBeGreaterThan(0);
    expect(out[0].actionable).toBe(true);
  });
});
