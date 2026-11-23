//! The canonical on-disk form of a block file, and the payload rule that
//! feeds it.
//!
//! ## Why this module exists
//!
//! Two writers write chain blocks on this host: the TypeScript write path
//! and this data plane. They wrote DIFFERENT BYTES for the same logical
//! block.
//!
//! Measured 2026-11-23 on the operator's host, over every block file in
//! `~/.memphis/chains` (11 864 files, 14 chains, plus 15 568 blocks in the
//! rotation archives):
//!
//! ```text
//! 6 248  chain,data,hash,index,prev_hash,timestamp   <- this arm (BTreeMap)
//! 5 606  index,timestamp,chain,data,prev_hash,hash    <- the TypeScript arm
//!     5  chain,index,timestamp,prev_hash,data,hash    <- legacy
//!     2  chain,index,prev_hash,timestamp,data,hash    <- legacy
//!     1  (compact, no indentation at all)             <- legacy
//! ```
//!
//! `chain verify` cannot see any of this. The hash covers a block's
//! VALUES, not its bytes, so two files that differ only in key order
//! verify identically — and no gate ever noticed.
//!
//! The order came from `serde_json`: without the `preserve_order` feature
//! its `Map` is a `BTreeMap`, so every object it writes comes out with its
//! keys sorted by byte. The TypeScript arm used the order of its object
//! literals instead. This module is this arm's side of the contract, and
//! `tests/fixtures/block-format-parity.json` is where the two sides meet.
//!
//! ## The payload rule
//!
//! A block's `data` is free-form, and the chain contract gives three of
//! its fields a meaning: `type`, `content` and `tags`. The hash covers
//! exactly those three, so the two arms have to read them the same way.
//!
//! `normalize_block_payload` is this arm's implementation of that rule.
//! The TypeScript arm has its own, in `src/core/block-payload.ts`. They
//! are two implementations of one rule — which is unavoidable in a
//! two-language repository, and is exactly why the gate compares them
//! against a shared artefact instead of trusting either side.

use serde_json::{Map, Value};

/// The fields the chain contract gives a meaning to.
pub const CANONICAL_PAYLOAD_FIELDS: [&str; 3] = ["type", "content", "tags"];

/// Serialize a block for disk: keys sorted by byte, two-space indent.
///
/// `serde_json::to_vec_pretty` over a `BTreeMap`-backed value already
/// produces exactly that: `Map` is a `BTreeMap` unless the `preserve_order`
/// feature is enabled, and `to_vec_pretty` indents with two spaces.
///
/// The function exists so that the format has a NAME and a place, rather
/// than being an expression typed at the call site. The TypeScript arm
/// has the same shape (`src/core/chain-file-io.ts::serializeBlockForDisk`),
/// and the gate compares what the two produce.
pub fn serialize_block_for_disk(block: &Value) -> Vec<u8> {
    serde_json::to_vec_pretty(block).expect("memphis-core: a block must be serializable")
}

/// The block's type: `type`, then the legacy `block_type`, then `journal`.
pub fn canonical_type(data: &Value) -> String {
    data.get("type")
        .and_then(Value::as_str)
        .or_else(|| data.get("block_type").and_then(Value::as_str))
        .unwrap_or("journal")
        .to_string()
}

/// The block's content: the payload's own `content` when it is a string,
/// else the canonical JSON of the whole payload.
///
/// The canonical JSON is compact with the keys sorted by byte — which is
/// what `serde_json::to_string` produces for a `Map`, and what the
/// TypeScript arm's `canonicalStringify` produces. The two agree for
/// every payload whose numbers are integers, which is every payload this
/// arm has written: measured 2026-11-23, 0 of 27 433 blocks on the host
/// carry a payload without a string `content`, so this branch has never
/// been taken.
pub fn canonical_content(data: &Value) -> String {
    data.get("content")
        .and_then(Value::as_str)
        .map(str::to_string)
        .unwrap_or_else(|| {
            serde_json::to_string(data).expect("memphis-core: a payload must be serializable")
        })
}

/// The block's tags: the payload's `tags`, keeping only the strings.
pub fn canonical_tags(data: &Value) -> Vec<String> {
    match data.get("tags") {
        Some(Value::Array(items)) => items
            .iter()
            .filter_map(Value::as_str)
            .map(str::to_string)
            .collect(),
        _ => Vec::new(),
    }
}

/// The payload as it is stored on disk: the three canonical fields, plus
/// everything else the payload carried.
///
/// Hashing the normalised payload gives the same hash as hashing the raw
/// payload: the canonical projection of a normalised payload reads the
/// same `type`, `content` and `tags` as the projection of the raw one,
/// because the normalisation fills them with exactly those values.
pub fn normalize_block_payload(data: &Value) -> Value {
    let mut out = Map::new();

    if let Some(object) = data.as_object() {
        for (key, value) in object {
            if CANONICAL_PAYLOAD_FIELDS.contains(&key.as_str()) {
                continue;
            }
            out.insert(key.clone(), value.clone());
        }
    }

    out.insert("type".to_string(), Value::String(canonical_type(data)));
    out.insert(
        "content".to_string(),
        Value::String(canonical_content(data)),
    );
    out.insert(
        "tags".to_string(),
        Value::Array(
            canonical_tags(data)
                .into_iter()
                .map(Value::String)
                .collect(),
        ),
    );

    Value::Object(out)
}

#[cfg(test)]
mod tests {
    use super::{canonical_content, canonical_tags, canonical_type, normalize_block_payload};
    use serde_json::json;

    #[test]
    fn the_type_falls_back_to_block_type_then_journal() {
        assert_eq!(canonical_type(&json!({"type": "insight"})), "insight");
        assert_eq!(canonical_type(&json!({"block_type": "reflection"})), "reflection");
        assert_eq!(canonical_type(&json!({"content": "x"})), "journal");
    }

    #[test]
    fn the_content_falls_back_to_the_canonical_payload() {
        assert_eq!(canonical_content(&json!({"content": "hello"})), "hello");
        // Sorted by byte: `a` before `b`, unlike an insertion-ordered
        // serialisation.
        assert_eq!(
            canonical_content(&json!({"b": 1, "a": 2})),
            "{\"a\":2,\"b\":1}"
        );
    }

    #[test]
    fn the_tags_keep_only_the_strings() {
        assert_eq!(canonical_tags(&json!({"tags": ["a", 1, "b"]})), vec!["a", "b"]);
        assert_eq!(canonical_tags(&json!({})), Vec::<String>::new());
    }

    #[test]
    fn the_normalised_payload_carries_the_three_fields() {
        let normalised = normalize_block_payload(&json!({"source": "test", "content": "hi"}));
        assert_eq!(normalised["source"], json!("test"));
        assert_eq!(normalised["content"], json!("hi"));
        assert_eq!(normalised["type"], json!("journal"));
        assert_eq!(normalised["tags"], json!([]));
    }
}
