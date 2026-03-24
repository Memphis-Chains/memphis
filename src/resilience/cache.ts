// In-memory cache for degraded mode

export interface SearchResult {
  id: string;
  content: string;
  score: number;
  timestamp: string;
}

interface CacheEntry {
  result: SearchResult;
  expiresAt: number;
}

export class SearchCache {
  private cache = new Map<string, CacheEntry>();
  private readonly MAX_SIZE = 500;
  private readonly TTL_MS = 5 * 60 * 1000;

  get(query: string): SearchResult | null {
    const entry = this.cache.get(query);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.cache.delete(query);
      return null;
    }
    // LRU touch
    this.cache.delete(query);
    this.cache.set(query, entry);
    return entry.result;
  }

  set(query: string, result: SearchResult): void {
    if (this.cache.size >= this.MAX_SIZE) {
      const keys = [...this.cache.keys()];
      keys.slice(0, Math.floor(this.MAX_SIZE / 2)).forEach((k) => this.cache.delete(k));
    }
    this.cache.set(query, { result, expiresAt: Date.now() + this.TTL_MS });
  }

  clear(): void {
    this.cache.clear();
  }

  get size(): number {
    return this.cache.size;
  }
}

export const cache = new SearchCache();
