//! The native arm of the self-modify contract, checked against the
//! fixture the TypeScript arm also reads.
//!
//! `tests/fixtures/self-modify-contract.json` holds the cases; the
//! TypeScript runner is `tests/unit/self-modify-contract.test.ts`.
//!
//! ## Why this test exists
//!
//! `memphis_self_modify` had three implementations that did not agree:
//! the MCP server read the registry's five fields, the gateway's own
//! executor normalised them first, and the native arm accepted
//! `{path, content, mode}` and wrote ONE file where the registry means
//! "apply changes to many files" — one name, two operations.
//!
//! The fix is ONE rule in ONE place per language, checked from both sides
//! against ONE table of cases. The digests in the fixture are the proof:
//! the same call must produce the same bytes on both arms, so the operator
//! sees one digest wherever the request was made.
//!
//! The expected digests were computed by a third implementation (the
//! generator of the fixture), so neither arm can satisfy the table by
//! agreeing with itself.

use memphis_operator::canonical_self_modify_request;
use serde_json::Value;
use sha2::{Digest, Sha256};

const FIXTURE: &str = include_str!("../../../tests/fixtures/self-modify-contract.json");

fn digest_of(payload: &str) -> String {
    format!("{:x}", Sha256::digest(payload.as_bytes()))
}

#[test]
fn the_native_arm_agrees_with_the_contract() {
    let fixture: Value = serde_json::from_str(FIXTURE).expect("the contract fixture must be valid JSON");
    let cases = fixture["cases"]
        .as_array()
        .expect("the contract fixture must hold a cases array");
    assert!(!cases.is_empty(), "the contract fixture must not be empty");

    for case in cases {
        let name = case["name"].as_str().expect("every case must carry a name");
        let mut arguments = case["arguments"].clone();

        // The one-MiB rule is in the table without putting a megabyte into
        // the repository: the case asks for the content to be grown.
        if let Some(expand) = case.get("expand") {
            let file = expand["file"].as_str().expect("an expansion must name a file");
            let times = expand["times"].as_u64().expect("an expansion must name a count") as usize;
            let unit = expand["unit"].as_str().expect("an expansion must name a unit");
            arguments["changes"][file] = Value::String(unit.repeat(times));
        }

        match case.get("error").and_then(Value::as_str) {
            Some(expected_error) => {
                let error = canonical_self_modify_request(&arguments)
                    .err()
                    .unwrap_or_else(|| panic!("{name}: the native arm accepted what must be refused"));
                assert_eq!(
                    error, expected_error,
                    "{name}: the native arm refuses it for a different reason"
                );
            }
            None => {
                let expected = case["expected"]
                    .as_object()
                    .expect("a case without an error must carry expected values");
                let canonical = canonical_self_modify_request(&arguments)
                    .unwrap_or_else(|error| panic!("{name}: the native arm refused it: {error}"));
                let payload = expected["payload"]
                    .as_str()
                    .expect("the expected payload must be a string");
                assert_eq!(canonical.payload, payload, "{name}: the canonical payload differs");
                assert_eq!(
                    digest_of(&canonical.payload),
                    expected["digest"].as_str().expect("the expected digest must be a string"),
                    "{name}: the digest differs — the arms do not agree on the bytes"
                );
                assert!(
                    !canonical.payload.contains("passphrase"),
                    "{name}: a passphrase must never reach the payload"
                );
                assert!(
                    !canonical.payload.contains("approval_request_id"),
                    "{name}: a transport key must never reach the payload"
                );
            }
        }
    }
}
