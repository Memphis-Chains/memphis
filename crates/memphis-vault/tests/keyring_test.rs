use memphis_vault::keyring::derive_master_key;

#[test]
fn test_derive_master_key_deterministic() {
    let salt = [1u8; 32];
    let key1 = derive_master_key("test_passphrase", &salt).unwrap();
    let key2 = derive_master_key("test_passphrase", &salt).unwrap();
    assert_eq!(key1, key2);
}

#[test]
fn test_derive_master_key_different_passphrases() {
    let salt = [1u8; 32];
    let key1 = derive_master_key("passphrase1", &salt).unwrap();
    let key2 = derive_master_key("passphrase2", &salt).unwrap();
    assert_ne!(key1, key2);
}

#[test]
fn test_derive_master_key_different_salts() {
    let salt1 = [1u8; 32];
    let salt2 = [2u8; 32];
    let key1 = derive_master_key("test", &salt1).unwrap();
    let key2 = derive_master_key("test", &salt2).unwrap();
    assert_ne!(key1, key2);
}
