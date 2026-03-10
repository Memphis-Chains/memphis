import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import {
  clearEmbedSearchCache,
  embedReset,
  embedSearch,
  embedStore,
  getRustEmbedAdapterStatus,
} from '../../src/infra/storage/rust-embed-adapter.js';
import { metrics } from '../../src/infra/logging/metrics.js';

function createBridgeFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'mv4-embed-adapter-'));
  const bridgePath = join(dir, 'bridge.cjs');
  writeFileSync(
    bridgePath,
    `let rows = [];
let searchCalls = 0;
module.exports = {
  embed_reset: () => JSON.stringify({ ok: true, data: { cleared: true } }),
  embed_store: (id, text) => {
    rows.push({ id, text });
    return JSON.stringify({ ok: true, data: { id, count: rows.length, dim: 32, provider: 'local-deterministic' } });
  },
  embed_search: (query, topK = 5) => {
    searchCalls += 1;
    const hits = rows
      .filter((r) => r.text.includes(query))
      .slice(0, topK)
      .map((r) => ({ id: r.id, score: 0.9, text_preview: r.text.slice(0, 20) }));
    return JSON.stringify({ ok: true, data: { query, count: hits.length, hits } });
  },
  __getSearchCalls: () => searchCalls,
};`,
    'utf8',
  );

  const req = createRequire(`${process.cwd()}/`);
  return {
    bridgePath,
    loadBridge: () => req(bridgePath) as { __getSearchCalls: () => number },
  };
}

describe('rust embed adapter', () => {
  it('returns disabled status by default', () => {
    const out = getRustEmbedAdapterStatus({ RUST_CHAIN_ENABLED: 'false' } as NodeJS.ProcessEnv);
    expect(out.embedApiAvailable).toBe(false);
    expect(out.bridgeLoaded).toBe(false);
  });

  it('supports store/search roundtrip via bridge envelope', () => {
    const fixture = createBridgeFixture();

    const env = {
      RUST_CHAIN_ENABLED: 'true',
      RUST_CHAIN_BRIDGE_PATH: fixture.bridgePath,
    } as NodeJS.ProcessEnv;

    const status = getRustEmbedAdapterStatus(env);
    expect(status.embedApiAvailable).toBe(true);

    const reset = embedReset(env);
    expect(reset.cleared).toBe(true);

    const stored = embedStore('doc-1', 'deterministic local embedding', env);
    expect(stored.count).toBe(1);

    const out = embedSearch('deterministic', 3, env);
    expect(out.count).toBe(1);
    expect(out.hits[0]?.id).toBe('doc-1');
  });

  it('uses in-memory cache for repeated queries and records hit/miss metrics', () => {
    const fixture = createBridgeFixture();
    const env = {
      RUST_CHAIN_ENABLED: 'true',
      RUST_CHAIN_BRIDGE_PATH: fixture.bridgePath,
      EMBED_CACHE_SIZE: '10',
      EMBED_CACHE_TTL_SECONDS: '3600',
    } as NodeJS.ProcessEnv;

    clearEmbedSearchCache();
    embedStore('doc-1', 'cache me', env);

    const first = embedSearch('cache', 5, env);
    const second = embedSearch('cache', 5, env);

    expect(first.hits[0]?.id).toBe('doc-1');
    expect(second.hits[0]?.id).toBe('doc-1');
    expect(fixture.loadBridge().__getSearchCalls()).toBe(1);

    const snap = metrics.snapshot();
    expect(snap.embed.cacheMissesTotal).toBeGreaterThan(0);
    expect(snap.embed.cacheHitsTotal).toBeGreaterThan(0);
  });

  it('expires cache entries by TTL', async () => {
    const fixture = createBridgeFixture();
    const env = {
      RUST_CHAIN_ENABLED: 'true',
      RUST_CHAIN_BRIDGE_PATH: fixture.bridgePath,
      EMBED_CACHE_TTL_SECONDS: '1',
      EMBED_CACHE_SIZE: '10',
    } as NodeJS.ProcessEnv;

    clearEmbedSearchCache();
    embedStore('doc-1', 'ttl query', env);

    embedSearch('ttl', 5, env);
    await new Promise((resolve) => setTimeout(resolve, 1100));
    embedSearch('ttl', 5, env);

    expect(fixture.loadBridge().__getSearchCalls()).toBe(2);
  });

  it('enforces EMBED_CACHE_SIZE with LRU eviction', () => {
    const fixture = createBridgeFixture();
    const env = {
      RUST_CHAIN_ENABLED: 'true',
      RUST_CHAIN_BRIDGE_PATH: fixture.bridgePath,
      EMBED_CACHE_SIZE: '2',
      EMBED_CACHE_TTL_SECONDS: '3600',
    } as NodeJS.ProcessEnv;

    clearEmbedSearchCache();
    embedStore('doc-1', 'alpha', env);
    embedStore('doc-2', 'beta', env);
    embedStore('doc-3', 'gamma', env);

    embedSearch('alpha', 5, env);
    embedSearch('beta', 5, env);
    embedSearch('gamma', 5, env);

    // alpha should be evicted once gamma enters with size=2.
    embedSearch('alpha', 5, env);

    expect(fixture.loadBridge().__getSearchCalls()).toBe(4);
  });

  it('embedReset clears local cache', () => {
    const fixture = createBridgeFixture();
    const env = {
      RUST_CHAIN_ENABLED: 'true',
      RUST_CHAIN_BRIDGE_PATH: fixture.bridgePath,
      EMBED_CACHE_SIZE: '10',
      EMBED_CACHE_TTL_SECONDS: '3600',
    } as NodeJS.ProcessEnv;

    clearEmbedSearchCache();
    embedStore('doc-1', 'reset query', env);

    embedSearch('reset', 5, env);
    embedReset(env);
    embedSearch('reset', 5, env);

    expect(fixture.loadBridge().__getSearchCalls()).toBe(2);
  });
});
