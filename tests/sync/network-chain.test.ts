import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NetworkChain } from '../../src/sync/network-chain.js';

describe('NetworkChain', () => {
  it('appends and reads sync ledger entries', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sync-ledger-'));
    const chain = new NetworkChain(join(dir, 'ledger.json'));

    chain.append({ action: 'ipfs.push', actor: 'system', cid: 'Qm123' });
    const entries = chain.read();

    expect(entries).toHaveLength(1);
    expect(entries[0]?.action).toBe('ipfs.push');
    expect(entries[0]?.cid).toBe('Qm123');
  });
});
