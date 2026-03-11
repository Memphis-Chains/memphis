import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { AgentRegistry } from './agent-registry.js';
import type { AgentIdentity, AgentRelationship } from './model-d-types.js';
import { getDataDir } from '../config/paths.js';

function socialDir(): string {
  return join(getDataDir(), 'social');
}

function relationshipsPath(): string {
  return join(socialDir(), 'relationships.json');
}

function keyOf(rel: Pick<AgentRelationship, 'from' | 'to' | 'type'>): string {
  return `${rel.from}::${rel.to}::${rel.type}`;
}

export class RelationshipGraph {
  private readonly edges = new Map<string, AgentRelationship>();

  constructor(
    private readonly registry: AgentRegistry,
    private readonly storagePath: string = relationshipsPath(),
  ) {
    this.load();
  }

  /**
   * Adds or merges a relationship edge between two agents.
   */
  addRelationship(rel: AgentRelationship): void {
    const key = keyOf(rel);
    const existing = this.edges.get(key);

    const merged: AgentRelationship = existing
      ? {
          ...existing,
          strength: Math.max(0, Math.min(1, (existing.strength + rel.strength) / 2)),
          interactions: existing.interactions + Math.max(1, rel.interactions),
          lastInteraction: new Date(rel.lastInteraction),
        }
      : {
          ...rel,
          strength: Math.max(0, Math.min(1, rel.strength)),
          interactions: Math.max(1, rel.interactions),
          lastInteraction: new Date(rel.lastInteraction),
        };

    this.edges.set(key, merged);
    this.save();
  }

  /**
   * Calculates a blended trust score from direct trust and collaboration edges.
   */
  getTrustScore(from: string, to: string): number {
    const directTrust = this.edges.get(`${from}::${to}::trusts`)?.strength ?? 0;
    const collab = this.edges.get(`${from}::${to}::collaborates`)?.strength ?? 0;
    return Math.max(0, Math.min(1, directTrust * 0.7 + collab * 0.3));
  }

  /**
   * Lists collaborators for an agent ordered by relationship strength.
   */
  getCollaborators(did: string): AgentIdentity[] {
    const direct = Array.from(this.edges.values())
      .filter((rel) => rel.from === did && rel.type === 'collaborates' && rel.strength >= 0.3)
      .sort((a, b) => b.strength - a.strength)
      .map((rel) => this.registry.getAgent(rel.to))
      .filter((v): v is AgentIdentity => v !== null);

    return direct;
  }

  /**
   * Suggests partner agents that are connected but not yet active collaborators.
   */
  suggestPartners(did: string): AgentIdentity[] {
    const collaborators = this.getCollaborators(did).map((a) => a.did);
    const candidates = Array.from(this.edges.values())
      .filter((rel) => rel.from === did || rel.to === did)
      .map((rel) => (rel.from === did ? rel.to : rel.from))
      .filter((otherDid) => !collaborators.includes(otherDid));

    return [...new Set(candidates)]
      .map((candidateDid) => this.registry.getAgent(candidateDid))
      .filter((v): v is AgentIdentity => v !== null)
      .sort((a, b) => b.reputation - a.reputation);
  }

  /**
   * Returns all relationships involving the specified agent.
   */
  listByAgent(did: string): AgentRelationship[] {
    return Array.from(this.edges.values()).filter((rel) => rel.from === did || rel.to === did);
  }

  /**
   * Returns all relationship edges in the graph.
   */
  listAll(): AgentRelationship[] {
    return Array.from(this.edges.values());
  }

  private load(): void {
    if (!existsSync(this.storagePath)) return;
    const raw = JSON.parse(readFileSync(this.storagePath, 'utf8')) as AgentRelationship[];
    for (const rel of raw) {
      this.edges.set(keyOf(rel), { ...rel, lastInteraction: new Date(rel.lastInteraction) });
    }
  }

  private save(): void {
    mkdirSync(socialDir(), { recursive: true });
    writeFileSync(this.storagePath, JSON.stringify(this.listAll(), null, 2), 'utf8');
  }
}
