use aes_gcm::{
    aead::{Aead, KeyInit, OsRng, rand_core::RngCore},
    Aes256Gcm, Nonce,
};

use crate::error::VaultError;

/// Encrypt data with AES-256-GCM
pub fn encrypt(plaintext: &[u8], key: &[u8; 32]) -> Result<(Vec<u8>, [u8; 12]), VaultError> {
    let cipher = Aes256Gcm::new_from_slice(key).map_err(|e| VaultError::Encryption(e.to_string()))?;

    let mut nonce_bytes = [0u8; 12];
    OsRng.fill_bytes(&mut nonce_bytes);
    let nonce = Nonce::from_slice(&nonce_bytes);

    let ciphertext = cipher
        .encrypt(nonce, plaintext)
        .map_err(|e| VaultError::Encryption(e.to_string()))?;

    Ok((ciphertext, nonce_bytes))
}

/// Decrypt data with AES-256-GCM
pub fn decrypt(ciphertext: &[u8], key: &[u8; 32], nonce: &[u8; 12]) -> Result<Vec<u8>, VaultError> {
    let cipher = Aes256Gcm::new_from_slice(key).map_err(|e| VaultError::Decryption(e.to_string()))?;
    let nonce = Nonce::from_slice(nonce);

    cipher
        .decrypt(nonce, ciphertext)
        .map_err(|e| VaultError::Decryption(e.to_string()))
}
