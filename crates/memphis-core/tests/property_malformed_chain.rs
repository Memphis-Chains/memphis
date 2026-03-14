use memphis_core::block::{Block, BlockData, BlockType};
use memphis_core::hash::compute_hash;
use memphis_core::soul::validate_block;
use proptest::prelude::*;

fn valid_genesis_block() -> Block {
    let mut block = Block {
        index: 0,
        timestamp: "2026-03-08T21:00:00Z".to_string(),
        chain: "journal".to_string(),
        data: BlockData {
            block_type: BlockType::Journal,
            content: "valid content".to_string(),
            tags: vec!["test".to_string()],
        },
        prev_hash: "0".repeat(64),
        hash: String::new(),
        signer: None,
        signature: None,
    };
    block.hash = compute_hash(&block);
    block
}

proptest! {
    #[test]
    fn rejects_invalid_chain_paths(segment in "[a-zA-Z0-9_-]{1,16}") {
        let invalid_chains = vec![
            format!("{segment}/child"),
            format!("{segment}\\child"),
            format!("../{segment}"),
            format!("{segment}..{segment}"),
        ];

        for chain in invalid_chains {
            let mut block = valid_genesis_block();
            block.chain = chain;
            block.hash = compute_hash(&block);
            prop_assert!(validate_block(&block, None).is_err());
        }
    }

    #[test]
    fn rejects_non_rfc3339_timestamps(ts in "\\PC{1,40}") {
        prop_assume!(chrono::DateTime::parse_from_rfc3339(&ts).is_err());

        let mut block = valid_genesis_block();
        block.timestamp = ts;
        block.hash = compute_hash(&block);
        prop_assert!(validate_block(&block, None).is_err());
    }

    #[test]
    fn rejects_hash_mismatch_for_arbitrary_content(content in "\\PC{1,80}") {
        let mut block = valid_genesis_block();
        block.data.content = content;
        block.hash = "deadbeef".to_string();
        prop_assert!(validate_block(&block, None).is_err());
    }

    #[test]
    fn rejects_incomplete_signature_payload(sig in "[0-9a-f]{1,32}") {
        let mut block = valid_genesis_block();
        block.signature = Some(sig);
        block.hash = compute_hash(&block);
        prop_assert!(validate_block(&block, None).is_err());
    }
}
