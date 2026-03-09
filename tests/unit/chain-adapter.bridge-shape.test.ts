import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getChainAdapterStatus } from '../../src/infra/storage/chain-adapter.js';

describe('chain adapter bridge shape', () => {
  it('falls back to ts-legacy when loaded bridge misses required exports', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mv4-bridge-shape-'));
    const bridgePath = join(dir, 'partial-bridge.cjs');
    writeFileSync(
      bridgePath,
      "module.exports = { chain_append: () => '{}' };\n",
      'utf8',
    );

    const out = getChainAdapterStatus({
      RUST_CHAIN_ENABLED: 'true',
      RUST_CHAIN_BRIDGE_PATH: bridgePath,
    } as NodeJS.ProcessEnv);

    expect(out.backend).toBe('ts-legacy');
    expect(out.rustEnabled).toBe(true);
    expect(out.rustBridgeLoaded).toBe(false);
  });
});
