import { mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { rebuildChainIndexes } from '../../src/core/chain-index-rebuild.js';

describe('chain index rebuild', () => {
  it('rebuilds index and tolerates corrupted source files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mv4-chain-index-'));
    writeFileSync(join(dir, 'ok.json'), JSON.stringify({ blocks: [{ index: 0, hash: 'h0', prev_hash: '0'.repeat(64) }] }));
    writeFileSync(join(dir, 'bad.json'), '{not-json');

    const out = rebuildChainIndexes({ dataDir: dir });
    expect(out.ok).toBe(true);
    expect(out.sourcesScanned).toBe(2);
    expect(out.corruptedSources.length).toBe(1);
    expect(out.entries).toBe(1);
    expect(existsSync(out.indexPath)).toBe(true);
  });
});
