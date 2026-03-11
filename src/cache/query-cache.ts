// Query Result Cache - Performance Optimization Layer
// Reduces repeated semantic search latency

interface CacheEntry<T> {
  data: T;
  timestamp: number;
  hits: number;
}

export class QueryCache<T = unknown> {
  private cache = new Map<string, CacheEntry<T>>();
  private maxAge: number;
  private maxSize: number;

  constructor(maxAgeMs: number = 60000, maxSize: number = 1000) {
    this.maxAge = maxAgeMs;
    this.maxSize = maxSize;
  }

  /**
   * Get cached result if valid
   */
  get(query: string): T | null {
    const entry = this.cache.get(query);

    if (!entry) return null;

    // Check if expired
    if (Date.now() - entry.timestamp > this.maxAge) {
      this.cache.delete(query);
      return null;
    }

    // Cache hit!
    entry.hits++;
    return entry.data;
  }

  /**
   * Store result in cache
   */
  set(query: string, result: T): void {
    // Evict oldest if at capacity
    if (this.cache.size >= this.maxSize) {
      this.evictOldest();
    }

    this.cache.set(query, {
      data: result,
      timestamp: Date.now(),
      hits: 0
    });
  }

  /**
   * Check if query is cached and valid
   */
  has(query: string): boolean {
    const entry = this.cache.get(query);
    if (!entry) return false;

    // Check expiration
    if (Date.now() - entry.timestamp > this.maxAge) {
      this.cache.delete(query);
      return false;
    }

    return true;
  }

  /**
   * Clear expired entries
   */
  prune(): number {
    const now = Date.now();
    let pruned = 0;

    for (const [key, entry] of this.cache.entries()) {
      if (now - entry.timestamp > this.maxAge) {
        this.cache.delete(key);
        pruned++;
      }
    }

    return pruned;
  }

  /**
   * Get cache statistics
   */
  stats(): {
    size: number;
    hitRate: number;
    avgAge: number;
  } {
    let totalHits = 0;
    let totalAge = 0;
    const now = Date.now();

    for (const entry of this.cache.values()) {
      totalHits += entry.hits;
      totalAge += now - entry.timestamp;
    }

    return {
      size: this.cache.size,
      hitRate: totalHits / Math.max(1, this.cache.size),
      avgAge: totalAge / Math.max(1, this.cache.size)
    };
  }

  /**
   * Clear all cache
   */
  clear(): void {
    this.cache.clear();
  }

  /**
   * Evict oldest entry (LRU)
   */
  private evictOldest(): void {
    let oldest: string | null = null;
    let oldestTime = Infinity;

    for (const [key, entry] of this.cache.entries()) {
      if (entry.timestamp < oldestTime) {
        oldestTime = entry.timestamp;
        oldest = key;
      }
    }

    if (oldest) {
      this.cache.delete(oldest);
    }
  }
}

// Global query cache instance (1 minute TTL, 1000 queries)
export const queryCache = new QueryCache(60000, 1000);
