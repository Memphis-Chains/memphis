import type { AgentIdentity, Decision, Suggestion } from './model-d-types.js';
import { AgentRegistry } from './agent-registry.js';
import { RelationshipGraph } from './relationship-graph.js';

export class CollaborativeFilter {
  private readonly preferences = new Map<string, Map<string, number>>();

  constructor(
    private readonly registry: AgentRegistry,
    private readonly graph: RelationshipGraph,
  ) {}

  /**
   * Records or increments an agent's preference score for a topic.
   */
  recordPreference(did: string, topic: string, weight = 1): void {
    const current = this.preferences.get(did) ?? new Map<string, number>();
    current.set(topic, (current.get(topic) ?? 0) + weight);
    this.preferences.set(did, current);
  }

  /**
   * Suggests topics for an agent using similar-agent preferences and reputation weighting.
   */
  suggestForAgent(did: string): Suggestion[] {
    const similar = this.findSimilarAgents(did);
    const ownTopics = this.preferences.get(did) ?? new Map<string, number>();
    const scored = new Map<string, number>();

    for (const other of similar) {
      const pref = this.preferences.get(other.did);
      if (!pref) continue;
      for (const [topic, score] of pref.entries()) {
        if (ownTopics.has(topic)) continue;
        scored.set(topic, (scored.get(topic) ?? 0) + score * (other.reputation / 100));
      }
    }

    return Array.from(scored.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([topic, score], idx) => ({
        id: `${did}:${topic}:${idx}`,
        topic,
        score,
        reason: 'recommended by similar high-reputation agents',
      }));
  }

  /**
   * Finds agents with overlapping topic preferences and trust affinity.
   */
  findSimilarAgents(did: string): AgentIdentity[] {
    const mine = this.preferences.get(did) ?? new Map<string, number>();
    const agents = this.registry.listAll().filter((a) => a.did !== did);

    const withScore = agents
      .map((agent) => {
        const theirs = this.preferences.get(agent.did) ?? new Map<string, number>();
        const overlap = Array.from(mine.keys()).filter((topic) => theirs.has(topic)).length;
        const socialBoost = this.graph.getTrustScore(did, agent.did);
        const score = overlap + socialBoost;
        return { agent, score };
      })
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score);

    return withScore.map((x) => x.agent);
  }

  /**
   * Produces a weighted collective decision for a topic namespace.
   */
  collectiveDecision(topic: string): Decision {
    const tally = new Map<string, number>();

    for (const agent of this.registry.listAll()) {
      const pref = this.preferences.get(agent.did);
      if (!pref) continue;
      for (const [option, weight] of pref.entries()) {
        if (!option.startsWith(`${topic}:`)) continue;
        tally.set(option, (tally.get(option) ?? 0) + weight * (agent.reputation / 100));
      }
    }

    const votes = Array.from(tally.entries())
      .map(([option, score]) => ({ option, score }))
      .sort((a, b) => b.score - a.score);

    const winner = votes[0]?.option ?? `${topic}:undecided`;
    const total = votes.reduce((sum, v) => sum + v.score, 0);
    const confidence = total > 0 ? (votes[0]?.score ?? 0) / total : 0;

    return {
      topic,
      winner,
      confidence,
      votes,
    };
  }
}
