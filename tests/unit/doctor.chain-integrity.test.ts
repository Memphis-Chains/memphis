import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { checkChainIntegrity } from '../../src/infra/cli/utils/doctor-v2.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function block(index: number, prevHash: string, hash: string) {
  return {
    index,
    timestamp: '2026-01-01T00:00:00.000Z',
    chain: 'journal',
    prev_hash: prevHash,
    hash,
    data: { type: 'journal', content: `entry ${index}` },
  };
}

describe('doctor chain integrity', () => {
  // A chain backup directory left by a rebuild-hashes run is a recovery
  // copy, not a live chain. Counting it made doctor report
  // "invalid=1" over a perfectly healthy set of chains.
  it('skips chain backup directories', () => {
    const root = mkdtempSync(join(tmpdir(), 'memphis-doctor-chains-'));
    roots.push(root);
    mkdirSync(join(root, 'journal'), { recursive: true });
    mkdirSync(join(root, 'journal.backup-1792986838124'), { recursive: true });
    const hash = 'a'.repeat(64);
    writeFileSync(
      join(root, 'journal', '000001.json'),
      JSON.stringify(block(1, '0'.repeat(64), hash)),
    );
    // A broken prev_hash link, as found in the backup directory on disk.
    writeFileSync(
      join(root, 'journal.backup-1792986838124', '000001.json'),
      JSON.stringify(block(1, 'b'.repeat(64), hash)),
    );

    const result = checkChainIntegrity(root);
    expect(result.invalid).toBe(0);
    expect(result.checked).toBe(1);
    expect(result.ok).toBe(true);
  });

  it('still reports a broken link inside a live chain', () => {
    const root = mkdtempSync(join(tmpdir(), 'memphis-doctor-chains-'));
    roots.push(root);
    mkdirSync(join(root, 'journal'), { recursive: true });
    const hash = 'a'.repeat(64);
    writeFileSync(
      join(root, 'journal', '000001.json'),
      JSON.stringify(block(1, '0'.repeat(64), hash)),
    );
    writeFileSync(
      join(root, 'journal', '000002.json'),
      JSON.stringify(block(2, 'c'.repeat(64), 'd'.repeat(64))),
    );

    const result = checkChainIntegrity(root);
    expect(result.invalid).toBe(1);
    expect(result.ok).toBe(false);
  });
});
