// Graceful Degradation System
// Ensures system remains functional even when components fail

export interface SearchResult {
  id: string;
  content: string;
  score: number;
  timestamp: string;
}

export class ResilienceManager {
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
      console.error('⚠️ TypeScript search failed, trying in-memory cache');
    }

    // Strategy 3: In-memory cache (last resort)
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
    // Pure TypeScript implementation
    const { searchChainTS } = await import('./ts-search.js');
    return await searchChainTS(query);
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

    // Test Cache
    try {
      await this.cacheSearch('test');
      strategies.cache = true;
    } catch {
      // Cache failed
    }

    const healthyCount = Object.values(strategies).filter(Boolean).length;

    return {
      status: healthyCount > 0 ? 'DEGRADED' : 'DOWN',
      strategies,
      healthyCount,
      recommendation: this.getRecommendation(healthyCount),
    };
  }

  /**
   * Get recommendation based on health
   */
  private getRecommendation(healthyCount: number): string {
    if (healthyCount === 3) {
      return 'All systems operational';
    } else if (healthyCount === 2) {
      return 'Primary system degraded, fallback available';
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
    cache: boolean;
  };
  healthyCount: number;
  recommendation: string;
}
