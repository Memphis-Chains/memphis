import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runCli } from '../../src/infra/cli/index.js';

async function runCliJson(argv: string[]): Promise<unknown> {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.map((v) => String(v)).join(' '));
  };

  try {
    await runCli(argv);
  } finally {
    console.log = original;
  }

  return JSON.parse(lines.join('\n'));
}

describe('CLI embed cache clear', () => {
  it('clears in-memory cache via `embed cache clear`', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mv4-embed-cli-'));
    const bridgePath = join(dir, 'mock-bridge.cjs');

    writeFileSync(
      bridgePath,
      `let searchCalls = 0;
module.exports = {
  embed_reset: () => JSON.stringify({ ok: true, data: { cleared: true } }),
  embed_store: (id, text) => JSON.stringify({ ok: true, data: { id, count: 1, dim: 32, provider: 'local' } }),
  embed_search: (query) => {
    searchCalls += 1;
    return JSON.stringify({ ok: true, data: { query, count: 1, hits: [{ id: 'doc-' + searchCalls, score: 0.9, text_preview: query }] } });
  }
};`,
      'utf8',
    );

    const prevRustEnabled = process.env.RUST_CHAIN_ENABLED;
    const prevBridgePath = process.env.RUST_CHAIN_BRIDGE_PATH;
    const prevCacheSize = process.env.EMBED_CACHE_SIZE;
    const prevCacheTtl = process.env.EMBED_CACHE_TTL_SECONDS;

    process.env.RUST_CHAIN_ENABLED = 'true';
    process.env.RUST_CHAIN_BRIDGE_PATH = bridgePath;
    process.env.EMBED_CACHE_SIZE = '10';
    process.env.EMBED_CACHE_TTL_SECONDS = '3600';

    try {
      const first = (await runCliJson(['node', 'memphis', 'embed', 'search', '--query', 'cache', '--json'])) as any;
      const second = (await runCliJson(['node', 'memphis', 'embed', 'search', '--query', 'cache', '--json'])) as any;
      const clear = (await runCliJson(['node', 'memphis', 'embed', 'cache', 'clear', '--json'])) as any;
      const third = (await runCliJson(['node', 'memphis', 'embed', 'search', '--query', 'cache', '--json'])) as any;

      expect(first.data.hits[0].id).toBe('doc-1');
      expect(second.data.hits[0].id).toBe('doc-1');
      expect(clear.data.cleared).toBe(true);
      expect(third.data.hits[0].id).toBe('doc-2');
    } finally {
      process.env.RUST_CHAIN_ENABLED = prevRustEnabled;
      process.env.RUST_CHAIN_BRIDGE_PATH = prevBridgePath;
      process.env.EMBED_CACHE_SIZE = prevCacheSize;
      process.env.EMBED_CACHE_TTL_SECONDS = prevCacheTtl;
    }
  });
});
