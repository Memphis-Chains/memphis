import type { Block } from '../memory/chain.js';
import type { Connection, KnowledgeGap, Topic } from './model-e-types.js';
import { KnowledgeSynthesizer } from './knowledge-synthesizer.js';

export class ConnectionDiscovery {
  private readonly synthesizer: KnowledgeSynthesizer;

  constructor(private readonly blocks: Block[]) {
    this.synthesizer = new KnowledgeSynthesizer(blocks);
  }

  async scanForConnections(): Promise<Connection[]> {
    const tags = this.uniqueTags();
    const out: Connection[] = [];

    for (let i = 0; i < tags.length; i += 1) {
      for (let j = i + 1; j < tags.length; j += 1) {
        const found = await this.synthesizer.findConnections(tags[i], tags[j]);
        out.push(...found);
      }
    }

    return out.sort((a, b) => (b.novelty + b.strength) - (a.novelty + a.strength)).slice(0, 8);
  }

  async findBridgeTopics(): Promise<Topic[]> {
    const map = new Map<string, { chains: Set<string>; count: number }>();

    for (const block of this.blocks) {
      for (const tag of block.data?.tags ?? []) {
        const item = map.get(tag) ?? { chains: new Set<string>(), count: 0 };
        item.chains.add(block.chain ?? 'journal');
        item.count += 1;
        map.set(tag, item);
      }
    }

    return [...map.entries()]
      .map(([name, value]) => ({
        name,
        weight: value.count,
        bridgeScore: value.count * Math.max(1, value.chains.size),
      }))
      .filter((t) => t.bridgeScore >= 2)
      .sort((a, b) => b.bridgeScore - a.bridgeScore)
      .slice(0, 10);
  }

  async identifyGaps(): Promise<KnowledgeGap[]> {
    const bridges = await this.findBridgeTopics();
    const gaps: KnowledgeGap[] = [];

    for (const topic of bridges) {
      const related = this.blocks.filter((b) => (b.data?.tags ?? []).includes(topic.name));
      const hasDecision = related.some((b) => b.data?.type === 'decision');
      if (!hasDecision) {
        gaps.push({
          topic: topic.name,
          reason: 'Topic appears repeatedly but has no explicit decision trail.',
          severity: topic.bridgeScore > 4 ? 'high' : 'medium',
          suggestedAction: `Record decision for ${topic.name}`,
        });
      }
    }

    return gaps.slice(0, 8);
  }

  private uniqueTags(): string[] {
    const tags = new Set<string>();
    for (const block of this.blocks) {
      for (const tag of block.data?.tags ?? []) tags.add(tag);
    }
    return [...tags].slice(0, 12);
  }
}
