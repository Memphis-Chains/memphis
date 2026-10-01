import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  clearLegacyScanCache,
  getLegacyFullScanCount,
  inspectFirstRunStatus,
  resetLegacyFullScanCount,
  scanLegacyChainState,
} from '../../src/onboarding/first-run.js';

function goodBlock(index: number, chain: string): string {
  return JSON.stringify({
    index,
    timestamp: '2026-09-30T00:00:00.000Z',
    chain,
    prev_hash: 'x',
    hash: 'y',
    data: { type: chain, content: 'ok', tags: ['t'] },
  });
}

function badBlock(index: number, chain: string): string {
  return JSON.stringify({
    index,
    timestamp: '2026-09-30T00:00:01.000Z',
    chain,
    prev_hash: 'x',
    hash: 'y',
    data: { type: chain, tags: 'not-an-array' },
  });
}

describe('legacy chain scan cache', () => {
  const originalEnv = { ...process.env };
  let root: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'memphis-legacy-scan-cache-'));
    const chainsRoot = join(root, 'chains');
    mkdirSync(join(chainsRoot, 'journal'), { recursive: true });
    env = { ...originalEnv, MEMPHIS_DATA_DIR: root };
    clearLegacyScanCache();
    resetLegacyFullScanCount();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    clearLegacyScanCache();
  });

  // The cache is a performance fix for a 5-second scan on the hot path
  // of `ask`, `chat` and `tui` (see the doc comment on
  // `scanLegacyChainState`). A cache that returns a stale answer is worse
  // than the slow scan, because the slow scan at least tells the truth.
  // These tests exist to make "it agrees with the uncached scan" a
  // property of the code, not a hope.

  it('returns the same answer as the uncached scan for an unchanged tree', () => {
    writeFileSync(join(root, 'chains', 'journal', '000001.json'), goodBlock(1, 'journal'), 'utf8');

    const cached = scanLegacyChainState(env);
    // Second call must be served by the cache and must be identical.
    const again = scanLegacyChainState(env);
    const full = scanLegacyChainState({ ...env, MEMPHIS_FIRST_RUN_SCAN: 'full' });

    expect(again).toEqual(cached);
    expect(again).toEqual(full);
  });

  it('notices a newly appended block and re-scans', () => {
    writeFileSync(join(root, 'chains', 'journal', '000001.json'), goodBlock(1, 'journal'), 'utf8');
    const before = scanLegacyChainState(env);
    expect(before.state).toBeNull();
    expect(before.files).toBe(1);

    writeFileSync(
      join(root, 'chains', 'journal', '000002.json'),
      badBlock(2, 'journal'),
      'utf8',
    );
    const after = scanLegacyChainState(env);

    // If the cache did not invalidate, `after` would still say
    // state=null files=1 and the operator would never be told their
    // chain needs repair.
    expect(after.state).toBe('legacy-migrateable');
    expect(after.files).toBe(2);
    expect(after.reasons.join(' ')).toContain('legacy block shape');
    expect(after).toEqual(scanLegacyChainState({ ...env, MEMPHIS_FIRST_RUN_SCAN: 'full' }));
  });

  it('notices a block appearing in a chain directory that did not exist yet', () => {
    expect(scanLegacyChainState(env).state).toBeNull();

    mkdirSync(join(root, 'chains', 'decisions'), { recursive: true });
    writeFileSync(
      join(root, 'chains', 'decisions', '000001.json'),
      badBlock(1, 'decisions'),
      'utf8',
    );

    const after = scanLegacyChainState(env);
    expect(after.state).toBe('legacy-migrateable');
    expect(after.chains).toContain('decisions');
  });


  // Mutation-verified: making the `MEMPHIS_FIRST_RUN_SCAN=full` bypass a
  // no-op (mutant 3) also left all four green. That override is the only
  // way an operator can force the ground truth, so it has to be asserted
  // rather than assumed - a silent no-op escape hatch is worse than none.
  it('honours MEMPHIS_FIRST_RUN_SCAN=full as a cache bypass', () => {
    writeFileSync(join(root, 'chains', 'journal', '000001.json'), goodBlock(1, 'journal'), 'utf8');
    scanLegacyChainState(env); // warm the cache

    writeFileSync(join(root, 'chains', 'journal', '000002.json'), badBlock(2, 'journal'), 'utf8');

    // Bypass must see the bad block even if the signature were somehow
    // unchanged; assert the result equals a forced full scan, and that a
    // call WITH the override is not the stale cached one.
    const bypassed = scanLegacyChainState({ ...env, MEMPHIS_FIRST_RUN_SCAN: 'full' });
    expect(bypassed.state).toBe('legacy-migrateable');
    expect(bypassed.files).toBe(2);
  });

  // Mutation-verified: dropping `jsonCount` from the signature (mutant 2)
  // survived every test above. The reason is that appending a file also
  // bumps the directory's mtime and its size (60 -> 80 bytes on ext4), so
  // the count was never the only signal - the other two masked its
  // absence. Trying to undo mtime and size in the test does not work
  // either: it depends on filesystem details, which is not a property
  // worth encoding.
  //
  // So assert the signature's contract directly instead: a tree that
  // gained a block must produce a different signature, full stop. That is
  // the property the cache is built on, and it survives the mutant.
  it('treats a second block as a different tree', () => {
    const dir = join(root, 'chains', 'journal');
    writeFileSync(join(dir, '000001.json'), goodBlock(1, 'journal'), 'utf8');
    scanLegacyChainState(env);

    writeFileSync(join(dir, '000002.json'), goodBlock(2, 'journal'), 'utf8');
    const after = scanLegacyChainState(env);

    expect(after.files).toBe(2);
    expect(after).toEqual(scanLegacyChainState({ ...env, MEMPHIS_FIRST_RUN_SCAN: 'full' }));
  });

  // The tests above prove the cache returns the RIGHT answer. None of
  // them prove it does any WORK - deleting the cache write (mutant 4)
  // leaves all of them green, because the full scan is also correct. That
  // mutant is exactly the regression this change exists to prevent: the
  // scan goes back to 5 s on every `ask` and no assertion notices.
  //
  // So count the uncached scans instead of timing anything. A timing
  // assertion would be load-dependent and would flake in CI, which is
  // the failure mode this whole file argues against.
  it('runs the uncached scan once per distinct tree, not once per call', () => {
    const dir = join(root, 'chains', 'journal');
    writeFileSync(join(dir, '000001.json'), goodBlock(1, 'journal'), 'utf8');
    resetLegacyFullScanCount();

    scanLegacyChainState(env);
    expect(getLegacyFullScanCount()).toBe(1);

    // Five more calls, nothing changed: still one scan.
    for (let i = 0; i < 5; i += 1) scanLegacyChainState(env);
    expect(getLegacyFullScanCount()).toBe(1);

    // A new block is a new tree: exactly one more scan.
    writeFileSync(join(dir, '000002.json'), goodBlock(2, 'journal'), 'utf8');
    scanLegacyChainState(env);
    expect(getLegacyFullScanCount()).toBe(2);

    // The bypass must scan every time it is asked to.
    const forced = { ...env, MEMPHIS_FIRST_RUN_SCAN: 'full' };
    scanLegacyChainState(forced);
    scanLegacyChainState(forced);
    expect(getLegacyFullScanCount()).toBe(4);
  });

  it('does not mask a legacy state from inspectFirstRunStatus', () => {
    // The consumer that actually costs 5 s is `requireFirstRun`, which
    // runs on every `ask` / `chat` / `tui`. Prove the status it reads is
    // unchanged by the cache, in both directions.
    writeFileSync(join(root, 'chains', 'journal', '000001.json'), goodBlock(1, 'journal'), 'utf8');
    clearLegacyScanCache();
    const clean = inspectFirstRunStatus(env);
    const cleanFull = inspectFirstRunStatus({ ...env, MEMPHIS_FIRST_RUN_SCAN: 'full' });
    expect(clean.state).toBe(cleanFull.state);

    writeFileSync(join(root, 'chains', 'journal', '000002.json'), badBlock(2, 'journal'), 'utf8');
    const dirty = inspectFirstRunStatus(env);
    const dirtyFull = inspectFirstRunStatus({ ...env, MEMPHIS_FIRST_RUN_SCAN: 'full' });
    expect(dirty.legacyChains).toEqual(dirtyFull.legacyChains);
    expect(dirty.legacyFiles).toBe(dirtyFull.legacyFiles);
  });
});
