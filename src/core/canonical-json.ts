/**
 * The canonical JSON form — one shape, one owner, both arms.
 *
 * ## Why this module exists
 *
 * A chain block is written to disk by TWO writers: the TypeScript write
 * path (`infra/storage/chain-adapter.ts` and its siblings) and the Rust
 * data plane (`crates/memphis-operator/src/chat_memory.rs`). They write
 * the same logical block and they wrote DIFFERENT BYTES.
 *
 * Measured 2026-11-23 on this host, over every block file in
 * `~/.memphis/chains` (11 864 files, 14 chains, plus 15 568 blocks in
 * the rotation archives):
 *
 *     6 248  chain,data,hash,index,prev_hash,timestamp   <- Rust (BTreeMap)
 *     5 606  index,timestamp,chain,data,prev_hash,hash    <- TypeScript
 *         5  chain,index,timestamp,prev_hash,data,hash    <- legacy
 *         2  chain,index,prev_hash,timestamp,data,hash    <- legacy
 *         1  (compact, no indentation at all)             <- legacy
 *
 * `chain verify` cannot see any of this: the hash covers a block's
 * VALUES, not its bytes. Two files that differ in key order verify
 * identically. So the divergence was invisible to every gate and
 * visible only in the bytes.
 *
 * The Rust side gets its order from `serde_json`: without the
 * `preserve_order` feature, `serde_json::Map` is a `BTreeMap`, so
 * every object it writes comes out with its keys sorted by BYTE.
 * The TypeScript side got its order from wherever the object literal
 * happened to put the fields.
 *
 * This module is the TypeScript end of that contract: JSON with object
 * keys sorted by byte order.
 *
 * ## Why byte order and not `localeCompare`
 *
 * `core/stable-stringify.ts` sorts with `localeCompare`, which is
 * locale-aware and puts `apple` before `Zebra`. The Rust core sorts by
 * byte, which puts `Zebra` before `apple`. The two orders disagree for
 * any key set that mixes cases — and a hash built on the disagreeing
 * order is a hash the other arm cannot reproduce.
 *
 * `localeCompare` is not used here, and `stableStringify` is not used
 * for anything that has to match the Rust core. What is used for that
 * is `canonicalStringify`, below.
 *
 * The comparison is by CODE POINT, not by UTF-16 code unit: the two
 * differ for astral characters (`U+10000` sorts before `U+FFFD` in
 * UTF-16, after it by code point), and UTF-8 byte order — which is what
 * the Rust core uses — follows code point order.
 *
 * ## The two forms
 *
 * - `canonicalStringify` — compact, one line. This is the form a HASH
 *   is computed over, and the form the Rust core produces with
 *   `serde_json::to_string`.
 * - `canonicalStringifyPretty` — two-space indent. This is the form a
 *   BLOCK FILE is written in, and the form the Rust core produces with
 *   `serde_json::to_vec_pretty`.
 *
 * ## The one caveat: numbers
 *
 * `JSON.stringify` and `serde_json` do not print the same number the
 * same way. `JSON.stringify(1)` is `1`; `serde_json` prints an f64
 * `1.0` as `1.0`. `JSON.stringify(1e21)` is `1e+21`; `serde_json`
 * prints `1e21`.
 *
 * This matters only where a payload's own JSON text is hashed — the
 * `content` fallback of a payload that carries no string `content`.
 * Measured on this host: 0 of 27 433 blocks carry a payload without a
 * string `content`, so the branch has never been taken here.
 *
 * It is also unreachable from the TypeScript side in practice: the
 * TypeScript arm serialises a payload before it reaches the Rust arm,
 * and `JSON.stringify` writes `1.0` as `1` — so the Rust arm parses an
 * integer and prints an integer.
 */

/**
 * Compare two strings by code point.
 *
 * Code point order is UTF-8 byte order, which is what `serde_json`'s
 * `BTreeMap` uses. JavaScript's `<` operator would compare UTF-16 code
 * units instead, which puts astral characters in the wrong place.
 */
export function compareCodePoints(a: string, b: string): number {
  if (a === b) return 0;
  const left = Array.from(a);
  const right = Array.from(b);
  const shared = Math.min(left.length, right.length);
  for (let i = 0; i < shared; i += 1) {
    const x = left[i]!.codePointAt(0)!;
    const y = right[i]!.codePointAt(0)!;
    if (x !== y) return x < y ? -1 : 1;
  }
  return left.length - right.length;
}

/**
 * Sort every object's keys by code point, recursively.
 *
 * Arrays keep their order — their order is meaningful and the Rust
 * core keeps it too.
 */
export function sortCanonical(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sortCanonical(item));
  }

  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      compareCodePoints(a, b),
    );
    return Object.fromEntries(entries.map(([key, nested]) => [key, sortCanonical(nested)]));
  }

  return value;
}

/**
 * The canonical JSON text of a value: compact, keys sorted by byte.
 *
 * This is the form the Rust core produces with `serde_json::to_string`
 * over a `BTreeMap`-backed value, and the form a block hash is
 * computed over.
 */
export function canonicalStringify(value: unknown): string {
  return JSON.stringify(sortCanonical(value)) ?? 'null';
}

/**
 * The canonical JSON text of a value: two-space indent, keys sorted by
 * byte.
 *
 * This is the form the Rust core produces with `serde_json::to_vec_pretty`
 * and the form a block file is written in.
 */
export function canonicalStringifyPretty(value: unknown): string {
  return JSON.stringify(sortCanonical(value), null, 2) ?? 'null';
}
