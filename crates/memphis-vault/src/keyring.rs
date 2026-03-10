use argon2::{Algorithm, Argon2, Params, Version};
use rand::RngCore;

use crate::error::VaultError;

/// Derive master key from passphrase using Argon2id
pub fn derive_master_key(passphrase: &str, salt: &[u8; 32]) -> Result<[u8; 32], VaultError> {
    let params = Params::new(65536, 3, 4, Some(32))
        .map_err(|e| VaultError::KeyDerivation(e.to_string()))?;

    let argon2 = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);

    let mut key = [0u8; 32];
    argon2
        .hash_password_into(passphrase.as_bytes(), salt, &mut key)
        .map_err(|e| VaultError::KeyDerivation(e.to_string()))?;

    Ok(key)
}

/// Generate random salt for key derivation
pub fn generate_salt() -> [u8; 32] {
    let mut salt = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut salt);
    salt
}
