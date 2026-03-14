import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { NapiChainAdapter } from '../../src/infra/storage/rust-chain-adapter.js';

describe('rust chain adapter', () => {
  it('uses canonical payload hashing compatible with memphis-core', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'mv5-rust-chain-home-'));
    const dir = mkdtempSync(join(tmpdir(), 'mv5-rust-chain-bridge-'));
    const bridgePath = join(dir, 'bridge.cjs');
    const previousDataDir = process.env.MEMPHIS_DATA_DIR;
    process.env.MEMPHIS_DATA_DIR = dataDir;
    writeFileSync(
      bridgePath,
      `const crypto = require('node:crypto');
module.exports = {
  chain_append: (_chainJson, blockJson) => {
    const block = JSON.parse(blockJson);
    const payload = JSON.stringify({
      index: block.index,
      timestamp: block.timestamp,
      chain: block.chain,
      data: block.data,
      prev_hash: block.prev_hash
    });
    const expected = crypto.createHash('sha256').update(payload).digest('hex');
    if (block.hash !== expected) {
      return JSON.stringify({
        ok: true,
        data: {
          appended: false,
          length: 0,
          chain: [],
          errors: ['hash mismatch']
        }
      });
    }
    return JSON.stringify({
      ok: true,
      data: {
        appended: true,
        length: 1,
        chain: [block]
      }
    });
  },
  chain_validate: () => JSON.stringify({ ok: true, data: { valid: true } }),
  chain_query: () => JSON.stringify({ ok: true, data: { count: 0, blocks: [] } })
};`,
      'utf8',
    );

    try {
      const adapter = new NapiChainAdapter({
        ...process.env,
        MEMPHIS_DATA_DIR: dataDir,
        RUST_CHAIN_ENABLED: 'true',
        RUST_CHAIN_BRIDGE_PATH: bridgePath,
      });

      const out = await adapter.appendBlock('journal', { type: 'journal', content: 'hello hash' });
      expect(out.index).toBe(1);
      expect(out.chain).toBe('journal');
      expect(typeof out.hash).toBe('string');
      expect(out.hash).toHaveLength(64);
    } finally {
      if (previousDataDir === undefined) {
        delete process.env.MEMPHIS_DATA_DIR;
      } else {
        process.env.MEMPHIS_DATA_DIR = previousDataDir;
      }
    }
  });
});
