use thiserror::Error;

#[derive(Debug, Error)]
pub enum VaultError {
    #[error("invalid input: {0}")]
    InvalidInput(&'static str),

    #[error("crypto operation failed")]
    CryptoFailure,

    #[error("encoding/decoding failed")]
    EncodingFailure,
}
