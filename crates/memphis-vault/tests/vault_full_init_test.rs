use memphis_vault::{Vault, VaultInitConfig};

#[test]
fn test_vault_full_init_roundtrip() {
    let config = VaultInitConfig {
        passphrase: "secure_passphrase_123!".to_string(),
        qa_question: "What was your first pet's name?".to_string(),
        qa_answer: "fluffy".to_string(),
    };

    let result = Vault::init_full(config).expect("init should succeed");

    // Verify DID generated
    assert!(result.did.did.starts_with("did:memphis:"));

    // Verify Q&A challenge created
    assert!(result.qa_challenge.verify("fluffy"));

    // Verify vault can store/retrieve
    let entry = result.vault.store("test_key", b"test_value").unwrap();
    let decrypted = result.vault.retrieve(&entry).unwrap();
    assert_eq!(decrypted, b"test_value");
}
