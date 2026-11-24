import * as nodeCrypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { canonicalHash, toCanonicalHashData } from '../../src/core/chain-hash.js';
import { hashBlock } from '../../src/infra/storage/chain-adapter.js';

interface ParityFixture {
  $comment?: string;
  blocks: Array<{
    index: number;
    timestamp: string;
    chain: string;
    data: Record<string, unknown>;
    prev_hash: string;
    hash: string;
  }>;
}

const fixture: ParityFixture = JSON.parse(
  readFileSync(join(process.cwd(), 'tests', 'fixtures', 'chain-hash-parity.json'), 'utf8'),
) as ParityFixture;

/**
 * The parity gate between the TypeScript block hash and the Rust core.
 *
 * ## Why this file exists
 *
 * The block hash had THREE TypeScript implementations — the write path in
 * `chain-adapter.ts`, the N-API write path in `rust-chain-adapter.ts` and
 * the repair path in `chain-canonical.ts` — and ONE Rust implementation in
 * `crates/memphis-core/src/hash.rs`. Nothing compared them.
 *
 * The copies did not even agree with each other: `chain-adapter.ts` fell
 * back `type` -> `journal` while `chain-canonical.ts` fell back
 * `type` -> `block_type` -> `journal`, exactly like the native core. A
 * block carrying only `block_type` was therefore hashed two different ways
 * by two writers of the same chain, and the repair path and the write path
 * could disagree about a block they were both responsible for.
 *
 * Measured on the operator's host: 0 of 27 159 blocks on disk carry
 * `block_type` without `type`, so the disagreement never bit. It was still
 * a second rule for one thing.
 *
 * ## What the gate does
 *
 * The fixture's hashes were produced by the Rust core and are checked by
 * `crates/memphis-core/tests/chain_hash_parity.rs`. This file checks the
 * TypeScript side against the SAME fixture. If the two implementations ever
 * diverge, one of the two tests fails — which is the whole point: the
 * copies are gone, and what is left is measured against the owner.
 */
describe('the TypeScript block hash agrees with the Rust core', () => {
  it('computes the hash the core computed, for every fixture block', () => {
    expect(fixture.blocks.length).toBeGreaterThan(0);

    for (const block of fixture.blocks) {
      const { hash, ...withoutHash } = block;
      expect(canonicalHash(withoutHash), `block ${block.index}`).toBe(hash);
    }
  });

  it('computes the same hash through the storage adapter', () => {
    // `hashBlock` is the entry point the write path uses. It used to carry
    // its own copy of the canonical shape; now it delegates. This test
    // fails if anyone reintroduces a second copy.
    for (const block of fixture.blocks) {
      const { hash, ...withoutHash } = block;
      expect(hashBlock(withoutHash, nodeCrypto), `block ${block.index}`).toBe(hash);
    }
  });

  it('ignores the fields of data that the hash does not cover', () => {
    const base = fixture.blocks[0]!;
    const { hash, ...withoutHash } = base;
    const withExtraField = {
      ...withoutHash,
      data: { ...withoutHash.data, a_field_the_hash_does_not_cover: 'ignored' },
    };

    expect(canonicalHash(withExtraField)).toBe(hash);
  });

  it('falls back to block_type, exactly like the native core', () => {
    // The native core's `to_canonical_hash_data` reads `type`, then
    // `block_type`, then `journal` (`crates/memphis-core/src/hash.rs:46`).
    // The TypeScript copy in `chain-adapter.ts` skipped `block_type` and
    // hashed such a block as a journal entry, so the two implementations
    // disagreed about the same bytes.
    const projected = toCanonicalHashData({
      block_type: 'reflection',
      content: 'a block that carries the legacy type alias',
      tags: [],
    });

    expect(projected).toEqual({
      type: 'reflection',
      content: 'a block that carries the legacy type alias',
      tags: [],
    });
  });

  it('falls back to journal when the block carries no type at all', () => {
    const projected = toCanonicalHashData({ content: 'typeless', tags: [] });
    expect(projected.type).toBe('journal');
  });
});
