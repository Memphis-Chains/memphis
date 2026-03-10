pub mod cache;
pub mod chain_integration;
pub mod error;
pub mod pipeline;
pub mod store;

pub use cache::{CacheStats, EmbeddingCache};
pub use chain_integration::ChainAwareEmbedStore;
pub use error::EmbedError;
pub use pipeline::{
    EmbedConfig, EmbedMode, EmbedPersistenceConfig, EmbedPersistenceLoadState, EmbedPipeline,
    EmbeddedDocument, EmbeddingProvider, LocalDeterministicProvider, SearchHit,
    DEFAULT_EMBEDDING_DIM, DEFAULT_MAX_TEXT_BYTES,
};
pub use store::{cosine_similarity, ChainRef, VectorEntry, VectorStore};
