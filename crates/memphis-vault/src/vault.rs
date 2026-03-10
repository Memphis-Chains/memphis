use chrono::Utc;

use crate::crypto::{decrypt, encrypt};
use crate::error::VaultError;
use crate::keyring::{derive_master_key as derive_key_with_salt, generate_salt};
use crate::types::{VaultConfig, VaultEntry, VaultInitRequest, VaultInitResult};

pub struct Vault {
    pub salt: [u8; 32],
    master_key: [u8; 32],
}

impl Vault {
    pub fn from_parts(salt: [u8; 32], master_key: [u8; 32]) -> Self {
        Self { salt, master_key }
    }

    pub fn parts(&self) -> ([u8; 32], [u8; 32]) {
        (self.salt, self.master_key)
    }

    /// Initialize new vault with passphrase
    pub fn init(passphrase: &str) -> Result<Self, VaultError> {
        if passphrase.trim().is_empty() {
            return Err(VaultError::InvalidConfig("passphrase cannot be empty"));
        }

        let salt = generate_salt();
        let master_key = derive_key_with_salt(passphrase, &salt)?;
        Ok(Self { salt, master_key })
    }

    /// Store encrypted secret
    pub fn store(&self, key: &str, plaintext: &[u8]) -> Result<VaultEntry, VaultError> {
        if key.trim().is_empty() {
            return Err(VaultError::InvalidConfig("key cannot be empty"));
        }
        if plaintext.is_empty() {
            return Err(VaultError::InvalidConfig("plaintext cannot be empty"));
        }

        let (combined_ciphertext, nonce) = encrypt(plaintext, &self.master_key)?;
        if combined_ciphertext.len() < 16 {
            return Err(VaultError::Encryption("ciphertext too short".to_string()));
        }

        let split = combined_ciphertext.len() - 16;
        let ciphertext = combined_ciphertext[..split].to_vec();
        let tag = combined_ciphertext[split..].to_vec();

        let entry = VaultEntry {
            id: format!("entry-{}", Utc::now().timestamp_millis()),
            key: key.to_string(),
            ciphertext,
            nonce: nonce.to_vec(),
            tag,
            created_at: Utc::now(),
        };

        entry
            .validate()
            .map_err(|_| VaultError::InvalidConfig("generated entry is invalid"))?;

        Ok(entry)
    }

    /// Retrieve decrypted secret
    pub fn retrieve(&self, entry: &VaultEntry) -> Result<Vec<u8>, VaultError> {
        entry
            .validate()
            .map_err(|_| VaultError::InvalidConfig("entry is invalid"))?;

        let nonce: [u8; 12] = entry
            .nonce
            .as_slice()
            .try_into()
            .map_err(|_| VaultError::InvalidConfig("nonce must be exactly 12 bytes"))?;

        let mut combined = Vec::with_capacity(entry.ciphertext.len() + entry.tag.len());
        combined.extend_from_slice(&entry.ciphertext);
        combined.extend_from_slice(&entry.tag);

        decrypt(&combined, &self.master_key, &nonce)
    }
}

pub fn init_vault(request: VaultInitRequest) -> Result<VaultInitResult, VaultError> {
    request
        .validate()
        .map_err(|_| VaultError::InvalidConfig("invalid init request"))?;

    let salt = generate_salt();
    let master_key = derive_key_with_salt(&request.pepper, &salt)?;
    let hash_preview = master_key[..8]
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect::<String>();

    Ok(VaultInitResult {
        success: true,
        master_key_hash: Some(hash_preview),
        error: None,
    })
}

// Backward-compatible wrapper used by existing bridge paths.
pub fn derive_master_key(pepper: &str, _config: &VaultConfig) -> Result<[u8; 32], VaultError> {
    if pepper.trim().is_empty() {
        return Err(VaultError::InvalidConfig("pepper cannot be empty"));
    }
    let salt = [0u8; 32];
    derive_key_with_salt(pepper, &salt)
}

// Backward-compatible wrapper used by existing bridge paths.
pub fn encrypt_entry(plaintext: &[u8], key: &[u8; 32]) -> Result<VaultEntry, VaultError> {
    let (combined_ciphertext, nonce) = encrypt(plaintext, key)?;
    if combined_ciphertext.len() < 16 {
        return Err(VaultError::Encryption("ciphertext too short".to_string()));
    }

    let split = combined_ciphertext.len() - 16;

    let entry = VaultEntry {
        id: format!("entry-{}", Utc::now().timestamp_millis()),
        key: "legacy".to_string(),
        ciphertext: combined_ciphertext[..split].to_vec(),
        nonce: nonce.to_vec(),
        tag: combined_ciphertext[split..].to_vec(),
        created_at: Utc::now(),
    };

    entry
        .validate()
        .map_err(|_| VaultError::InvalidConfig("generated entry is invalid"))?;

    Ok(entry)
}

// Backward-compatible wrapper used by existing bridge paths.
pub fn decrypt_entry(entry: &VaultEntry, key: &[u8; 32]) -> Result<Vec<u8>, VaultError> {
    let nonce: [u8; 12] = entry
        .nonce
        .as_slice()
        .try_into()
        .map_err(|_| VaultError::InvalidConfig("nonce must be exactly 12 bytes"))?;

    let mut combined = Vec::with_capacity(entry.ciphertext.len() + entry.tag.len());
    combined.extend_from_slice(&entry.ciphertext);
    combined.extend_from_slice(&entry.tag);

    decrypt(&combined, key, &nonce)
}
