//! The native arm of the classify-criteria contract, checked against the
//! fixture the TypeScript arm also reads.
//!
//! `tests/fixtures/classify-criteria-contract.json` holds the cases; the
//! TypeScript runner is
//! `tests/unit/classify-criteria-contract.test.ts`.
//!
//! ## Why this test exists
//!
//! The registry declares `criteria` as a UNION — an object of labels, or
//! an array of 2-10 labels — and the gateway accepted both. The native
//! arm accepted only the object, so a model that had learned the array
//! form on Telegram got a refusal in the cockpit: the same tool, two
//! vocabularies.
//!
//! The fix is not "add the array form to the Rust side" — that is a
//! second copy of the rule, and the two copies would drift again. The
//! fix is ONE normalisation and ONE fixture that both arms are checked
//! against, which is the pattern the journal-target allowlist already
//! uses.

use memphis_operator::normalize_classify_criteria;
use serde_json::Value;

const FIXTURE: &str = include_str!("../../../tests/fixtures/classify-criteria-contract.json");

#[test]
fn the_native_arm_agrees_with_the_contract() {
    let fixture: Value = serde_json::from_str(FIXTURE).expect("the contract fixture must be valid JSON");
    let cases = fixture["cases"]
        .as_array()
        .expect("the contract fixture must hold a cases array");
    assert!(!cases.is_empty(), "the contract fixture must not be empty");

    for case in cases {
        let name = case["name"].as_str().expect("every case must carry a name");
        let criteria = &case["criteria"];
        let question_type = case["type"].as_str().expect("every case must carry a type");

        let actual = normalize_classify_criteria(criteria, question_type);

        match case.get("error").and_then(Value::as_str) {
            Some(expected_error) => {
                let error = actual
                    .err()
                    .unwrap_or_else(|| panic!("{name}: the native arm accepted what must be refused"));
                assert_eq!(
                    error, expected_error,
                    "{name}: the native arm refuses it for a different reason"
                );
            }
            None => {
                let options = match actual {
                    Ok(options) => options,
                    Err(error) => panic!("{name}: the native arm refused it: {error}"),
                };
                let expected = case["expected"]
                    .as_array()
                    .expect("a case without an error must carry expected options");
                let expected_pairs: Vec<(String, String)> = expected
                    .iter()
                    .map(|pair| {
                        let pair = pair.as_array().expect("each option must be a pair");
                        (
                            pair[0].as_str().expect("a key must be a string").to_string(),
                            pair[1].as_str().expect("a description must be a string").to_string(),
                        )
                    })
                    .collect();
                assert_eq!(options, expected_pairs, "{name}: the options differ");
            }
        }
    }
}
