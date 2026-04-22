import { describe, expect, it } from 'vitest';

import { SearchCascade } from '../../../src/resilience/fallback.js';

describe('SearchCascade', () => {
  describe('healthCheck', () => {
    it('includes typescript and cache strategy fields', async () => {
      const cascade = new SearchCascade();
      const health = await cascade.healthCheck();

      expect(health.strategies).toHaveProperty('typescript');
      expect(health.strategies).toHaveProperty('cache');
      expect(Object.keys(health.strategies)).toHaveLength(2);
    });

    it('returns valid status: HEALTHY, DEGRADED, or DOWN', async () => {
      const cascade = new SearchCascade();
      const health = await cascade.healthCheck();

      expect(['HEALTHY', 'DEGRADED', 'DOWN']).toContain(health.status);
    });

    it('healthyCount matches number of true strategies', async () => {
      const cascade = new SearchCascade();
      const health = await cascade.healthCheck();

      const trueStrategies = Object.values(health.strategies).filter(Boolean).length;
      expect(health.healthyCount).toBe(trueStrategies);
    });

    it('recommendation is non-empty string', async () => {
      const cascade = new SearchCascade();
      const health = await cascade.healthCheck();

      expect(typeof health.recommendation).toBe('string');
      expect(health.recommendation.length).toBeGreaterThan(0);
    });
  });

  describe('search cascade', () => {
    it('search returns a SearchResult from the cascade', async () => {
      const cascade = new SearchCascade();
      const result = await cascade.search('test query');

      expect(result).toBeDefined();
      expect(result).toHaveProperty('id');
      expect(result).toHaveProperty('content');
      expect(result).toHaveProperty('score');
      expect(result).toHaveProperty('timestamp');
    });

    it('search result has valid structure', async () => {
      const cascade = new SearchCascade();
      const result = await cascade.search('block');

      expect(typeof result.id).toBe('string');
      expect(typeof result.content).toBe('string');
      expect(typeof result.score).toBe('number');
      expect(result.score).toBeGreaterThanOrEqual(0);
    });
  });
});
