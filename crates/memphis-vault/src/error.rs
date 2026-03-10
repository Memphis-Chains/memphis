use thiserror::Error;

#[derive(Debug, Error, Clone, PartialEq, Eq)]
pub enum VaultError {
    #[error("vault config is invalid: {0}")]
    InvalidConfig(&'static str),
    #[error("vault entry not found: {0}")]
    EntryNotFound(String),
    #[error("vault serialization error: {0}")]
    Serialization(String),
    #[error("{0}")]
    NotImplemented(&'static str),
}
