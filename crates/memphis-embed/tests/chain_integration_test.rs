use memphis_core::block::{Block, BlockData, BlockType};
use memphis_core::chain::MemoryChain;
use memphis_embed::{ChainAwareEmbedStore, VectorStore};
use std::collections::HashMap;

#[test]
fn test_store_from_chain() {
    let mut chain = MemoryChain::new("test");

    let block = Block {
        index: 0,
        timestamp: "2026-03-10T17:00:00Z".to_string(),
        chain: "test".to_string(),
        data: BlockData {
            block_type: BlockType::Journal,
            content: "Test journal entry".to_string(),
            tags: vec!["test".to_string()],
        },
        prev_hash: "0".repeat(64),
        hash: "hash0".to_string(),
    };
    chain.append(block).unwrap();

    let vector_store = VectorStore::new();
    let mut embed_store = ChainAwareEmbedStore::new(vector_store);

    let vector = vec![0.1, 0.2, 0.3];
    let mut metadata = HashMap::new();
    metadata.insert("type".to_string(), "journal".to_string());

    let id = embed_store
        .store_from_chain(&chain, 0, vector.clone(), metadata)
        .unwrap();

    assert!(id.starts_with("test:"));
}
