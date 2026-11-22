//! Integration test: the core's validator accepts TS-written blocks with
//! extra `data` fields.
//!
//! The original bug was that `to_canonical_hash_data` was missing from
//! `chat.rs`, which produced "chain integrity check failed for journal:2
//! hash mismatch" on blocks the TypeScript side had written.
//!
//! ## What changed in this test
//!
//! It used to re-implement `stable_json` and SHA-256 INLINE and compare
//! the result against a hand-written fixture. That proved a hand-written
//! copy agreed with a hand-written fixture, and said nothing at all about
//! the code that actually validates blocks: the copy could drift from
//! `compute_hash` and the test would still pass.
//!
//! It now calls the OWNER — `memphis_core::hash::compute_hash` and
//! `memphis_core::soul::validate_block` — on blocks the TypeScript side
//! really wrote. The parity fixture that pins the two implementations
//! against each other lives in `tests/fixtures/chain-hash-parity.json` and
//! is checked by `crates/memphis-core/tests/chain_hash_parity.rs` and
//! `tests/unit/chain-hash-parity.test.ts`.
//!
//! ## Why it must not depend on an operator's live journal
//!
//! Doing so leaks local runtime state into the test boundary and makes
//! release gates host-specific.

use memphis_core::block::Block;
use memphis_core::hash::compute_hash;
use memphis_core::soul::validate_block;
use serde_json::Value;

/// A deterministic fixture produced with the TypeScript hash recipe.
const TS_WRITTEN_BLOCKS: &str = r#"[
  {
    "index": 0,
    "timestamp": "2026-07-20T10:00:00Z",
    "chain": "journal",
    "data": {
      "type": "journal",
      "content": "synthetic TS fixture",
      "tags": ["compat"],
      "source": "typescript",
      "turn_id": "fixture-1"
    },
    "prev_hash": "0000000000000000000000000000000000000000000000000000000000000000",
    "hash": "c2a7b363ab438375fd7a5b95bd36fc8f859b0f7f399f32432e49058d615931a0"
  },
  {
    "index": 1,
    "timestamp": "2026-07-20T10:00:01Z",
    "chain": "journal",
    "data": {
      "type": "journal",
      "content": "second synthetic block",
      "tags": ["compat", "extra-fields"],
      "source": "typescript",
      "consent": "local-only"
    },
    "prev_hash": "c2a7b363ab438375fd7a5b95bd36fc8f859b0f7f399f32432e49058d615931a0",
    "hash": "ac780e7de2965da3be7abab62778f1f49fc8d852ab79b7f940ff0a505cab167d"
  }
]"#;

#[test]
fn journal_chain_validates_against_canonical_hash() {
    let entries: Vec<Value> = serde_json::from_str(TS_WRITTEN_BLOCKS).unwrap();

    let mut prev_hash: Option<String> = None;
    let mut previous_block: Option<Block> = None;
    let mut prev_index: Option<u64> = None;
    let mut count = 0;

    for value in entries {
        let index = value.get("index").and_then(Value::as_u64).unwrap();
        let prev = value
            .get("prev_hash")
            .and_then(Value::as_str)
            .unwrap()
            .to_string();
        let stored_hash = value
            .get("hash")
            .and_then(Value::as_str)
            .unwrap()
            .to_string();

        let block: Block = serde_json::from_value(value.clone())
            .unwrap_or_else(|error| panic!("fixture block {index} does not deserialize: {error}"));

        // The OWNER computes the hash. The extra `data` fields — `source`,
        // `turn_id`, `consent` — are persisted but are NOT covered by the
        // hash, so they must not change it. That is the property this test
        // exists for.
        assert_eq!(
            compute_hash(&block),
            stored_hash,
            "block {index} canonical-hash mismatch"
        );

        let previous_block_ref = previous_block.as_ref();
        assert!(
            validate_block(&block, previous_block_ref).is_ok(),
            "block {index} was rejected by the core validator"
        );

        // Chain-link integrity
        if let Some(p) = &prev_hash {
            assert_eq!(p, &prev, "block {index} prev_hash mismatch");
        } else {
            assert_eq!(prev, "0".repeat(64), "block 1 must have zero prev_hash");
        }
        if let Some(pi) = prev_index {
            assert_eq!(index, pi + 1, "non-sequential index at {index}");
        }
        prev_index = Some(index);
        prev_hash = Some(stored_hash);
        previous_block = Some(block);
        count += 1;
    }

    assert_eq!(count, 2, "the fixture must exercise both blocks");
}
