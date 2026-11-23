//! The native arm of the case-append contract, checked against the
//! fixture the TypeScript arm also reads.
//!
//! `tests/fixtures/case-append-contract.json` holds the cases; the
//! TypeScript runner is `tests/unit/case-append-contract.test.ts`.
//!
//! ## Why this test exists
//!
//! The registry accepts the flat form as well as `{entry: {...}}`, and
//! the gateway normalised the two into one shape. The native arm
//! required the wrapped form, so a model that had learned the flat form
//! on Telegram got a refusal in the cockpit — and the flat form is the
//! one the registry's own help text shows first.
//!
//! ONE normalisation, checked from both sides against ONE table of
//! cases: a rule copied into a second language is a rule that drifts.

use memphis_operator::normalize_case_append_input;
use serde_json::Value;

const FIXTURE: &str = include_str!("../../../tests/fixtures/case-append-contract.json");

#[test]
fn the_native_arm_agrees_with_the_contract() {
    let fixture: Value = serde_json::from_str(FIXTURE).expect("the contract fixture must be valid JSON");
    let cases = fixture["cases"]
        .as_array()
        .expect("the contract fixture must hold a cases array");
    assert!(!cases.is_empty(), "the contract fixture must not be empty");

    for case in cases {
        let name = case["name"].as_str().expect("every case must carry a name");
        let arguments = &case["arguments"];
        let expected = case["expected"].as_object().expect("every case must carry expectations");

        let normalized = normalize_case_append_input(arguments);
        for (field, value) in expected {
            assert_eq!(
                normalized.get(field),
                Some(value),
                "{name}: the case field {field} differs"
            );
        }
    }
}

#[test]
fn the_native_arm_reads_both_forms() {
    let fixture: Value = serde_json::from_str(FIXTURE).expect("the contract fixture must be valid JSON");
    let cases = fixture["cases"]
        .as_array()
        .expect("the contract fixture must hold a cases array");

    let wrapped = cases
        .iter()
        .filter(|case| case["arguments"].get("entry").is_some())
        .count();
    let flat = cases.len() - wrapped;

    assert!(wrapped > 0, "the contract must cover the wrapped form");
    assert!(flat > 0, "the contract must cover the flat form");
}
