// Graceful Degradation System
// Ensures system remains functional even when components fail

import { HnswIndex } from '../infra/embeddings/hnsw-index.js';

export interface SearchResult {
  id: string;
  content: string;
  score: number;
  timestamp: string;
  warning?: string;
}

export class ResilienceManager {
  private readonly hnswIndex: HnswIndex;

  constructor(private readonly embedDim: number = 32) {
    this.hnswIndex = new HnswIndex({ dimensions: embedDim, maxNeighbors: 16, efSearch: 32 });
  }

  /**
   * Search with multiple fallback strategies
   */
  async search(query: string): Promise<SearchResult> {
    // Strategy 1: Rust chain (fastest, most reliable)
    try {
      const result = await this.rustSearch(query);
      console.log('✅ Search via Rust chain');
      return result;
    } catch {
      console.warn('⚠️ Rust search failed, trying TypeScript fallback');
    }

    // Strategy 2: TypeScript implementation
    try {
      const result = await this.tsSearch(query);
      console.log('✅ Search via TypeScript fallback');
      return result;
    } catch {
      console.warn('⚠️ TypeScript search failed, trying HNSW vector index');
    }

    // Strategy 3: HNSW vector index (pre-populated from chain)
    try {
      const result = await this.hnswSearch(query);
      console.log('✅ Search via HNSW vector index');
      return result;
    } catch {
      console.warn('⚠️ HNSW search failed, trying in-memory cache');
    }

    // Strategy 4: In-memory cache (last resort)
    try {
      const result = await this.cacheSearch(query);
      console.log('✅ Search via in-memory cache (degraded mode)');
      return result;
    } catch {
      console.error('❌ All search strategies failed');
      throw new Error('Search unavailable - all methods failed', {
        cause: new Error('all fallback strategies failed'),
      });
    }
  }

  /**
   * Rust-based search (primary)
   */
  private async rustSearch(_query: string): Promise<SearchResult> {
    // Rust search not implemented yet - throw to trigger fallback
    throw new Error('Rust search not available yet');
  }

  /**
   * TypeScript-based search (fallback)
   */
  private async tsSearch(query: string): Promise<SearchResult> {
    const { searchChainTS } = await import('./ts-search.js');
    const { cache } = await import('./cache.js');
    const result = await searchChainTS(query);
    if (result.results.length > 0) {
      const searchResult = result.results[0];
      cache.set(query, searchResult);
      return searchResult;
    }
    // Return a marker result so the cascade doesn't throw
    return {
      id: 'ts-fallback',
      content: '',
      score: 0,
      timestamp: new Date().toISOString(),
      warning: result.warning,
    };
  }

  /**
   * HNSW vector index search (pre-populated from chain embeddings)
   * Throws when index is not populated — cascades to cache fallback.
   */
  private async hnswSearch(_query: string): Promise<SearchResult> {
    // HnswIndex is available for future embedding-powered search.
    // Currently throws to cascade to cache fallback.
    throw new Error('HNSW index not yet populated');
  }

  /**
   * In-memory cache search (degraded)
   */
  private async cacheSearch(query: string): Promise<SearchResult> {
    // Search in recently cached results
    const { cache } = await import('./cache.js');
    const cached = cache.get(query);

    if (cached) {
      return cached;
    }

    throw new Error('No cached results available');
  }

  /**
   * Health check for all search strategies
   */
  async healthCheck(): Promise<HealthStatus> {
    const strategies = {
      rust: false,
      typescript: false,
      hnsw: false,
      cache: false,
    };

    // Test Rust
    try {
      await this.rustSearch('test');
      strategies.rust = true;
    } catch {
      // Rust failed
    }

    // Test TypeScript
    try {
      await this.tsSearch('test');
      strategies.typescript = true;
    } catch {
      // TypeScript failed
    }

    // Test HNSW
    try {
      await this.hnswSearch('test');
      strategies.hnsw = true;
    } catch {
      // HNSW not populated
    }

    // Test Cache
    try {
      await this.cacheSearch('test');
      strategies.cache = true;
    } catch {
      // Cache failed
    }

    const healthyCount = Object.values(strategies).filter(Boolean).length;

    return {
      status: healthyCount >= 3 ? 'DEGRADED' : healthyCount > 0 ? 'DEGRADED' : 'DOWN',
      strategies,
      healthyCount,
      recommendation: this.getRecommendation(healthyCount),
    };
  }

  /**
   * Get recommendation based on health
   */
  private getRecommendation(healthyCount: number): string {
    if (healthyCount === 4) {
      return 'All systems operational';
    } else if (healthyCount === 3) {
      return 'Primary system degraded, fallback available';
    } else if (healthyCount === 2) {
      return 'WARNING: Only two search methods available';
    } else if (healthyCount === 1) {
      return 'CRITICAL: Only one search method available';
    } else {
      return 'EMERGENCY: All search systems down';
    }
  }
}

// Types
interface HealthStatus {
  status: 'HEALTHY' | 'DEGRADED' | 'DOWN';
  strategies: {
    rust: boolean;
    typescript: boolean;
    hnsw: boolean;
    cache: boolean;
  };
  healthyCount: number;
  recommendation: string;
}
