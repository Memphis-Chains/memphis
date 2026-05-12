/**
 * Known-fork registry — loader, parser, matcher.
 *
 * Replaces the substring `KNOWN_FORK_MARKERS.some()` matcher from PR
 * #603 with structured `{chain, block, prev_hash, expected_prev_hash}`
 * matching. The bootstrap catch site at `src/app/bootstrap.ts` calls
 * `parseChainIntegrityError()` → `loadKnownForks()` → `matchKnownFork()`
 * — this file covers all three.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  loadKnownForks,
  matchKnownFork,
  parseChainIntegrityError,
  type KnownFork,
} from '../../src/infra/runtime/known-forks.js';

describe('parseChainIntegrityError', () => {
  it('parses prev_hash mismatch (operator block-1853 shape)', () => {
    const message =
      `chain 'system' integrity check failed at block 1853 (001853.json): ` +
      `prev_hash 754a7c32…9d1b ≠ previous block's hash 4248ca68…cd62`;
    const parsed = parseChainIntegrityError(message);
    expect(parsed).toEqual({
      chain: 'system',
      block: 1853,
      file: '001853.json',
      kind: 'prev_hash_mismatch',
      storedPrevHash: '754a7c32…9d1b',
      expectedPrevHash: '4248ca68…cd62',
    });
  });

  it('parses stored hash mismatch', () => {
    const parsed = parseChainIntegrityError(
      `chain 'journal' integrity check failed at block 42 (000042.json): ` +
        `stored hash aaaa1111…bbbb ≠ computed cccc2222…dddd`,
    );
    expect(parsed).toMatchObject({
      chain: 'journal',
      block: 42,
      kind: 'stored_hash_mismatch',
      storedPrevHash: 'aaaa1111…bbbb',
      expectedPrevHash: 'cccc2222…dddd',
    });
  });

  it('parses non-sequential index', () => {
    const parsed = parseChainIntegrityError(
      `chain 'case' integrity check failed at block 99 (000099.json): ` +
        `non-sequential index after block 50`,
    );
    expect(parsed).toMatchObject({ chain: 'case', block: 99, kind: 'non_sequential' });
  });

  it('parses genesis prev_hash mismatch', () => {
    const parsed = parseChainIntegrityError(
      `chain 'system' integrity check failed at genesis block 0 (000000.json): ` +
        `prev_hash abc123…0000 ≠ expected GENESIS_PREV_HASH`,
    );
    expect(parsed).toMatchObject({
      chain: 'system',
      block: 0,
      kind: 'genesis_prev_hash',
      storedPrevHash: 'abc123…0000',
    });
  });

  it('returns null for unrelated errors', () => {
    expect(parseChainIntegrityError('totally unrelated error')).toBeNull();
    expect(parseChainIntegrityError('chain integrity check')).toBeNull();
  });
});

describe('matchKnownFork', () => {
  const fork: KnownFork = {
    chain: 'system',
    block: 1853,
    storedPrevHash: '754a7c32',
    expectedPrevHash: '4248ca68',
    reason: 'test fork',
    acceptedAt: '2026-05-12T00:00:00Z',
  };

  it('matches on chain + block + both hash substrings', () => {
    const parsed = {
      chain: 'system' as const,
      block: 1853,
      kind: 'prev_hash_mismatch' as const,
      storedPrevHash: '754a7c32…9d1b',
      expectedPrevHash: '4248ca68…cd62',
    };
    expect(matchKnownFork(parsed, [fork])).toEqual(fork);
  });

  it('rejects wrong chain', () => {
    const parsed = {
      chain: 'journal' as const,
      block: 1853,
      kind: 'prev_hash_mismatch' as const,
      storedPrevHash: '754a7c32…9d1b',
      expectedPrevHash: '4248ca68…cd62',
    };
    expect(matchKnownFork(parsed, [fork])).toBeNull();
  });

  it('rejects wrong block', () => {
    const parsed = {
      chain: 'system' as const,
      block: 1854,
      kind: 'prev_hash_mismatch' as const,
      storedPrevHash: '754a7c32…9d1b',
      expectedPrevHash: '4248ca68…cd62',
    };
    expect(matchKnownFork(parsed, [fork])).toBeNull();
  });

  it('rejects wrong storedPrevHash', () => {
    // This is the regression the PR #603 critique called out: matching
    // on block number alone is too loose — any new corruption at block
    // 1853 would inherit the same tolerance. The structured matcher
    // rejects a different stored hash.
    const parsed = {
      chain: 'system' as const,
      block: 1853,
      kind: 'prev_hash_mismatch' as const,
      storedPrevHash: 'ffffffff…0000',
      expectedPrevHash: '4248ca68…cd62',
    };
    expect(matchKnownFork(parsed, [fork])).toBeNull();
  });

  it('matches when fork omits hash fields (chain+block only)', () => {
    const looseFork: KnownFork = {
      chain: 'system',
      block: 1853,
      reason: 'loose match',
      acceptedAt: '2026-05-12T00:00:00Z',
    };
    const parsed = {
      chain: 'system' as const,
      block: 1853,
      kind: 'prev_hash_mismatch' as const,
      storedPrevHash: 'anything',
      expectedPrevHash: 'else',
    };
    expect(matchKnownFork(parsed, [looseFork])).toEqual(looseFork);
  });

  it('returns null on empty fork list', () => {
    const parsed = {
      chain: 'system' as const,
      block: 1853,
      kind: 'prev_hash_mismatch' as const,
    };
    expect(matchKnownFork(parsed, [])).toBeNull();
  });
});

describe('loadKnownForks', () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'memphis-known-forks-'));
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('returns the baseline block-1853 fork when no config is present', () => {
    const forks = loadKnownForks({ MEMPHIS_DATA_DIR: dataDir });
    expect(forks).toHaveLength(1);
    expect(forks[0]).toMatchObject({ chain: 'system', block: 1853 });
  });

  it('reads known-forks.json when present', () => {
    writeFileSync(
      join(dataDir, 'known-forks.json'),
      JSON.stringify([
        {
          chain: 'system',
          block: 9999,
          reason: 'fixture',
          acceptedAt: '2026-01-01T00:00:00Z',
        },
      ]),
    );
    const forks = loadKnownForks({ MEMPHIS_DATA_DIR: dataDir });
    expect(forks).toHaveLength(1);
    expect(forks[0]).toMatchObject({ chain: 'system', block: 9999, reason: 'fixture' });
  });

  it('honours empty known-forks.json as "no forks accepted"', () => {
    // Operator who explicitly clears the fork list opts OUT of the
    // baseline. The empty file is the canonical way to do that
    // without setting an env var.
    writeFileSync(join(dataDir, 'known-forks.json'), '[]');
    const forks = loadKnownForks({ MEMPHIS_DATA_DIR: dataDir });
    expect(forks).toEqual([]);
  });

  it('reads MEMPHIS_KNOWN_FORK_MARKERS env var when no file present', () => {
    const env: NodeJS.ProcessEnv = {
      MEMPHIS_DATA_DIR: dataDir,
      MEMPHIS_KNOWN_FORK_MARKERS: JSON.stringify([
        {
          chain: 'journal',
          block: 7,
          reason: 'env fixture',
          acceptedAt: '2026-01-01T00:00:00Z',
        },
      ]),
    };
    const forks = loadKnownForks(env);
    expect(forks).toHaveLength(1);
    expect(forks[0]).toMatchObject({ chain: 'journal', block: 7 });
  });

  it('file takes precedence over env var', () => {
    writeFileSync(
      join(dataDir, 'known-forks.json'),
      JSON.stringify([
        {
          chain: 'system',
          block: 1,
          reason: 'file wins',
          acceptedAt: '2026-01-01T00:00:00Z',
        },
      ]),
    );
    const env: NodeJS.ProcessEnv = {
      MEMPHIS_DATA_DIR: dataDir,
      MEMPHIS_KNOWN_FORK_MARKERS: JSON.stringify([
        {
          chain: 'journal',
          block: 99,
          reason: 'env loses',
          acceptedAt: '2026-01-01T00:00:00Z',
        },
      ]),
    };
    const forks = loadKnownForks(env);
    expect(forks).toHaveLength(1);
    expect(forks[0].reason).toBe('file wins');
  });

  it('throws on malformed entries (missing required fields)', () => {
    writeFileSync(
      join(dataDir, 'known-forks.json'),
      JSON.stringify([{ chain: 'system' }]), // missing block + reason + acceptedAt
    );
    expect(() => loadKnownForks({ MEMPHIS_DATA_DIR: dataDir })).toThrow(/block must be/);
  });
});
