use thiserror::Error;

#[derive(Debug, Error, PartialEq, Eq)]
pub enum EmbedError {
    #[error("text cannot be empty")]
    EmptyInput,
    #[error("text too large: {size} bytes exceeds max {max}")]
    TextTooLarge { size: usize, max: usize },
    #[error("invalid embedding dim: {0}")]
    InvalidDimension(usize),
    #[error("provider mode not implemented: {0}")]
    ProviderUnavailable(String),
    #[error("provider request failed: {0}")]
    ProviderRequest(String),
    #[error("provider returned invalid response: {0}")]
    ProviderResponse(String),

    #[error("Invalid vector: {0}")]
    InvalidVector(String),
    #[error("Vector not found: {0}")]
    NotFound(String),
    #[error("Disk I/O error: {0}")]
    DiskError(String),
    #[error("Serialization error: {0}")]
    SerializationError(String),
}
