import { describe, expect, it } from 'vitest';
import { ConnectionDiscovery } from '../../src/cognitive/connection-discovery.js';
import type { Block } from '../../src/memory/chain.js';

const blocks: Block[] = [
  { timestamp: new Date().toISOString(), chain: 'journal', data: { type: 'journal', tags: ['ai', 'workflow'], content: 'ai workflow' } },
  { timestamp: new Date().toISOString(), chain: 'decision', data: { type: 'decision', tags: ['ai'], content: 'decision ai' } },
  { timestamp: new Date().toISOString(), chain: 'journal', data: { type: 'journal', tags: ['workflow', 'sync'], content: 'workflow sync' } },
];

describe('ConnectionDiscovery', () => {
  it('finds bridge topics', async () => {
    const d = new ConnectionDiscovery(blocks);
    const topics = await d.findBridgeTopics();
    expect(topics.some((t) => t.name === 'ai')).toBe(true);
  });

  it('identifies knowledge gaps from repeated non-decision topics', async () => {
    const d = new ConnectionDiscovery(blocks);
    const gaps = await d.identifyGaps();
    expect(gaps.some((g) => g.topic === 'workflow')).toBe(true);
  });
});
