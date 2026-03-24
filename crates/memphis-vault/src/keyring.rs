use argon2::{Algorithm, Argon2, Params, Version};
use rand::RngCore;

use crate::error::VaultError;

/// Metadata about how a master key was derived.
#[derive(Debug, Clone)]
pub struct DerivationMeta {
    pub salt: [u8; 32],
    /// 1 = legacy zero-salt, 2 = random salt
    pub version: u8,
}

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

/// Derive master key with proper random salt (v2).
pub fn derive_master_key_v2(passphrase: &str) -> Result<([u8; 32], DerivationMeta), VaultError> {
    let salt = generate_salt();
    let key = derive_master_key(passphrase, &salt)?;
    Ok((key, DerivationMeta { salt, version: 2 }))
}

/// Legacy zero-salt derivation (v1). For migration reads only.
#[cfg(test)]
#[deprecated(note = "use derive_master_key_v2 for new vaults")]
pub fn derive_master_key_v1_compat(pepper: &str) -> Result<([u8; 32], DerivationMeta), VaultError> {
    let salt = [0u8; 32];
    let key = derive_master_key(pepper, &salt)?;
    Ok((key, DerivationMeta { salt, version: 1 }))
}

#[cfg(test)]
mod tests {
    #[allow(deprecated)]
    use super::*;

    #[test]
    fn test_v1_compat_uses_zero_salt() {
        let (_, meta) = derive_master_key_v1_compat("test-pepper").unwrap();
        assert_eq!(meta.version, 1);
        assert_eq!(meta.salt, [0u8; 32]);
    }

    #[test]
    fn test_v1_compat_is_deterministic() {
        let (key1, _) = derive_master_key_v1_compat("test-pepper").unwrap();
        let (key2, _) = derive_master_key_v1_compat("test-pepper").unwrap();
        assert_eq!(key1, key2);
    }

    #[test]
    fn test_v2_uses_random_salt() {
        let (_, meta1) = derive_master_key_v2("test-pepper").unwrap();
        let (_, meta2) = derive_master_key_v2("test-pepper").unwrap();
        assert_eq!(meta1.version, 2);
        assert_eq!(meta2.version, 2);
        assert_ne!(meta1.salt, meta2.salt, "v2 salts must be random");
    }

    #[test]
    fn test_v2_produces_different_keys_per_salt() {
        let (key1, _) = derive_master_key_v2("test-pepper").unwrap();
        let (key2, _) = derive_master_key_v2("test-pepper").unwrap();
        assert_ne!(key1, key2, "different random salts should produce different keys");
    }

    #[test]
    fn test_v1_and_v2_with_same_salt_match() {
        let salt = generate_salt();
        let v1_key = derive_master_key("pepper", &salt).unwrap();
        let v2_key = derive_master_key("pepper", &salt).unwrap();
        assert_eq!(v1_key, v2_key, "same inputs should produce same key");
    }
}
