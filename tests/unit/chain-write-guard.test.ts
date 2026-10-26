/**
 * Chain-write guard — regression for the 2026-10-24 journal pollution.
 *
 * The incident: `tests/unit/chain-integrity.test.ts` called the real
 * `appendBlock` with a rawEnv that carried `RUST_CHAIN_ENABLED: 'false'`
 * but no `MEMPHIS_DATA_DIR`. Path resolution therefore fell back to the
 * default `~/.memphis`, and every run of that suite appended fixture
 * blocks (`one`, `two`, `cli-check`) to the operator's LIVE journal
 * chain. 98 such blocks accumulated over 2026-10-16 → 2026-10-24.
 *
 * Three layers are tested here:
 *   1. The guard helper itself (`isUnderTempDir`, `assertChainWriteAllowed`).
 *   2. The guard refuses a VITEST write that resolves outside temp.
 *   3. The guard actually fires on the real `appendBlock` call path —
 *      this is the layer that would have caught the incident, so it is
 *      the one that matters most.
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { appendBlock } from '../../src/infra/storage/chain-adapter.js';
import {
  assertChainWriteAllowed,
  isUnderTempDir,
} from '../../src/infra/storage/chain-write-guard.js';

describe('chain-write-guard', () => {
  it('recognises paths inside the OS temp directory', () => {
    expect(isUnderTempDir(join(tmpdir(), 'memphis-guard', 'chains', 'journal'))).toBe(true);
    expect(isUnderTempDir(tmpdir())).toBe(true);
  });

  it('rejects paths outside the OS temp directory', () => {
    expect(isUnderTempDir('/home/memphis/.memphis/chains/journal')).toBe(false);
    expect(isUnderTempDir('/var/lib/memphis/chains/journal')).toBe(false);
  });

  it('never interferes outside VITEST', () => {
    expect(() =>
      assertChainWriteAllowed('/home/memphis/.memphis/chains/journal', {}),
    ).not.toThrow();
    expect(() =>
      assertChainWriteAllowed('/home/memphis/.memphis/chains/journal', {
        VITEST: 'false',
      }),
    ).not.toThrow();
  });

  it('refuses a VITEST write outside the temp directory', () => {
    expect(() =>
      assertChainWriteAllowed('/home/memphis/.memphis/chains/journal', {
        VITEST: 'true',
      }),
    ).toThrow(/chain-write-guard/);
  });

  it('allows a VITEST write inside the temp directory', () => {
    const target = mkdtempSync(join(tmpdir(), 'memphis-guard-ok-'));
    expect(() =>
      assertChainWriteAllowed(join(target, 'chains', 'journal'), { VITEST: 'true' }),
    ).not.toThrow();
  });

  it('honours the explicit opt-in escape hatch', () => {
    expect(() =>
      assertChainWriteAllowed('/home/memphis/.memphis/chains/journal', {
        VITEST: 'true',
        MEMPHIS_TEST_ALLOW_LIVE_CHAIN_WRITE: '1',
      }),
    ).not.toThrow();
  });

  it('fires on the real appendBlock path — the layer that caught the incident', async () => {
    // Reproduces the incident shape: a rawEnv that switches the chain
    // backend but forgets MEMPHIS_DATA_DIR, so the resolved path lands
    // outside temp. Use a synthetic home so isolation of the runner's HOME
    // does not change the path this regression exercises.
    const syntheticHome = '/var/lib/memphis-test-home';
    await expect(
      appendBlock(
        'journal',
        { type: 'journal', content: 'must-not-reach-the-live-chain' },
        { VITEST: 'true', RUST_CHAIN_ENABLED: 'false', HOME: syntheticHome },
      ),
    ).rejects.toThrow(/chain-write-guard/);
  });
});
