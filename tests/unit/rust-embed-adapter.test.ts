import { mkdtempSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  embedReset,
  embedSearch,
  embedStore,
  getRustEmbedAdapterStatus,
} from '../../src/infra/storage/rust-embed-adapter.js';

describe('rust embed adapter', () => {
  it('returns disabled status by default', () => {
    const out = getRustEmbedAdapterStatus({ RUST_CHAIN_ENABLED: 'false' } as NodeJS.ProcessEnv);
    expect(out.embedApiAvailable).toBe(false);
    expect(out.bridgeLoaded).toBe(false);
  });

  it('supports store/search roundtrip via bridge envelope', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mv4-embed-adapter-'));
    const bridgePath = join(dir, 'bridge.cjs');
    writeFileSync(
      bridgePath,
      `let rows = [];
module.exports = {
  embed_reset: () => JSON.stringify({ ok: true, data: { cleared: true } }),
  embed_store: (id, text) => {
    rows.push({ id, text });
    return JSON.stringify({ ok: true, data: { id, count: rows.length, dim: 32, provider: 'local-deterministic' } });
  },
  embed_search: (query) => {
    const hit = rows.find((r) => r.text.includes(query)) || rows[0];
    return JSON.stringify({ ok: true, data: { query, count: 1, hits: [{ id: hit.id, score: 0.9, text_preview: hit.text.slice(0, 20) }] } });
  }
};`,
      'utf8',
    );

    const env = {
      RUST_CHAIN_ENABLED: 'true',
      RUST_CHAIN_BRIDGE_PATH: bridgePath,
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

  it('uses cache for repeated searches within ttl', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mv4-embed-cache-'));
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
  embed_search: (query) => {
    searchCalls += 1;
    const hit = rows.find((r) => r.text.includes(query)) || rows[0];
    return JSON.stringify({ ok: true, data: { query, count: 1, hits: [{ id: hit.id, score: 0.9, text_preview: hit.text.slice(0, 20) }] } });
  },
  __search_calls: () => searchCalls,
};`,
      'utf8',
    );

    const env = {
      RUST_CHAIN_ENABLED: 'true',
      RUST_CHAIN_BRIDGE_PATH: bridgePath,
      EMBED_CACHE_TTL_SECONDS: '60',
    } as NodeJS.ProcessEnv;

    embedStore('doc-1', 'cache me', env);
    embedSearch('cache', 5, env);
    embedSearch('cache', 5, env);

    const req = createRequire(import.meta.url);
    const mod = req(bridgePath) as { __search_calls: () => number };
    expect(mod.__search_calls()).toBe(1);
  });
});
