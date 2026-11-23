//! The parity gate between the TypeScript block hash and the Rust core.
//!
//! ## Why this test exists
//!
//! The block hash had three TypeScript implementations and one Rust
//! implementation, and the two sides were not compared by anything. The
//! TypeScript copies did not even agree with each other: `chain-adapter.ts`
//! fell back `type` -> `journal` while `chain-canonical.ts` fell back
//! `type` -> `block_type` -> `journal`, exactly like the native core.
//!
//! A gate that measures what it claims has to use the OWNER, not a copy of
//! it. The test that used to live in `memphis-operator` re-implemented
//! `stable_json` inline and hashed with that — so it proved that a
//! hand-written reimplementation agreed with a hand-written fixture, and
//! said nothing at all about the code that actually writes blocks.
//!
//! This test uses `memphis_core::hash::compute_hash` — the one function
//! the core itself verifies against — and the same fixture file the
//! TypeScript test reads. If the two implementations ever diverge, one of
//! the two tests fails.
//!
//! ## The fixture
//!
//! `tests/fixtures/chain-hash-parity.json` is a four-block chain whose
//! hashes were produced by this core. The blocks cover:
//!
//! - a plain journal block,
//! - a block with extra `data` fields, which the hash must ignore,
//! - a block with an empty tag list,
//! - a block whose content carries non-ASCII characters, quotes,
//!   backslashes and a newline — the bytes where two JSON writers are
//!   most likely to disagree.
//!
//! Every `type` in the fixture is a legal `BlockType`, so the core can
//! deserialize the block instead of taking it on trust.

use memphis_core::block::Block;
use memphis_core::hash::compute_hash;

const FIXTURE: &str = include_str!("../../../tests/fixtures/chain-hash-parity.json");

fn fixture_blocks() -> Vec<serde_json::Value> {
    let document: serde_json::Value =
        serde_json::from_str(FIXTURE).expect("the parity fixture must be valid JSON");
    document
        .get("blocks")
        .and_then(serde_json::Value::as_array)
        .cloned()
        .expect("the parity fixture must carry a blocks array")
}

#[test]
fn the_core_computes_the_hash_the_fixture_carries() {
    let blocks = fixture_blocks();
    assert!(!blocks.is_empty(), "the parity fixture must not be empty");

    let mut problems: Vec<String> = Vec::new();
    let mut previous: Option<String> = None;
    for (position, value) in blocks.iter().enumerate() {
        let block: Block = serde_json::from_value(value.clone())
            .unwrap_or_else(|error| panic!("fixture block {position} does not deserialize: {error}"));

        let computed = compute_hash(&block);
        let stored = value
            .get("hash")
            .and_then(serde_json::Value::as_str)
            .unwrap_or_else(|| panic!("fixture block {position} carries no hash"));

        if computed != stored {
            problems.push(format!(
                "block {position}: the core computes {computed} but the fixture carries {stored}"
            ));
        }

        if let Some(expected_prev) = previous {
            if block.prev_hash != expected_prev {
                problems.push(format!(
                    "block {position}: prev_hash {} does not link to the previous block {expected_prev}",
                    block.prev_hash
                ));
            }
        }
        previous = Some(computed);
    }

    assert!(
        problems.is_empty(),
        "the core and the parity fixture disagree:\n{}",
        problems.join("\n")
    );
}

#[test]
fn the_first_fixture_block_links_to_the_genesis_hash() {
    let blocks = fixture_blocks();
    let first = blocks
        .first()
        .and_then(|value| value.get("prev_hash"))
        .and_then(serde_json::Value::as_str)
        .expect("the first fixture block carries no prev_hash");
    assert_eq!(
        first,
        "0".repeat(64),
        "the parity chain must start at the genesis hash"
    );
}
