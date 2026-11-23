//! The native arm of the rotation-head contract, checked against the
//! fixture the TypeScript arm also reads.
//!
//! `tests/fixtures/chain-rotation-head-contract.json` holds the cases;
//! the TypeScript runner is
//! `tests/unit/chain-rotation-head-contract.test.ts`.
//!
//! ## Why this test exists
//!
//! Rotation archives the old blocks of a chain. Measured 2026-11-22: the
//! rotated chain did not verify — the validators rejected it with
//! "missing genesis block (chain must start at index 0 or 1)", because
//! the first live block links to a block that is no longer in the
//! directory.
//!
//! That is why rotation was never enabled. The fix is a marker that
//! carries the head of the archive, and TWO validators have to accept it
//! the same way: the TypeScript one and this one. Two validators, one
//! rule — and a fixture that says which answers are right, so the arms
//! cannot drift apart.
//!
//! The arm that decides is `is_valid_chain_start`, and it is the same
//! function the TypeScript arm runs against the same fixture.

use memphis_operator::chat_rotation_head::{
    is_valid_chain_start, parse_chain_rotation_head, ROTATION_HEAD_FILENAME, ROTATION_HEAD_FORMAT,
};
use serde_json::Value;

const FIXTURE: &str = include_str!("../../../tests/fixtures/chain-rotation-head-contract.json");

#[test]
fn the_native_arm_agrees_with_the_contract() {
    let fixture: Value =
        serde_json::from_str(FIXTURE).expect("the contract fixture must be valid JSON");

    assert_eq!(
        fixture["format"].as_str(),
        Some(ROTATION_HEAD_FORMAT),
        "the contract fixture declares a different format tag"
    );
    assert_eq!(
        fixture["filename"].as_str(),
        Some(ROTATION_HEAD_FILENAME),
        "the contract fixture declares a different file name"
    );

    let cases = fixture["cases"]
        .as_array()
        .expect("the contract fixture must hold a cases array");
    assert!(!cases.is_empty(), "the contract fixture must not be empty");

    for case in cases {
        let name = case["name"].as_str().unwrap_or("<unnamed case>");
        let first_index = case["firstLiveBlock"]["index"]
            .as_i64()
            .expect("every case needs a first live block index");
        let first_prev_hash = case["firstLiveBlock"]["prev_hash"]
            .as_str()
            .expect("every case needs a first live block prev_hash");
        let expected = case["expectValid"]
            .as_bool()
            .expect("every case needs an expectValid flag");

        let head = match &case["head"] {
            Value::Null => None,
            value => parse_chain_rotation_head(&value.to_string()),
        };
        let actual = is_valid_chain_start(head.as_ref(), first_index, first_prev_hash);
        assert_eq!(actual, expected, "the native arm disagrees on: {name}");
    }
}

#[test]
fn the_native_arm_reads_a_marker_the_typescript_arm_wrote() {
    // The format tag and the file name are what the two arms share. A
    // marker written by the rotation (TypeScript) must parse here.
    let fixture: Value =
        serde_json::from_str(FIXTURE).expect("the contract fixture must be valid JSON");
    let head = fixture["cases"][0]["head"].clone();
    let parsed = parse_chain_rotation_head(&head.to_string()).expect("the head must parse");
    assert_eq!(parsed.last_archived_index, 15738);
    assert_eq!(parsed.chain, "system");
}
