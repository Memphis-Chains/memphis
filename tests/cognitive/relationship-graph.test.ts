import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { AgentRegistry } from '../../src/cognitive/agent-registry.js';
import { RelationshipGraph } from '../../src/cognitive/relationship-graph.js';

describe('RelationshipGraph', () => {
  it('stores relationships and computes trust score', () => {
    const dir = mkdtempSync(join(tmpdir(), 'memphis-relationship-'));
    const registry = new AgentRegistry(join(dir, 'agents.json'));
    registry.register({
      did: 'did:memphis:a',
      name: 'A',
      publicKey: 'a',
      capabilities: [],
      reputation: 60,
      lastSeen: new Date(),
    });
    registry.register({
      did: 'did:memphis:b',
      name: 'B',
      publicKey: 'b',
      capabilities: [],
      reputation: 80,
      lastSeen: new Date(),
    });

    const graph = new RelationshipGraph(registry, join(dir, 'relationships.json'));
    graph.addRelationship({
      from: 'did:memphis:a',
      to: 'did:memphis:b',
      type: 'trusts',
      strength: 0.8,
      interactions: 1,
      lastInteraction: new Date(),
    });
    graph.addRelationship({
      from: 'did:memphis:a',
      to: 'did:memphis:b',
      type: 'collaborates',
      strength: 0.5,
      interactions: 2,
      lastInteraction: new Date(),
    });

    expect(graph.getTrustScore('did:memphis:a', 'did:memphis:b')).toBeGreaterThan(0.6);
  });

  it('returns collaborators and partner suggestions', () => {
    const dir = mkdtempSync(join(tmpdir(), 'memphis-relationship-'));
    const registry = new AgentRegistry(join(dir, 'agents.json'));
    registry.register({
      did: 'did:memphis:a',
      name: 'A',
      publicKey: 'a',
      capabilities: [],
      reputation: 40,
      lastSeen: new Date(),
    });
    registry.register({
      did: 'did:memphis:b',
      name: 'B',
      publicKey: 'b',
      capabilities: [],
      reputation: 90,
      lastSeen: new Date(),
    });
    registry.register({
      did: 'did:memphis:c',
      name: 'C',
      publicKey: 'c',
      capabilities: [],
      reputation: 70,
      lastSeen: new Date(),
    });

    const graph = new RelationshipGraph(registry, join(dir, 'relationships.json'));
    graph.addRelationship({
      from: 'did:memphis:a',
      to: 'did:memphis:b',
      type: 'collaborates',
      strength: 0.7,
      interactions: 2,
      lastInteraction: new Date(),
    });
    graph.addRelationship({
      from: 'did:memphis:c',
      to: 'did:memphis:a',
      type: 'trusts',
      strength: 0.4,
      interactions: 1,
      lastInteraction: new Date(),
    });

    const collaborators = graph.getCollaborators('did:memphis:a');
    expect(collaborators.map((x) => x.did)).toContain('did:memphis:b');

    const suggestions = graph.suggestPartners('did:memphis:a');
    expect(suggestions.map((x) => x.did)).toContain('did:memphis:c');
  });
});
