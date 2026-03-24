import { describe, expect, it } from 'vitest';

import { ResilienceManager } from '../../../src/resilience/fallback.js';

describe('ResilienceManager', () => {
  describe('healthCheck', () => {
    it('includes all four strategy fields in health status', async () => {
      const manager = new ResilienceManager();
      const health = await manager.healthCheck();

      expect(health.strategies).toHaveProperty('rust');
      expect(health.strategies).toHaveProperty('typescript');
      expect(health.strategies).toHaveProperty('hnsw');
      expect(health.strategies).toHaveProperty('cache');
    });

    it('returns valid status: HEALTHY, DEGRADED, or DOWN', async () => {
      const manager = new ResilienceManager();
      const health = await manager.healthCheck();

      expect(['HEALTHY', 'DEGRADED', 'DOWN']).toContain(health.status);
    });

    it('healthyCount matches number of true strategies', async () => {
      const manager = new ResilienceManager();
      const health = await manager.healthCheck();

      const trueStrategies = Object.values(health.strategies).filter(Boolean).length;
      expect(health.healthyCount).toBe(trueStrategies);
    });

    it('recommendation is non-empty string', async () => {
      const manager = new ResilienceManager();
      const health = await manager.healthCheck();

      expect(typeof health.recommendation).toBe('string');
      expect(health.recommendation.length).toBeGreaterThan(0);
    });

    it('HNSW strategy is currently not populated (throws)', async () => {
      const manager = new ResilienceManager();
      const health = await manager.healthCheck();

      // HNSW throws "not yet populated" in current implementation
      expect(health.strategies.hnsw).toBe(false);
    });
  });

  describe('search cascade', () => {
    it('search returns a SearchResult from the cascade', async () => {
      const manager = new ResilienceManager();
      const result = await manager.search('test query');

      expect(result).toBeDefined();
      expect(result).toHaveProperty('id');
      expect(result).toHaveProperty('content');
      expect(result).toHaveProperty('score');
      expect(result).toHaveProperty('timestamp');
    });

    it('search result has valid structure', async () => {
      const manager = new ResilienceManager();
      const result = await manager.search('block');

      expect(typeof result.id).toBe('string');
      expect(typeof result.content).toBe('string');
      expect(typeof result.score).toBe('number');
      expect(result.score).toBeGreaterThanOrEqual(0);
    });
  });
});
