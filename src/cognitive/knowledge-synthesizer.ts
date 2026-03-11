import type { Block } from '../memory/chain.js';
import { embedSearch } from '../infra/storage/rust-embed-adapter.js';
import type { Connection, Insight, Recommendation } from './model-e-types.js';

interface SynthDeps {
  embedSearchFn?: (query: string, topK?: number) => { hits: Array<{ score: number; id: string }> };
}

export class KnowledgeSynthesizer {
  constructor(private readonly blocks: Block[], private readonly deps: SynthDeps = {}) {}

  /**
   * Finds plausible connections between two topics using local evidence and embedding similarity.
   */
  async findConnections(topicA: string, topicB: string): Promise<Connection[]> {
    const related = this.blocks.filter((b) => {
      const text = `${b.data?.content ?? ''} ${(b.data?.tags ?? []).join(' ')}`.toLowerCase();
      return text.includes(topicA.toLowerCase()) || text.includes(topicB.toLowerCase());
    });

    const strengths = await this.embeddingStrength(topicA, topicB);
    const connection: Connection = {
      topics: [topicA, topicB],
      strength: strengths,
      novelty: Math.max(0, Math.min(1, 1 - strengths + 0.15)),
      evidence: related.slice(0, 5),
      description: `Potential bridge between ${topicA} and ${topicB}`,
    };

    return connection.strength > 0.2 ? [connection] : [];
  }

  /**
   * Synthesizes cross-chain insights from the supplied chain names.
   */
  async synthesizeInsights(chains: string[]): Promise<Insight[]> {
    const selected = this.blocks.filter((b) => chains.includes(b.chain ?? 'journal'));
    const tagCounts = new Map<string, number>();

    for (const block of selected) {
      for (const tag of block.data?.tags ?? []) {
        tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
      }
    }

    const top = [...tagCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
    return top.map(([tag, count]) => ({
      type: 'pattern',
      title: `Cross-chain pattern: ${tag}`,
      description: `Tag ${tag} appears ${count} times across selected chains`,
      confidence: Math.min(0.95, 0.5 + count / Math.max(1, selected.length + 2)),
      evidence: selected.filter((b) => (b.data?.tags ?? []).includes(tag)).slice(0, 4),
      actionable: true,
      actions: [`Review chain notes related to ${tag}`, `Decide next step for ${tag}`],
    }));
  }

  /**
   * Generates recommendation candidates for the provided context string.
   */
  async generateRecommendations(context: string): Promise<Recommendation[]> {
    const lowered = context.toLowerCase();
    const recs: Recommendation[] = [];

    if (lowered.includes('blocked') || lowered.includes('stuck')) {
      recs.push({
        title: 'Unblock with reflection-first triage',
        rationale: 'Context indicates blocked flow; reflection + narrowed scope usually restores momentum.',
        confidence: 0.78,
        actions: ['Run memphis insights --daily', 'Record one decision with clear next action'],
      });
    }

    recs.push({
      title: 'Synthesize related chains',
      rationale: 'Cross-chain synthesis surfaces reusable patterns and hidden dependencies.',
      confidence: 0.7,
      actions: ['Run memphis connections scan', 'Review bridge topics and convert one to an action'],
    });

    return recs.slice(0, 3);
  }

  private async embeddingStrength(topicA: string, topicB: string): Promise<number> {
    const query = `${topicA} ${topicB}`;
    const fn = this.deps.embedSearchFn ?? embedSearch;

    try {
      const result = fn(query, 3);
      const top = result.hits?.[0]?.score ?? 0.35;
      return Math.max(0, Math.min(1, top));
    } catch {
      return 0.35;
    }
  }
}
