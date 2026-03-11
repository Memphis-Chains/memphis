import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { TrustEdge } from './model-d-types.js';
import { getDataDir } from '../config/paths.js';

function socialDir(): string {
  return join(getDataDir(), 'social');
}

function trustPath(): string {
  return join(socialDir(), 'trust-metrics.json');
}

function edgeKey(from: string, to: string): string {
  return `${from}::${to}`;
}

export class TrustMetrics {
  private readonly edges = new Map<string, TrustEdge>();

  constructor(private readonly storagePath: string = trustPath()) {
    this.load();
  }

  /**
   * Computes the average incoming trust score for an agent.
   */
  calculateGlobalTrust(did: string): number {
    const incoming = Array.from(this.edges.values()).filter((edge) => edge.to === did);
    if (incoming.length === 0) return 0;
    const score = incoming.reduce((sum, edge) => sum + edge.score, 0) / incoming.length;
    return Math.max(0, Math.min(1, score));
  }

  /**
   * Returns the direct trust score from one agent to another.
   */
  calculateLocalTrust(from: string, to: string): number {
    return this.edges.get(edgeKey(from, to))?.score ?? 0;
  }

  /**
   * Applies time-based decay to all recorded trust edges.
   */
  decayTrustOverTime(decayPerDay = 0.01): void {
    const now = Date.now();
    for (const [key, edge] of this.edges.entries()) {
      const days = Math.max(
        0,
        (now - new Date(edge.lastUpdated).getTime()) / (24 * 60 * 60 * 1000),
      );
      const next = Math.max(0, edge.score - days * decayPerDay);
      this.edges.set(key, { ...edge, score: next, lastUpdated: new Date() });
    }
    this.save();
  }

  /**
   * Records an interaction outcome and updates the corresponding trust edge.
   */
  recordInteraction(from: string, to: string, outcome: 'positive' | 'negative'): void {
    const key = edgeKey(from, to);
    const current = this.edges.get(key) ?? {
      from,
      to,
      score: 0.5,
      interactions: 0,
      lastUpdated: new Date(),
    };

    const delta = outcome === 'positive' ? 0.1 : -0.15;
    const nextScore = Math.max(0, Math.min(1, current.score + delta));

    this.edges.set(key, {
      ...current,
      score: nextScore,
      interactions: current.interactions + 1,
      lastUpdated: new Date(),
    });

    this.save();
  }

  /**
   * Returns all stored trust relationships.
   */
  listAll(): TrustEdge[] {
    return Array.from(this.edges.values());
  }

  private load(): void {
    if (!existsSync(this.storagePath)) return;
    const raw = JSON.parse(readFileSync(this.storagePath, 'utf8')) as TrustEdge[];
    for (const edge of raw) {
      this.edges.set(edgeKey(edge.from, edge.to), {
        ...edge,
        lastUpdated: new Date(edge.lastUpdated),
      });
    }
  }

  private save(): void {
    mkdirSync(socialDir(), { recursive: true });
    writeFileSync(this.storagePath, JSON.stringify(this.listAll(), null, 2), 'utf8');
  }
}
