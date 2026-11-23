//! Regenerate `tests/fixtures/block-format-parity.json` from the core.
//!
//! ## Why this exists
//!
//! The block-format parity gate compares the two arms against a shared
//! artefact. The artefact's expected values must come from ONE side — the
//! native core — so that neither arm can define "correct" for the other.
//!
//! The logical cases live IN the artefact. This tool reads them, computes
//! what the core produces for each of them, and writes the artefact back
//! with those values filled in:
//!
//! - `expected_payload` — the normalised payload (the three canonical
//!   fields plus everything the payload carried),
//! - `expected_hash` — the canonical hash of the block,
//! - `expected_file_sha256` — the SHA-256 of the block file's bytes.
//!
//! ## Usage
//!
//! ```text
//! cargo run -p memphis-core --example emit_block_format_parity -- \
//!     ../../tests/fixtures/block-format-parity.json
//! ```
//!
//! The path defaults to the fixture inside this repository. The tool never
//! edits the logical cases — it only fills the expected values.

use std::fs;
use std::path::PathBuf;

use memphis_core::block_format::{normalize_block_payload, serialize_block_for_disk};
use memphis_core::hash::compute_hash_of_payload;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

fn default_artifact_path() -> PathBuf {
    // crates/memphis-core/examples/ -> crates/memphis-core -> crates -> repo root
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../tests/fixtures/block-format-parity.json")
}

fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    format!("{:x}", hasher.finalize())
}

fn main() {
    let path = std::env::args()
        .nth(1)
        .map(PathBuf::from)
        .unwrap_or_else(default_artifact_path);

    let raw = fs::read_to_string(&path)
        .unwrap_or_else(|error| panic!("cannot read {}: {error}", path.display()));
    let mut artifact: Value =
        serde_json::from_str(&raw).unwrap_or_else(|error| panic!("{} is not JSON: {error}", path.display()));

    let cases = artifact["cases"]
        .as_array()
        .unwrap_or_else(|| panic!("{} carries no cases array", path.display()))
        .clone();

    let mut regenerated = Vec::with_capacity(cases.len());
    let mut previous_hash: Option<String> = None;
    for case in &cases {
        let block = &case["block"];
        let index = block["index"].as_u64().expect("a case block needs an index");
        let timestamp = block["timestamp"].as_str().expect("a case block needs a timestamp");
        let chain = block["chain"].as_str().expect("a case block needs a chain");
        let data = &block["data"];

        // The cases are a CHAIN: each one links to the block before it.
        // The artefact declares the linkage with `@genesis` and
        // `@previous`, and the core resolves it — so the expected values
        // stay generated, never hand-written.
        let prev_hash = match block["prev_hash"].as_str() {
            Some("@genesis") => "0".repeat(64),
            Some("@previous") => previous_hash
                .clone()
                .unwrap_or_else(|| panic!("the first case cannot link to a previous block")),
            Some(other) => other.to_string(),
            None => panic!("a case block needs a prev_hash"),
        };

        let payload = normalize_block_payload(data);
        let hash = compute_hash_of_payload(index, timestamp, chain, &payload, &prev_hash);

        let file_block = json!({
            "index": index,
            "timestamp": timestamp,
            "chain": chain,
            "data": payload,
            "prev_hash": prev_hash,
            "hash": hash,
        });
        let bytes = serialize_block_for_disk(&file_block);

        let mut next = case.clone();
        next["block"]["prev_hash"] = Value::String(prev_hash);
        next["expected_payload"] = payload;
        next["expected_hash"] = Value::String(hash.clone());
        next["expected_file_sha256"] = Value::String(sha256_hex(&bytes));
        previous_hash = Some(hash);
        regenerated.push(next);
    }

    artifact["cases"] = Value::Array(regenerated);
    let mut text = serde_json::to_string_pretty(&artifact).expect("the artefact must serialize");
    text.push('\n');
    fs::write(&path, text).unwrap_or_else(|error| panic!("cannot write {}: {error}", path.display()));

    println!("regenerated {} cases in {}", artifact["cases"].as_array().unwrap().len(), path.display());
}
