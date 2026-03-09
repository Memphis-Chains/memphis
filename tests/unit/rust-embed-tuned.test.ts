import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { embedSearchTuned, getRustEmbedAdapterStatus } from '../../src/infra/storage/rust-embed-adapter.js';

describe('rust embed tuned adapter', () => {
  it('uses tuned bridge function when available', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mv4-embed-tuned-'));
    const bridgePath = join(dir, 'bridge.cjs');
    writeFileSync(
      bridgePath,
      `module.exports = {
  embed_reset: () => JSON.stringify({ ok: true, data: { cleared: true } }),
  embed_store: () => JSON.stringify({ ok: true, data: { id: 'x', count: 1, dim: 32, provider: 'p' } }),
  embed_search: (query) => JSON.stringify({ ok: true, data: { query, count: 1, hits: [{ id: 'plain', score: 0.1, text_preview: '' }] } }),
  embed_search_tuned: (query) => JSON.stringify({ ok: true, data: { query, count: 1, hits: [{ id: 'tuned', score: 0.9, text_preview: '' }] } })
};`,
      'utf8',
    );

    const env = { RUST_CHAIN_ENABLED: 'true', RUST_CHAIN_BRIDGE_PATH: bridgePath } as NodeJS.ProcessEnv;
    const status = getRustEmbedAdapterStatus(env);
    expect(status.tunedSearchAvailable).toBe(true);

    const out = embedSearchTuned('hello', 1, env);
    expect(out.hits[0]?.id).toBe('tuned');
  });
});
