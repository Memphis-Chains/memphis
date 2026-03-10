use memphis_core::block::{Block, BlockData, BlockType};
use memphis_core::chain::MemoryChain;
use memphis_embed::{ChainAwareEmbedStore, VectorStore};
use memphis_vault::{MemphisDid, Vault, VaultInitConfig};
use std::collections::HashMap;

fn mk_block(index: u64, prev_hash: String, hash: &str, content: &str) -> Block {
    Block {
        index,
        timestamp: format!("2026-03-10T18:09:{index:02}Z"),
        chain: "journal".to_string(),
        data: BlockData {
            block_type: BlockType::Journal,
            content: content.to_string(),
            tags: vec!["integration".to_string()],
        },
        prev_hash,
        hash: hash.to_string(),
    }
}

#[test]
fn test_full_vault_embed_integration() {
    let config = VaultInitConfig {
        passphrase: "secure_passphrase_123!".to_string(),
        qa_question: "First pet name?".to_string(),
        qa_answer: "fluffy".to_string(),
    };

    let vault_result = Vault::init_full(config).expect("vault init should succeed");
    let vault = vault_result.vault;
    let did = vault_result.did;
    let qa_challenge = vault_result.qa_challenge;

    assert!(did.did.starts_with("did:memphis:"));
    assert!(qa_challenge.verify("fluffy"));
    assert!(!qa_challenge.verify("wrong"));

    let vector_store = VectorStore::new();
    let mut embed_store = ChainAwareEmbedStore::new(vector_store);

    let (_secondary_did, did_private_key_bytes) = MemphisDid::generate().expect("did generation should work");
    let did_key_entry = vault
        .store("did_private_key", &did_private_key_bytes)
        .expect("store should work");

    let mut chain = MemoryChain::new("journal");
    chain
        .append(mk_block(0, "0".repeat(64), "hash-0", "DID private key stored"))
        .expect("append block should work");

    let test_vector = vec![0.1, 0.2, 0.3, 0.4];
    let mut metadata = HashMap::new();
    metadata.insert("type".to_string(), "did_key".to_string());
    metadata.insert("did_id".to_string(), did.did.clone());

    let stored_id = embed_store
        .store_from_chain(&chain, 0, test_vector.clone(), metadata)
        .expect("embed store should work");
    assert_eq!(stored_id, "journal:0");

    let search_results = embed_store
        .search_with_context(&test_vector, 5, Some(&chain))
        .expect("search should work");
    assert!(search_results.len() <= 5);
    assert!(search_results.iter().any(|(_, entry, ctx)| {
        entry.id == "journal:0" && ctx.as_deref() == Some("DID private key stored")
    }));

    let retrieved_key = vault.retrieve(&did_key_entry).expect("retrieve should work");
    assert_eq!(retrieved_key.len(), 64);
}

#[test]
fn test_vault_2fa_with_embed_cache() {
    let config1 = VaultInitConfig {
        passphrase: "pass1".to_string(),
        qa_question: "Q1?".to_string(),
        qa_answer: "a1x".to_string(),
    };

    let config2 = VaultInitConfig {
        passphrase: "pass1".to_string(),
        qa_question: "Q1?".to_string(),
        qa_answer: "a2x".to_string(),
    };

    let vault1 = Vault::init_full(config1).expect("vault1 init").vault;
    let vault2 = Vault::init_full(config2).expect("vault2 init").vault;

    let key1 = vault1.store("test", b"data1").expect("store1");
    let key2 = vault2.store("test", b"data2").expect("store2");

    assert!(vault2.retrieve(&key1).is_err());
    assert!(vault1.retrieve(&key2).is_err());
}

#[test]
fn test_did_verification_workflow() {
    let config = VaultInitConfig {
        passphrase: "test_pass".to_string(),
        qa_question: "Q?".to_string(),
        qa_answer: "answer".to_string(),
    };

    let result = Vault::init_full(config).expect("vault init");
    let did = result.did;

    assert!(did.did.starts_with("did:memphis:"));
    assert!(!did.public_key.is_empty());

    let mut store = VectorStore::new();
    let mut metadata = HashMap::new();
    metadata.insert("type".to_string(), "did".to_string());
    metadata.insert("did_id".to_string(), did.did.clone());

    let did_vector = vec![0.5_f32, 0.5_f32, 0.5_f32, 0.5_f32];
    store
        .store(did.did.clone(), did_vector.clone(), metadata)
        .expect("store works");

    let results = store.search(&did_vector, 10).expect("search works");
    assert!(results.iter().any(|(_, entry)| entry.id == did.did));
}
