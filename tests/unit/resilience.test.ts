/**
 * Tests for src/resilience/ modules:
 * - fallback.ts (ResilienceManager cascade)
 * - ts-search.ts (TypeScript search stub)
 * - cache.ts (in-memory search cache)
 */

import { describe, expect, it } from 'vitest';

import { cache } from '../../src/resilience/cache.js';
import { ResilienceManager } from '../../src/resilience/fallback.js';
import { searchChainTS } from '../../src/resilience/ts-search.js';

describe('searchChainTS', () => {
  it('returns empty results for empty query', async () => {
    const result = await searchChainTS('');
    expect(result.results).toEqual([]);
  });

  it('returns empty results for whitespace-only query', async () => {
    const result = await searchChainTS('   ');
    expect(result.results).toEqual([]);
  });

  it('returns results array structure when chain data exists', async () => {
    // Search for something that likely exists in test data
    const result = await searchChainTS('ok');
    expect(result.results).toBeDefined();
    expect(Array.isArray(result.results)).toBe(true);
    // If results exist, they should have required fields
    if (result.results.length > 0) {
      const r = result.results[0]!;
      expect(typeof r.id).toBe('string');
      expect(typeof r.score).toBe('number');
      expect(typeof r.timestamp).toBe('string');
      expect(typeof r.content).toBe('string');
      expect(r.score).toBeGreaterThan(0);
    }
  });
});

describe('SearchCache', () => {
  it('returns null for missing keys', () => {
    expect(cache.get('nonexistent-key')).toBeNull();
  });

  it('stores and retrieves results', () => {
    const result = {
      id: 'test-1',
      content: 'cached result',
      score: 0.9,
      timestamp: new Date().toISOString(),
    };
    cache.set('my-query', result);
    expect(cache.get('my-query')).toEqual(result);
  });

  it('overwrites existing entries', () => {
    const first = { id: 'a', content: 'first', score: 0.5, timestamp: '' };
    const second = { id: 'b', content: 'second', score: 0.8, timestamp: '' };
    cache.set('overwrite-key', first);
    cache.set('overwrite-key', second);
    expect(cache.get('overwrite-key')?.id).toBe('b');
  });
});

describe('ResilienceManager', () => {
  it('falls through to TS search when Rust throws', async () => {
    const manager = new ResilienceManager();
    // Rust always throws, TS returns stub — search should not throw
    const result = await manager.search('test');
    expect(result).toBeDefined();
    expect(result.warning).toBeDefined();
  });

  it('healthCheck reports degraded when Rust is unavailable', async () => {
    const manager = new ResilienceManager();
    const health = await manager.healthCheck();
    expect(health.status).toBe('DEGRADED');
    expect(health.strategies.rust).toBe(false);
    expect(health.strategies.typescript).toBe(true);
    expect(health.healthyCount).toBeGreaterThanOrEqual(1);
  });

  it('provides recommendations based on health', async () => {
    const manager = new ResilienceManager();
    const health = await manager.healthCheck();
    expect(typeof health.recommendation).toBe('string');
    expect(health.recommendation.length).toBeGreaterThan(0);
  });
});
