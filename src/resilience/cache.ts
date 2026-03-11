// In-memory cache for degraded mode

export interface SearchResult {
  id: string;
  content: string;
  score: number;
  timestamp: string;
}

class SearchCache {
  private cache = new Map<string, SearchResult>();

  get(query: string): SearchResult | null {
    return this.cache.get(query) || null;
  }

  set(query: string, result: SearchResult): void {
    this.cache.set(query, result);
  }
}

export const cache = new SearchCache();
