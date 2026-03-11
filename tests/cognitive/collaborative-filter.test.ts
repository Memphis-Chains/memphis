import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { AgentRegistry } from '../../src/cognitive/agent-registry.js';
import { CollaborativeFilter } from '../../src/cognitive/collaborative-filter.js';
import { RelationshipGraph } from '../../src/cognitive/relationship-graph.js';

describe('CollaborativeFilter', () => {
  it('finds similar agents and returns suggestions', () => {
    const dir = mkdtempSync(join(tmpdir(), 'memphis-filter-'));
    const registry = new AgentRegistry(join(dir, 'agents.json'));
    registry.register({ did: 'did:memphis:a', name: 'A', publicKey: 'a', capabilities: [], reputation: 70, lastSeen: new Date() });
    registry.register({ did: 'did:memphis:b', name: 'B', publicKey: 'b', capabilities: [], reputation: 90, lastSeen: new Date() });

    const graph = new RelationshipGraph(registry, join(dir, 'relationships.json'));
    graph.addRelationship({ from: 'did:memphis:a', to: 'did:memphis:b', type: 'trusts', strength: 0.8, interactions: 1, lastInteraction: new Date() });

    const filter = new CollaborativeFilter(registry, graph);
    filter.recordPreference('did:memphis:a', 'ml');
    filter.recordPreference('did:memphis:b', 'ml');
    filter.recordPreference('did:memphis:b', 'ai-safety');

    const similar = filter.findSimilarAgents('did:memphis:a');
    expect(similar[0]?.did).toBe('did:memphis:b');

    const suggestions = filter.suggestForAgent('did:memphis:a');
    expect(suggestions[0]?.topic).toBe('ai-safety');
  });

  it('makes weighted collective decision', () => {
    const dir = mkdtempSync(join(tmpdir(), 'memphis-filter-'));
    const registry = new AgentRegistry(join(dir, 'agents.json'));
    registry.register({ did: 'did:memphis:a', name: 'A', publicKey: 'a', capabilities: [], reputation: 60, lastSeen: new Date() });
    registry.register({ did: 'did:memphis:b', name: 'B', publicKey: 'b', capabilities: [], reputation: 90, lastSeen: new Date() });

    const filter = new CollaborativeFilter(registry, new RelationshipGraph(registry, join(dir, 'relationships.json')));
    filter.recordPreference('did:memphis:a', 'stack:rust', 1);
    filter.recordPreference('did:memphis:b', 'stack:rust', 2);
    filter.recordPreference('did:memphis:a', 'stack:go', 1);

    const decision = filter.collectiveDecision('stack');
    expect(decision.winner).toBe('stack:rust');
    expect(decision.confidence).toBeGreaterThan(0.5);
  });
});
