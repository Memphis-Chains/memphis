use crate::block::Block;
use serde_json::json;
use sha2::{Digest, Sha256};

pub fn compute_hash(block: &Block) -> String {
    // Canonical payload excludes `hash` itself to avoid self-referential hashing.
    let payload = json!({
        "index": block.index,
        "timestamp": block.timestamp,
        "chain": block.chain,
        "data": block.data,
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

#[cfg(test)]
mod tests {
    use super::compute_hash;
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
    fn deterministic_hash_for_identical_block() {
        let a = sample_block();
        let b = sample_block();
        assert_eq!(compute_hash(&a), compute_hash(&b));
    }
}
