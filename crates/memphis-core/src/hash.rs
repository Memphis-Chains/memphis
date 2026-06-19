use crate::block::Block;
use serde_json::json;
use sha2::{Digest, Sha256};

pub fn compute_hash(block: &Block) -> String {
    // Canonical payload excludes `hash` itself to avoid self-referential hashing.
    // `data` is reduced to the 3-field canonical form (type/content/tags) so
    // hashes match TS-side chain-adapter writes and old `journal`/`cases`/
    // `decisions`/etc. blocks validate cleanly on read.
    let payload = json!({
        "index": block.index,
        "timestamp": block.timestamp,
        "chain": block.chain,
        "data": to_canonical_hash_data(&block.data),
        "prev_hash": block.prev_hash,
    });

    // Serializing this payload should be infallible for our Block schema.
    // Fail loudly instead of silently hashing empty bytes.
    let bytes =
        serde_json::to_vec(&payload).expect("memphis-core: block payload serialization failed");
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    format!("{:x}", hasher.finalize())
}


/// Reduce a generic block `data` payload to the canonical 3-field form used by
/// the TS-side chain-adapter (`toCanonicalHashData`). Mirrors the TS behaviour:
///   - `type` (string)
///   - `content` (string, falls back to JSON-stringified value if missing)
///   - `tags` (array of strings, defaults to empty)
///
/// This ensures that Rust-computed block hashes match TS-written blocks
/// (which carry the same algorithm), so a block written by the TS chain-adapter
/// validates cleanly when read back through the Rust NAPI bridge.
pub fn to_canonical_hash_data<T: serde::Serialize>(data: T) -> serde_json::Value {
    // Accept any Serialize-able value. We round-trip through serde_json::Value
    // so callers can pass either &Value (chat.rs) or &BlockData (hash.rs) and
    // get identical canonicalisation.
    let v: serde_json::Value = serde_json::to_value(data)
        .expect("to_canonical_hash_data: data must be serializable");
    to_canonical_hash_data_from_value(&v)
}

fn to_canonical_hash_data_from_value(data: &serde_json::Value) -> serde_json::Value {
    let obj = data.as_object();
    let block_type = obj
        .and_then(|m| m.get("type"))
        .and_then(|v| v.as_str())
        .or_else(|| {
            obj.and_then(|m| m.get("block_type"))
                .and_then(|v| v.as_str())
        })
        .unwrap_or("journal");
    let content = obj
        .and_then(|m| m.get("content"))
        .and_then(|v| v.as_str())
        .map(str::to_string)
        .unwrap_or_else(|| data.to_string());
    let tags: Vec<serde_json::Value> = match obj.and_then(|m| m.get("tags")) {
        Some(serde_json::Value::Array(items)) => items
            .iter()
            .filter_map(|v| v.as_str().map(str::to_string).map(serde_json::Value::String))
            .collect(),
        _ => Vec::new(),
    };
    serde_json::json!({
        "type": block_type,
        "content": content,
        "tags": tags,
    })
}

#[cfg(test)]
mod tests {
    use super::{compute_hash, to_canonical_hash_data};
    use crate::block::{Block, BlockData, BlockType};

    fn sample_block() -> Block {
        Block {
            index: 0,
            timestamp: "2026-03-08T21:00:00Z".to_string(),
            chain: "journal".to_string(),
            data: BlockData {
                block_type: BlockType::Journal,
                content: "hello".to_string(),
                tags: vec!["test".to_string()],
            },
            prev_hash: "0".repeat(64),
            hash: String::new(),
            signer: None,
            signature: None,
        }
    }

    #[test]
    fn canonical_hash_ignores_extra_data_fields() {
        // A canonical hash over a 3-field data projection must match the
        // hash of a payload that has additional fields (source, turn_id,
        // ...). This mirrors the TS chain-adapter behaviour.
        let minimal: serde_json::Value = serde_json::json!({
            "type": "journal",
            "content": "hello",
            "tags": ["x", "y"],
        });
        let extended: serde_json::Value = serde_json::json!({
            "type": "journal",
            "content": "hello",
            "tags": ["x", "y"],
            "source": "mcp",
            "turn_id": "abc-123",
            "consent": "local-only",
        });
        assert_eq!(
            to_canonical_hash_data(minimal),
            to_canonical_hash_data(extended)
        );
    }

    #[test]
    fn deterministic_hash_for_identical_block() {
        let a = sample_block();
        let b = sample_block();
        assert_eq!(compute_hash(&a), compute_hash(&b));
    }
}
