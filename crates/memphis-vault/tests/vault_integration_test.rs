use memphis_vault::Vault;

#[test]
fn test_vault_full_roundtrip() {
    let vault = Vault::init("my_secure_passphrase_123!").unwrap();
    let entry = vault.store("api_key", b"sk-1234567890abcdef").unwrap();
    let decrypted = vault.retrieve(&entry).unwrap();

    assert_eq!(b"sk-1234567890abcdef".to_vec(), decrypted);
}
