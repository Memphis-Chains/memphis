use thiserror::Error;

#[derive(Debug, Error, Clone, PartialEq, Eq)]
pub enum VaultError {
    #[error("vault config is invalid: {0}")]
    InvalidConfig(&'static str),
    #[error("vault entry not found: {0}")]
    EntryNotFound(String),
    #[error("vault serialization error: {0}")]
    Serialization(String),
    #[error("key derivation failed: {0}")]
    KeyDerivation(String),
    #[error("encryption failed: {0}")]
    Encryption(String),
    #[error("decryption failed: {0}")]
    Decryption(String),
    #[error("{0}")]
    NotImplemented(&'static str),
}
