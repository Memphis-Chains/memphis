//! Integration test: verify that validate_generic_block accepts TS-written
//! blocks with extra `data` fields (the original bug was that
//! `to_canonical_hash_data` was missing from chat.rs, causing
//! "chain integrity check failed for journal:2 hash mismatch").
//!
//! This test uses a deterministic fixture produced with the TS hash recipe.
//! It must never depend on an operator's live journal: doing so leaks local
//! runtime state into the test boundary and makes release gates host-specific.

// compute_hash not needed — we reimplement stable_json inline
use serde_json::Value;

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
    let mut prev_index: Option<u64> = None;
    let mut count = 0;

    for v in entries {
        let index = v.get("index").and_then(Value::as_u64).unwrap();
        let timestamp = v
            .get("timestamp")
            .and_then(Value::as_str)
            .unwrap()
            .to_string();
        let chain = v.get("chain").and_then(Value::as_str).unwrap().to_string();
        let data = v.get("data").cloned().unwrap();
        let prev = v
            .get("prev_hash")
            .and_then(Value::as_str)
            .unwrap()
            .to_string();
        let stored_hash = v.get("hash").and_then(Value::as_str).unwrap().to_string();

        // Reconstruct what the FIXED compute_hash produces and compare.
        // We need a Block struct equivalent — easiest path: reimplement the
        // hash recipe using the same canonical data projection.
        let canonical = memphis_core::hash::to_canonical_hash_data(data.clone());
        let payload = serde_json::json!({
            "index": index,
            "timestamp": timestamp,
            "chain": chain,
            "data": canonical,
            "prev_hash": prev,
        });
        // Use the same stable_json trick the validator uses
        fn stable_json(v: &Value) -> String {
            fn canonicalize(v: Value) -> Value {
                match v {
                    Value::Array(items) => {
                        Value::Array(items.into_iter().map(canonicalize).collect())
                    }
                    Value::Object(map) => {
                        let mut sorted = std::collections::BTreeMap::new();
                        for (k, val) in map {
                            sorted.insert(k, val);
                        }
                        let mut next = serde_json::Map::new();
                        for (k, val) in sorted {
                            next.insert(k, canonicalize(val));
                        }
                        Value::Object(next)
                    }
                    other => other,
                }
            }
            serde_json::to_string(&canonicalize(v.clone())).unwrap()
        }
        let expected = {
            use sha2::{Digest, Sha256};
            let bytes = stable_json(&payload);
            let mut h = Sha256::new();
            h.update(bytes.as_bytes());
            format!("{:x}", h.finalize())
        };

        // Chain-link integrity
        if let Some(p) = &prev_hash {
            assert_eq!(p, &prev, "block {} prev_hash mismatch", index);
        } else {
            assert_eq!(prev, "0".repeat(64), "block 1 must have zero prev_hash");
        }
        if let Some(pi) = prev_index {
            assert_eq!(index, pi + 1, "non-sequential index at {}", index);
        }
        assert_eq!(
            expected, stored_hash,
            "block {} canonical-hash mismatch",
            index
        );

        prev_hash = Some(stored_hash);
        prev_index = Some(index);
        count += 1;
    }
    assert_eq!(count, 2, "fixture block count changed unexpectedly");
}
