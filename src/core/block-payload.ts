/**
 * The one TypeScript implementation of a block's PAYLOAD rule.
 *
 * ## What the rule is
 *
 * A block's `data` is a free-form payload. The chain contract does not
 * let it stay free-form: three fields are given a defined meaning, and
 * they are the three fields the HASH covers.
 *
 * - `type` — what kind of block this is. `data.type`, else the legacy
 *   `data.block_type`, else `journal`.
 * - `content` — the block's text. `data.content` when it is a string,
 *   else the canonical JSON of the whole payload.
 * - `tags` — `data.tags`, keeping only the strings.
 *
 * The native core has the same rule
 * (`crates/memphis-core/src/hash.rs::to_canonical_hash_data`), and the
 * two have to agree byte for byte: the hash of a block is computed
 * over this projection, so a payload the two arms project differently is
 * a payload the two arms hash differently.
 *
 * ## Why it used to live in three places
 *
 * The TypeScript side carried the rule three times:
 *
 * | where                                     | what it did wrong            |
 * | ----------------------------------------- | ---------------------------- |
 * | `core/chain-hash.ts`                      | the projection only          |
 * | `infra/storage/chain-adapter.ts`         | no `block_type` fallback     |
 * | `infra/storage/rust-chain-adapter.ts`     | no `block_type` fallback     |
 *
 * The two storage copies filled `content` with `JSON.stringify(data)`,
 * which keeps the payload's key order. The native core fills it with
 * `data.to_string()`, which sorts the keys. For a payload whose keys
 * were not already sorted, the two arms produced DIFFERENT content and
 * therefore DIFFERENT hashes for the same logical block.
 *
 * Measured 2026-11-23 on this host: 0 of 27 433 blocks on disk (14
 * live chains plus two rotation archives) carry a payload without a
 * string `content`, so the branch was never taken here. It was still
 * two rules for one thing, and the branch is the one place where the
 * two arms would have disagreed.
 *
 * The `block_type` fallback was the same story: the native core falls
 * back `type` -> `block_type` -> `journal`, and the two storage copies
 * fell back `type` -> `journal`, so a payload carrying only
 * `block_type` was written as a journal entry on this side and hashed
 * as its own type on the other. Measured on this host: 0 of 27 433
 * blocks carry `block_type` without `type`.
 *
 * ## The two consumers
 *
 * - `toCanonicalHashData` — the three-field PROJECTION the hash covers.
 * - `normalizeBlockPayload` — the payload as it is STORED: the same
 *   three fields plus everything else the payload carried.
 *
 * They cannot disagree, because they read the same three functions.
 */

import { canonicalStringify } from './canonical-json.js';

/** The payload fields the chain contract gives a meaning to. */
export const CANONICAL_PAYLOAD_FIELDS = ['type', 'content', 'tags'] as const;

/**
 * The block's type.
 *
 * `type`, then the legacy `block_type`, then `journal` — the same
 * order the native core uses (`crates/memphis-core/src/hash.rs`).
 */
export function canonicalType(data: Record<string, unknown>): string {
  if (typeof data.type === 'string') return data.type;
  if (typeof data.block_type === 'string') return data.block_type;
  return 'journal';
}

/**
 * The block's content.
 *
 * The payload's own `content` when it is a string, else the canonical
 * JSON of the whole payload.
 *
 * The canonical JSON is what the native core produces with
 * `data.to_string()`: compact, keys sorted by byte. It is the same
 * function on both sides now, so a payload without a string `content`
 * hashes the same in both arms.
 */
export function canonicalContent(data: Record<string, unknown>): string {
  if (typeof data.content === 'string') return data.content;
  return canonicalStringify(data);
}

/**
 * The block's tags: the payload's `tags`, keeping only the strings.
 */
export function canonicalTags(data: Record<string, unknown>): string[] {
  return Array.isArray(data.tags)
    ? data.tags.filter((value): value is string => typeof value === 'string')
    : [];
}

/**
 * The payload as it is stored on disk.
 *
 * The three canonical fields, plus everything else the payload carried.
 * The key order does not matter — the block file is written in the
 * canonical form (`core/canonical-json.ts`), which sorts.
 */
export function normalizeBlockPayload(data: Record<string, unknown>): Record<string, unknown> {
  const passthrough = Object.fromEntries(
    Object.entries(data).filter(([key]) => !CANONICAL_PAYLOAD_FIELDS.includes(key as never)),
  );

  return {
    ...passthrough,
    type: canonicalType(data),
    content: canonicalContent(data),
    tags: canonicalTags(data),
  };
}
