import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export interface HnswIndexOptions {
  dimensions: number;
  maxNeighbors?: number;
  efSearch?: number;
}

export interface SearchResult {
  id: string;
  score: number;
}

export interface HnswSearchDiagnostics {
  visited: number;
  totalNodes: number;
}

type NodeEntry = {
  id: string;
  vector: number[];
  neighbors: Set<string>;
};

export class HnswIndex {
  private readonly dimensions: number;
  private readonly maxNeighbors: number;
  private readonly efSearch: number;
  private readonly nodes = new Map<string, NodeEntry>();
  private entryPointId: string | null = null;

  constructor(options: HnswIndexOptions) {
    this.dimensions = options.dimensions;
    this.maxNeighbors = Math.max(2, options.maxNeighbors ?? 16);
    this.efSearch = Math.max(4, options.efSearch ?? 32);
  }

  add(id: string, vector: number[]): void {
    this.assertVector(vector);

    if (this.nodes.has(id)) {
      this.update(id, vector);
      return;
    }

    const entry: NodeEntry = { id, vector: normalize(vector), neighbors: new Set<string>() };
    const nearest = this.searchInternal(entry.vector, this.maxNeighbors);

    for (const candidate of nearest) {
      entry.neighbors.add(candidate.id);
    }

    this.nodes.set(id, entry);

    if (!this.entryPointId) {
      this.entryPointId = id;
    }

    for (const neighborId of entry.neighbors) {
      const neighbor = this.nodes.get(neighborId);
      if (!neighbor) continue;
      neighbor.neighbors.add(id);
      this.trimNeighbors(neighbor);
    }

    this.trimNeighbors(entry);
  }

  update(id: string, vector: number[]): void {
    this.assertVector(vector);
    const existing = this.nodes.get(id);
    if (!existing) {
      this.add(id, vector);
      return;
    }

    existing.vector = normalize(vector);
    const nearest = this.searchInternal(existing.vector, this.maxNeighbors + 1).filter(
      (item) => item.id !== id,
    );
    existing.neighbors.clear();
    for (const candidate of nearest.slice(0, this.maxNeighbors)) {
      existing.neighbors.add(candidate.id);
    }
  }

  search(query: number[], k = 10): SearchResult[] {
    this.assertVector(query);
    return this.searchInternal(normalize(query), k);
  }

  searchWithDiagnostics(
    query: number[],
    k = 10,
  ): { results: SearchResult[]; diagnostics: HnswSearchDiagnostics } {
    this.assertVector(query);
    const diagnostics: HnswSearchDiagnostics = { visited: 0, totalNodes: this.nodes.size };
    const results = this.searchInternal(normalize(query), k, diagnostics);
    return { results, diagnostics };
  }

  private searchInternal(
    query: number[],
    k: number,
    diagnostics?: HnswSearchDiagnostics,
  ): SearchResult[] {
    if (this.nodes.size === 0) return [];

    const ef = Math.max(k, this.efSearch);
    const entry = this.pickEntryPoint();
    if (!entry) return [];

    const visited = new Set<string>();
    const candidates: SearchResult[] = [];
    const best: SearchResult[] = [];

    const pushCandidate = (candidate: SearchResult): void => {
      let inserted = false;
      for (let i = 0; i < candidates.length; i += 1) {
        if (candidate.score > candidates[i]!.score) {
          candidates.splice(i, 0, candidate);
          inserted = true;
          break;
        }
      }
      if (!inserted) candidates.push(candidate);
    };

    const pushBest = (candidate: SearchResult): void => {
      let inserted = false;
      for (let i = 0; i < best.length; i += 1) {
        if (candidate.score > best[i]!.score) {
          best.splice(i, 0, candidate);
          inserted = true;
          break;
        }
      }
      if (!inserted) best.push(candidate);
      if (best.length > ef) best.pop();
    };

    const seedScore = cosine(query, entry.vector);
    pushCandidate({ id: entry.id, score: seedScore });
    pushBest({ id: entry.id, score: seedScore });
    visited.add(entry.id);

    while (candidates.length > 0 && visited.size < this.nodes.size) {
      const current = candidates.shift() as SearchResult;
      const worstBest = best[best.length - 1]?.score ?? Number.NEGATIVE_INFINITY;

      if (best.length >= ef && current.score < worstBest) {
        break;
      }

      const node = this.nodes.get(current.id);
      if (!node) continue;

      for (const neighborId of node.neighbors) {
        if (visited.has(neighborId)) continue;
        visited.add(neighborId);

        const neighbor = this.nodes.get(neighborId);
        if (!neighbor) continue;

        const score = cosine(query, neighbor.vector);
        if (best.length < ef || score > worstBest) {
          const candidate = { id: neighborId, score };
          pushCandidate(candidate);
          pushBest(candidate);
        }
      }
    }

    if (diagnostics) {
      diagnostics.visited = visited.size;
      diagnostics.totalNodes = this.nodes.size;
    }

    return best.slice(0, k);
  }

  async save(filePath: string): Promise<void> {
    await mkdir(dirname(filePath), { recursive: true });
    const payload = {
      dimensions: this.dimensions,
      maxNeighbors: this.maxNeighbors,
      efSearch: this.efSearch,
      entryPointId: this.entryPointId,
      nodes: [...this.nodes.values()].map((node) => ({
        id: node.id,
        vector: node.vector,
        neighbors: [...node.neighbors],
      })),
    };
    await writeFile(filePath, JSON.stringify(payload), 'utf8');
  }

  async load(filePath: string): Promise<void> {
    const raw = await readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw) as {
      dimensions: number;
      entryPointId?: string | null;
      nodes: Array<{ id: string; vector: number[]; neighbors: string[] }>;
    };

    if (parsed.dimensions !== this.dimensions) {
      throw new Error(`dimension mismatch: expected ${this.dimensions}, got ${parsed.dimensions}`);
    }

    this.nodes.clear();
    for (const node of parsed.nodes) {
      this.nodes.set(node.id, {
        id: node.id,
        vector: node.vector,
        neighbors: new Set(node.neighbors),
      });
    }
    this.entryPointId = parsed.entryPointId ?? this.nodes.keys().next().value ?? null;
  }

  size(): number {
    return this.nodes.size;
  }

  clear(): void {
    this.nodes.clear();
    this.entryPointId = null;
  }

  private pickEntryPoint(): NodeEntry | undefined {
    if (this.entryPointId) {
      const pinned = this.nodes.get(this.entryPointId);
      if (pinned) return pinned;
    }

    const first = this.nodes.values().next().value as NodeEntry | undefined;
    if (first) {
      this.entryPointId = first.id;
    }
    return first;
  }

  private trimNeighbors(node: NodeEntry): void {
    if (node.neighbors.size <= this.maxNeighbors) {
      return;
    }

    const ranked = [...node.neighbors]
      .map((id) => {
        const target = this.nodes.get(id);
        return {
          id,
          score: target ? cosine(node.vector, target.vector) : -1,
        };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, this.maxNeighbors);

    node.neighbors = new Set(ranked.map((x) => x.id));
  }

  private assertVector(vector: number[]): void {
    if (vector.length !== this.dimensions) {
      throw new Error(`invalid vector size: expected ${this.dimensions}, got ${vector.length}`);
    }
  }
}

function normalize(vec: number[]): number[] {
  const norm = Math.hypot(...vec) || 1;
  return vec.map((value) => value / norm);
}

function cosine(a: number[], b: number[]): number {
  let sum = 0;
  for (let i = 0; i < a.length; i += 1) {
    sum += a[i]! * b[i]!;
  }
  return sum;
}
