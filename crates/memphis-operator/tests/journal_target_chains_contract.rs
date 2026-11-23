//! The native arm of the journal-target allowlist, checked against the
//! fixture the TypeScript arm also reads.
//!
//! `tests/fixtures/journal-target-chains-contract.json` holds the list;
//! the TypeScript runner is
//! `tests/unit/journal-target-chains-contract.test.ts`.
//!
//! ## Why this test exists
//!
//! Both arms carried a copy of the list, and both files claimed to be
//! "checked against `tests/fixtures/journal-target-chains-contract.json`,
//! so the two arms cannot drift apart silently".
//!
//! The fixture did not exist. The claim was a comment, not a gate, and
//! the Rust copy of the list was not used by anything — the compiler
//! reported it as dead code.
//!
//! A duplicated list with no gate is a list that WILL drift: it is two
//! hand-maintained copies of the same rule, and nothing compares them.
//! This test makes the claim true.

use memphis_operator::JOURNAL_TARGET_CHAINS;
use serde_json::Value;

const FIXTURE: &str = include_str!("../../../tests/fixtures/journal-target-chains-contract.json");

#[test]
fn the_native_arm_agrees_with_the_contract() {
    let fixture: Value =
        serde_json::from_str(FIXTURE).expect("the contract fixture must be valid JSON");
    let expected = fixture["chains"]
        .as_array()
        .expect("the contract fixture must hold a chains array");
    assert!(
        !expected.is_empty(),
        "the contract fixture must not be empty"
    );

    let actual: Vec<&str> = JOURNAL_TARGET_CHAINS.to_vec();
    let expected: Vec<String> = expected
        .iter()
        .map(|value| {
            value
                .as_str()
                .expect("every chain name must be a string")
                .to_string()
        })
        .collect();

    assert_eq!(
        actual, expected,
        "the native journal-target allowlist disagrees with the contract"
    );
}
