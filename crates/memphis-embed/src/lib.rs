pub mod cache;
pub mod chain_integration;
pub mod error;
pub mod lockfile;
pub mod metadata;
pub mod pipeline;
pub mod profile;
pub mod store;

pub use cache::{CacheStats, EmbeddingCache};
pub use chain_integration::ChainAwareEmbedStore;
pub use error::EmbedError;
pub use pipeline::{
    is_shutdown_barrier_set, set_shutdown_barrier, EmbedConfig, EmbedMode, EmbedPersistenceConfig,
    EmbedPersistenceLoadState, EmbedPipeline, EmbeddedDocument, EmbeddingProvider,
    GenericOpenAIProvider, LocalDeterministicProvider, OllamaProvider, ReplacementState, SearchHit,
    ShutdownFlushOutcome, DEFAULT_EMBEDDING_DIM, DEFAULT_MAX_TEXT_BYTES,
};
pub use profile::{
    embed_mode_from_env, embed_profile_manifest, index_dimension, resolve_embed_profile,
    resolve_profile_index_path, EmbedProfile, EmbedProfileDefaults, EmbedProfileEnv,
    EmbedProfileManifest, EmbedProfileModes, ENV_DIMENSION, ENV_INDEX_PATH, ENV_MODE, ENV_MODEL,
    LOCAL_MODE, PROVIDER_ALIAS, PROVIDER_MODE_NAMES, SOURCE_ENV, SOURCE_INDEX, SOURCE_LOCAL,
    SOURCE_UNKNOWN, VERDICT_DIMENSION_MISMATCH, VERDICT_NO_INDEX, VERDICT_NO_PROVIDER, VERDICT_OK,
};
pub use store::{cosine_similarity, ChainRef, VectorEntry, VectorStore};
