use crate::block::Block;
use crate::hash::compute_hash;
use crate::signature::verify_block_signature;
use chrono::DateTime;

pub fn validate_block(block: &Block, prev: Option<&Block>) -> Result<(), Vec<String>> {
    validate_block_internal(block, prev, false)
}

pub fn validate_block_strict(block: &Block, prev: Option<&Block>) -> Result<(), Vec<String>> {
    validate_block_internal(block, prev, true)
}

fn validate_block_internal(
    block: &Block,
    prev: Option<&Block>,
    require_signature: bool,
) -> Result<(), Vec<String>> {
    let mut errors = vec![];

    if block.chain.trim().is_empty() {
        errors.push("chain must not be empty".to_string());
    }
    if block.chain.contains('\0') {
        errors.push("chain contains invalid null byte".to_string());
    }
    if block.chain.contains("..") || block.chain.contains('/') || block.chain.contains('\\') {
        errors.push("chain contains invalid path characters".to_string());
    }

    if block.data.content.trim().is_empty() {
        errors.push("content must not be empty".to_string());
    }

    let block_ts = match DateTime::parse_from_rfc3339(&block.timestamp) {
        Ok(ts) => Some(ts),
        Err(_) => {
            errors.push("timestamp must be RFC3339".to_string());
            None
        }
    };

    let expected_hash = compute_hash(block);
    if block.hash != expected_hash {
        errors.push("hash mismatch".to_string());
    }

    match verify_block_signature(block) {
        Ok(true) => {}
        Ok(false) => {
            if require_signature {
                errors.push("signature required in strict mode".to_string());
            }
        }
        Err(err) => errors.push(format!("signature validation failed: {err}")),
    }

    match prev {
        None => {
            if block.index != 0 && block.index != 1 {
                errors.push("genesis must have index 0 or 1".to_string());
            }
            if block.prev_hash != "0".repeat(64) {
                errors.push("genesis must have zero prev_hash".to_string());
            }
        }
        Some(p) => {
            if block.index != p.index + 1 {
                errors.push("index not sequential".to_string());
            }
            if block.prev_hash != p.hash {
                errors.push("prev_hash doesn't match previous block".to_string());
            }
            let prev_ts = match DateTime::parse_from_rfc3339(&p.timestamp) {
                Ok(ts) => Some(ts),
                Err(_) => {
                    errors.push("previous block timestamp must be RFC3339".to_string());
                    None
                }
            };
            if let (Some(curr), Some(prev_curr)) = (block_ts, prev_ts) {
                if curr < prev_curr {
                    errors.push("timestamp before previous block".to_string());
                }
            }
        }
    }

    if errors.is_empty() {
        Ok(())
    } else {
        Err(errors)
    }
}

#[cfg(test)]
mod tests {
    use super::{validate_block, validate_block_strict};
    use crate::block::{Block, BlockData, BlockType};
    use crate::hash::compute_hash;
    use crate::signature::sign_block;

    fn mk_block(index: u64, prev_hash: String, ts: &str) -> Block {
        let mut block = Block {
            index,
            timestamp: ts.to_string(),
            chain: "journal".to_string(),
            data: BlockData {
                block_type: BlockType::Journal,
                content: "ok".to_string(),
                tags: vec![],
            },
            prev_hash,
            hash: String::new(),
            signer: None,
            signature: None,
        };
        block.hash = compute_hash(&block);
        block
    }

    #[test]
    fn genesis_requires_zero_prev_hash_and_index_zero() {
        let bad = mk_block(1, "abc".to_string(), "2026-03-08T21:00:00Z");
        let result = validate_block(&bad, None);
        assert!(result.is_err());
    }

    #[test]
    fn genesis_can_use_legacy_index_one() {
        let block = mk_block(1, "0".repeat(64), "2026-03-08T21:00:00Z");
        let result = validate_block(&block, None);
        assert!(result.is_ok());
    }

    #[test]
    fn non_genesis_requires_sequential_index_and_prev_hash_link() {
        let genesis = mk_block(0, "0".repeat(64), "2026-03-08T21:00:00Z");
        let bad_next = mk_block(2, "wrong".to_string(), "2026-03-08T21:00:01Z");
        let result = validate_block(&bad_next, Some(&genesis));
        assert!(result.is_err());
    }

    #[test]
    fn rejects_hash_mismatch() {
        let mut block = mk_block(0, "0".repeat(64), "2026-03-08T21:00:00Z");
        block.hash = "0".repeat(64);
        let result = validate_block(&block, None);
        assert!(result.is_err());
    }

    #[test]
    fn rejects_non_rfc3339_timestamp() {
        let block = mk_block(0, "0".repeat(64), "2026/03/08 21:00:00");
        let result = validate_block(&block, None);
        assert!(result.is_err());
    }

    #[test]
    fn strict_mode_requires_signature() {
        let block = mk_block(0, "0".repeat(64), "2026-03-08T21:00:00Z");
        let result = validate_block_strict(&block, None);
        assert!(result.is_err());
    }

    #[test]
    fn strict_mode_accepts_valid_signature() {
        let mut block = mk_block(0, "0".repeat(64), "2026-03-08T21:00:00Z");
        sign_block(&mut block, &[11u8; 32]).expect("sign should pass");
        let result = validate_block_strict(&block, None);
        assert!(result.is_ok());
    }
}
