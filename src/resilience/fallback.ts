import type { SearchResult } from '../core/types.js';

export class SearchCascade {
  async search(query: string): Promise<SearchResult> {
    try {
      const result = await this.tsSearch(query);
      return result;
    } catch {
      // TypeScript search failed, try cache
    }

    try {
      const result = await this.cacheSearch(query);
      return result;
    } catch {
      throw new Error('Search unavailable - all methods failed', {
        cause: new Error('all fallback strategies failed'),
      });
    }
  }

  private async tsSearch(query: string): Promise<SearchResult> {
    const { searchChainTS } = await import('./ts-search.js');
    const { cache } = await import('./cache.js');
    const result = await searchChainTS(query);
    if (result.results.length > 0) {
      const searchResult = result.results[0];
      cache.set(query, searchResult);
      return searchResult;
    }
    return {
      id: 'ts-fallback',
      content: '',
      score: 0,
      timestamp: new Date().toISOString(),
      warning: result.warning,
    };
  }

  private async cacheSearch(query: string): Promise<SearchResult> {
    const { cache } = await import('./cache.js');
    const cached = cache.get(query);

    if (cached) {
      return cached;
    }

    throw new Error('No cached results available');
  }

  async healthCheck(): Promise<HealthStatus> {
    const strategies = {
      typescript: false,
      cache: false,
    };

    try {
      await this.tsSearch('test');
      strategies.typescript = true;
    } catch {
      // TypeScript search unavailable
    }

    try {
      await this.cacheSearch('test');
      strategies.cache = true;
    } catch {
      // Cache unavailable
    }

    const healthyCount = Object.values(strategies).filter(Boolean).length;

    return {
      status: healthyCount === 2 ? 'HEALTHY' : healthyCount === 1 ? 'DEGRADED' : 'DOWN',
      strategies,
      healthyCount,
      recommendation: this.getRecommendation(healthyCount),
    };
  }

  private getRecommendation(healthyCount: number): string {
    if (healthyCount === 2) {
      return 'All systems operational';
    } else if (healthyCount === 1) {
      return 'WARNING: Only one search method available';
    } else {
      return 'EMERGENCY: All search systems down';
    }
  }
}

interface HealthStatus {
  status: 'HEALTHY' | 'DEGRADED' | 'DOWN';
  strategies: {
    typescript: boolean;
    cache: boolean;
  };
  healthyCount: number;
  recommendation: string;
}
