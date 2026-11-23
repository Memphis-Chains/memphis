/**
 * The one TypeScript implementation of the chain block hash.
 *
 * ## Why this module exists
 *
 * The canonical hash of a chain block used to have THREE TypeScript
 * implementations and one Rust implementation:
 *
 * | where                      | what it did                                    |
 * | -------------------------- | ---------------------------------------------- |
 * | `infra/storage/chain-adapter.ts` | the write path — hashed and verified blocks |
 * | `infra/storage/rust-chain-adapter.ts` | the N-API write path — hashed blocks again |
 * | `infra/runtime/chain-canonical.ts`   | the repair path — hashed blocks a third time |
 * | `crates/memphis-core/src/hash.rs`    | the Rust core — the canonical one           |
 *
 * The two storage copies did not agree with the runtime copy about the
 * fallback type: `chain-canonical.ts` falls back `type` -> `block_type` ->
 * `journal`, exactly like the Rust core (`crates/memphis-core/src/hash.rs:46`),
 * while `chain-adapter.ts` fell back `type` -> `journal` and silently hashed
 * a `block_type`-only block as a journal entry.
 *
 * Two copies of one rule is the failure mode this repository keeps
 * repeating, so the copies are gone. What is left is ONE TypeScript
 * implementation and ONE Rust implementation, and a gate that compares them
 * (`tests/integration/chain-hash-parity.test.ts`).
 *
 * ## Why the type lives in `core/`, not in `infra/storage/`
 *
 * `infra/runtime/chain-canonical.ts` imports `infra/storage/block-vocabulary.ts`,
 * which imports `infra/storage/rust-chain-adapter.ts`. If the storage
 * modules imported the hash from there, the import graph would close into a
 * cycle. This module therefore depends on nothing but `node:crypto` and
 * `core/stable-stringify.ts`, and everybody imports it from here.
 *
 * ## The rule itself
 *
 * The hash covers exactly three fields of `data` — `type`, `content` and
 * `tags`. Every other field of `data` is persisted but NOT protected by the
 * hash. The payload is serialised with sorted keys so the digest does not
 * depend on property order, and the Rust core does the same through
 * `serde_json`'s ordered map.
 *
 * The sorted-key form is `core/canonical-json.ts` — byte order, not
 * `localeCompare`, because the native core sorts by byte. See that module
 * for the measurement of what the two orders cost when they disagree.
 *
 * The three fields themselves are read by `core/block-payload.ts`, which is
 * the one owner of the payload rule. This module does not carry a second
 * copy of it.
 */

import * as nodeCrypto from 'node:crypto';

import { canonicalContent, canonicalTags, canonicalType } from './block-payload.js';
import { canonicalStringify } from './canonical-json.js';

/** The three fields of a block's `data` that the hash covers. */
export interface CanonicalHashData {
  type: string;
  content: string;
  tags: string[];
}

/** A block as it is hashed: everything but its own hash. */
export interface HashableBlock {
  index: number;
  timestamp: string;
  chain: string;
  data: Record<string, unknown>;
  prev_hash: string;
}

/**
 * Reduce a block's `data` payload to the canonical three-field form.
 *
 * The three fields are read by `core/block-payload.ts`, which is the one
 * owner of the payload rule. The fallback order mirrors the native core
 * exactly (`crates/memphis-core/src/hash.rs`): `type`, then `block_type`,
 * then `journal`.
 *
 * The TypeScript side used to skip `block_type` — a block carrying only
 * `block_type` was hashed as `journal` here and as its own type there, so
 * the two implementations disagreed about the same bytes. Measured on this
 * host: 0 of 27 433 blocks on disk carry `block_type` without `type`, so
 * the disagreement never bit. It was still a second vocabulary, and the
 * core is the oracle.
 */
export function toCanonicalHashData(data: Record<string, unknown>): CanonicalHashData {
  return {
    type: canonicalType(data),
    content: canonicalContent(data),
    tags: canonicalTags(data),
  };
}

/**
 * The canonical hash of a block that carries no `hash` yet.
 *
 * @param block the block without its own hash.
 * @param crypto the crypto implementation; injectable so a caller can
 *   substitute one. Defaults to `node:crypto`.
 */
export function canonicalHash(
  block: HashableBlock,
  crypto: typeof nodeCrypto = nodeCrypto,
): string {
  const canonical = canonicalStringify({
    ...block,
    data: toCanonicalHashData(block.data),
  });
  return crypto.createHash('sha256').update(canonical).digest('hex');
}
