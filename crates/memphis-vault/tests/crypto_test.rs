use memphis_vault::crypto::{decrypt, encrypt};

#[test]
fn test_encrypt_decrypt_roundtrip() {
    let key = [42u8; 32];
    let plaintext = b"secret data";

    let (ciphertext, nonce) = encrypt(plaintext, &key).unwrap();
    let decrypted = decrypt(&ciphertext, &key, &nonce).unwrap();

    assert_eq!(plaintext.to_vec(), decrypted);
}

#[test]
fn test_encrypt_different_ciphertexts() {
    let key = [42u8; 32];
    let plaintext = b"secret data";

    let (ct1, _) = encrypt(plaintext, &key).unwrap();
    let (ct2, _) = encrypt(plaintext, &key).unwrap();

    assert_ne!(ct1, ct2);
}

#[test]
fn test_decrypt_wrong_key_fails() {
    let key1 = [42u8; 32];
    let key2 = [24u8; 32];
    let plaintext = b"secret data";

    let (ciphertext, nonce) = encrypt(plaintext, &key1).unwrap();
    let result = decrypt(&ciphertext, &key2, &nonce);

    assert!(result.is_err());
}
