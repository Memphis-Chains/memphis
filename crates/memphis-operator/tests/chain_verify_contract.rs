//! The native arm of `memphis_chain_verify`, checked against the cases
//! where it and the TypeScript arm used to disagree.
//!
//! `tests/fixtures/chain-verify-contract.json` holds the cases; the
//! TypeScript runner is `tests/unit/mcp-chain-verify-contract.test.ts`.
//!
//! The disagreement was total: the native arm refused every archive
//! directory because a dot is not in `[A-Za-z0-9_-]`, so "verify all
//! chains" aborted on the first archive it met and checked nothing at
//! all. The TypeScript arm skipped those directories and kept going.

use memphis_operator::is_scannable_chain_directory_name;
use serde_json::Value;

const FIXTURE: &str = include_str!("../../../tests/fixtures/chain-verify-contract.json");

#[test]
fn the_native_arm_agrees_with_the_typescript_arm_on_chain_directory_names() {
    let fixture: Value = serde_json::from_str(FIXTURE).expect("the contract fixture must be valid JSON");
    let cases = fixture["cases"]
        .as_array()
        .expect("the contract fixture must hold a cases array");

    assert!(!cases.is_empty(), "the contract fixture must not be empty");

    let mut failures: Vec<String> = Vec::new();
    for case in cases {
        let name = case["name"].as_str().expect("every case needs a name");
        let directory = case["directory"].as_str().expect("every case needs a directory");
        let expected = case["scannable"]
            .as_bool()
            .expect("every case needs a scannable verdict");
        let actual = is_scannable_chain_directory_name(directory);
        if actual != expected {
            failures.push(format!(
                "{name}: directory {directory:?} -> scannable {actual}, expected {expected}"
            ));
        }
    }

    assert!(
        failures.is_empty(),
        "the native arm disagrees with the contract:\n{}",
        failures.join("\n")
    );
}
