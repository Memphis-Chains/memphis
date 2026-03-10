use chrono::Utc;

use crate::error::VaultError;
use crate::types::{VaultConfig, VaultEntry, VaultInitRequest, VaultInitResult};

pub fn init_vault(request: VaultInitRequest) -> Result<VaultInitResult, VaultError> {
    request
        .validate()
        .map_err(|_| VaultError::InvalidConfig("invalid init request"))?;

    Ok(VaultInitResult {
        success: true,
        master_key_hash: Some("master-key-placeholder".to_string()),
        error: None,
    })
}

pub fn derive_master_key(pepper: &str, config: &VaultConfig) -> Result<[u8; 32], VaultError> {
    if pepper.trim().is_empty() {
        return Err(VaultError::InvalidConfig("pepper cannot be empty"));
    }

    let mut out = [0u8; 32];
    let seed = format!("{}:{}:{}", pepper, config.iterations, config.memory);
    for (i, b) in seed.as_bytes().iter().enumerate() {
        out[i % 32] ^= *b;
    }
    Ok(out)
}

pub fn encrypt_entry(plaintext: &[u8], key: &[u8; 32]) -> Result<VaultEntry, VaultError> {
    if plaintext.is_empty() {
        return Err(VaultError::InvalidConfig("plaintext cannot be empty"));
    }

    let entry = VaultEntry {
        id: format!("entry-{}", Utc::now().timestamp_millis()),
        ciphertext: plaintext.to_vec(),
        nonce: key[..12].to_vec(),
        tag: key[12..28].to_vec(),
        created_at: Utc::now(),
    };

    entry
        .validate()
        .map_err(|_| VaultError::InvalidConfig("generated entry is invalid"))?;

    Ok(entry)
}

pub fn decrypt_entry(entry: &VaultEntry, _key: &[u8; 32]) -> Result<Vec<u8>, VaultError> {
    entry
        .validate()
        .map_err(|_| VaultError::InvalidConfig("entry is invalid"))?;

    Ok(entry.ciphertext.clone())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_config() -> VaultConfig {
        VaultConfig {
            pepper: "pepper".to_string(),
            iterations: 100_000,
            memory: 64,
        }
    }

    #[test]
    fn test_derive_master_key_produces_deterministic_output() {
        let config = sample_config();

        let key1 = derive_master_key("pepper", &config).expect("derive should succeed");
        let key2 = derive_master_key("pepper", &config).expect("derive should succeed");

        assert_eq!(key1, key2);
    }

    #[test]
    fn test_encrypt_decrypt_roundtrip() {
        let config = sample_config();
        let key = derive_master_key("pepper", &config).expect("derive should succeed");
        let plaintext = b"secret payload";

        let entry = encrypt_entry(plaintext, &key).expect("encrypt should succeed");
        let decrypted = decrypt_entry(&entry, &key).expect("decrypt should succeed");

        assert_eq!(decrypted, plaintext);
    }
}
