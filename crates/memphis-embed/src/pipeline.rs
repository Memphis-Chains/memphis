use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::error::EmbedError;

pub const DEFAULT_EMBEDDING_DIM: usize = 32;
pub const DEFAULT_MAX_TEXT_BYTES: usize = 4096;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EmbedMode {
    LocalDeterministic,
    Provider(String),
}

#[derive(Debug, Clone)]
pub struct EmbedConfig {
    pub mode: EmbedMode,
    pub dim: usize,
    pub max_text_bytes: usize,
    pub provider_url: Option<String>,
    pub provider_api_key: Option<String>,
    pub provider_model: Option<String>,
    pub provider_timeout_ms: u64,
}

impl Default for EmbedConfig {
    fn default() -> Self {
        Self {
            mode: EmbedMode::LocalDeterministic,
            dim: DEFAULT_EMBEDDING_DIM,
            max_text_bytes: DEFAULT_MAX_TEXT_BYTES,
            provider_url: None,
            provider_api_key: None,
            provider_model: None,
            provider_timeout_ms: 8_000,
        }
    }
}

#[derive(Debug, Clone)]
pub struct EmbedPersistenceConfig {
    pub enabled: bool,
    pub index_path: PathBuf,
}

impl EmbedPersistenceConfig {
    pub fn disabled() -> Self {
        Self {
            enabled: false,
            index_path: PathBuf::new(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EmbedPersistenceLoadState {
    Disabled,
    Missing,
    Empty,
    Loaded,
    Corrupt,
}

#[derive(Debug, Clone)]
struct EmbedPersistenceState {
    index_path: PathBuf,
    last_load: EmbedPersistenceLoadState,
}

pub trait EmbeddingProvider {
    fn name(&self) -> &str;
    fn embed(&self, text: &str, dim: usize) -> Result<Vec<f32>, EmbedError>;
}

#[derive(Debug, Clone, Default)]
pub struct LocalDeterministicProvider;

impl EmbeddingProvider for LocalDeterministicProvider {
    fn name(&self) -> &str {
        "local-deterministic"
    }

    fn embed(&self, text: &str, dim: usize) -> Result<Vec<f32>, EmbedError> {
        deterministic_embed(text, dim)
    }
}

pub struct OllamaProvider {
    base_url: String,
    model: String,
    timeout: Duration,
}

impl OllamaProvider {
    pub fn new(config: &EmbedConfig) -> Result<Self, EmbedError> {
        let base_url = config
            .provider_url
            .as_deref()
            .unwrap_or("http://127.0.0.1:11434")
            .trim_end_matches('/')
            .to_string();

        let model = config
            .provider_model
            .as_deref()
            .unwrap_or("nomic-embed-text")
            .to_string();

        Ok(Self {
            base_url,
            model,
            timeout: Duration::from_millis(config.provider_timeout_ms),
        })
    }
}

impl EmbeddingProvider for OllamaProvider {
    fn name(&self) -> &str {
        "ollama"
    }

    fn embed(&self, text: &str, dim: usize) -> Result<Vec<f32>, EmbedError> {
        // Operators sometimes configure `RUST_EMBED_PROVIDER_URL` with the
        // full Ollama embeddings endpoint already appended (e.g.
        // `http://127.0.0.1:11434/api/embeddings`). That produced a 404 on
        // `http://.../api/embeddings/api/embeddings` because this function
        // always appended the suffix. Observed 2026-04-20 on operator WSL
        // during `memphis doctor --fix` embedding rebuild.
        //
        // Accept either form: strip a trailing `/api/embeddings` (with or
        // without a trailing slash) from base_url before appending.
        let trimmed = self.base_url.trim_end_matches('/');
        let base = trimmed
            .strip_suffix("/api/embeddings")
            .unwrap_or(trimmed);
        let url = format!("{}/api/embeddings", base);
        let payload = serde_json::json!({
            "model": &self.model,
            "prompt": text,
        });

        let resp = ureq::post(&url)
            .timeout(self.timeout)
            .send_json(&payload)
            .map_err(|e| EmbedError::ProviderRequest(format!("ollama request failed: {e}")))?;

        let body: serde_json::Value = resp
            .into_json()
            .map_err(|e| EmbedError::ProviderResponse(format!("invalid ollama response: {e}")))?;

        let embedding = body["embedding"].as_array().ok_or_else(|| {
            EmbedError::ProviderResponse("ollama response missing 'embedding' array".into())
        })?;

        let mut vector: Vec<f32> = embedding
            .iter()
            .filter_map(|v| v.as_f64().map(|f| f as f32))
            .collect();

        if vector.is_empty() {
            return Err(EmbedError::ProviderResponse(
                "ollama returned empty embedding".into(),
            ));
        }

        // Truncate or pad to requested dimension
        vector.truncate(dim);
        while vector.len() < dim {
            vector.push(0.0);
        }

        Ok(vector)
    }
}

pub struct GenericOpenAIProvider {
    url: String,
    model: String,
    api_key: Option<String>,
    timeout: Duration,
    provider_name: String,
}

impl GenericOpenAIProvider {
    pub fn new(config: &EmbedConfig, name: &str) -> Result<Self, EmbedError> {
        let url = config
            .provider_url
            .as_deref()
            .ok_or_else(|| {
                EmbedError::ProviderUnavailable(format!("{name} requires RUST_EMBED_PROVIDER_URL"))
            })?
            .to_string();

        let model = config
            .provider_model
            .as_deref()
            .unwrap_or("text-embedding-3-small")
            .to_string();

        Ok(Self {
            url,
            model,
            api_key: config.provider_api_key.clone(),
            timeout: Duration::from_millis(config.provider_timeout_ms),
            provider_name: name.to_string(),
        })
    }
}

impl EmbeddingProvider for GenericOpenAIProvider {
    fn name(&self) -> &str {
        &self.provider_name
    }

    fn embed(&self, text: &str, dim: usize) -> Result<Vec<f32>, EmbedError> {
        let payload = serde_json::json!({
            "model": &self.model,
            "input": text,
        });

        let mut req = ureq::post(&self.url).timeout(self.timeout);
        if let Some(key) = &self.api_key {
            req = req.set("Authorization", &format!("Bearer {key}"));
        }

        let resp = req.send_json(&payload).map_err(|e| {
            EmbedError::ProviderRequest(format!("{} request failed: {e}", self.provider_name))
        })?;

        let body: serde_json::Value = resp.into_json().map_err(|e| {
            EmbedError::ProviderResponse(format!("invalid {} response: {e}", self.provider_name))
        })?;

        let embedding = body["data"][0]["embedding"].as_array().ok_or_else(|| {
            EmbedError::ProviderResponse(format!(
                "{} response missing embedding",
                self.provider_name
            ))
        })?;

        let mut vector: Vec<f32> = embedding
            .iter()
            .filter_map(|v| v.as_f64().map(|f| f as f32))
            .collect();

        if vector.is_empty() {
            return Err(EmbedError::ProviderResponse(format!(
                "{} returned empty embedding",
                self.provider_name
            )));
        }

        vector.truncate(dim);
        while vector.len() < dim {
            vector.push(0.0);
        }

        Ok(vector)
    }
}

fn deterministic_embed(text: &str, dim: usize) -> Result<Vec<f32>, EmbedError> {
    if text.trim().is_empty() {
        return Err(EmbedError::EmptyInput);
    }
    if dim == 0 {
        return Err(EmbedError::InvalidDimension(dim));
    }

    let mut out = vec![0.0_f32; dim];
    for (idx, byte) in text.as_bytes().iter().enumerate() {
        let lane = idx % dim;
        let signal = ((*byte as u32) ^ ((idx as u32).wrapping_mul(31))) as f32;
        out[lane] += signal;
    }

    let norm = out.iter().map(|v| v * v).sum::<f32>().sqrt();
    if norm > 0.0 {
        for v in &mut out {
            *v /= norm;
        }
    }

    Ok(out)
}

fn lexical_overlap(query_normalized: &str, text: &str) -> f32 {
    if query_normalized.trim().is_empty() || text.trim().is_empty() {
        return 0.0;
    }

    let q: Vec<&str> = query_normalized.split_whitespace().collect();
    if q.is_empty() {
        return 0.0;
    }

    let body = normalize_query(text);
    let score = q.iter().filter(|tok| body.contains(**tok)).count() as f32;
    score / (q.len() as f32)
}

fn normalize_query(input: &str) -> String {
    const STOPWORDS: [&str; 14] = [
        "the", "a", "an", "and", "or", "for", "of", "to", "in", "on", "is", "are", "with", "how",
    ];

    input
        .to_lowercase()
        .split(|ch: char| !ch.is_alphanumeric())
        .filter(|tok| !tok.is_empty())
        .filter(|tok| !STOPWORDS.contains(tok))
        .collect::<Vec<_>>()
        .join(" ")
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EmbeddedDocument {
    pub id: String,
    pub text: String,
    pub vector: Vec<f32>,
    #[serde(default)]
    pub tags: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct SearchHit {
    pub id: String,
    pub score: f32,
    pub text_preview: String,
    pub tags: Vec<String>,
}

pub struct EmbedPipeline {
    config: EmbedConfig,
    provider: Box<dyn EmbeddingProvider + Send + Sync>,
    docs: HashMap<String, EmbeddedDocument>,
    persistence: Option<EmbedPersistenceState>,
}

#[derive(Debug, Serialize, Deserialize)]
struct EmbedDiskIndexV1 {
    version: u32,
    dim: usize,
    docs: Vec<EmbedDiskDocV1>,
}

#[derive(Debug, Serialize, Deserialize)]
struct EmbedDiskDocV1 {
    id: String,
    text: String,
    #[serde(default)]
    vector: Option<Vec<f32>>,
    #[serde(default)]
    tags: Vec<String>,
}

impl EmbedPipeline {
    pub fn new(config: EmbedConfig) -> Result<Self, EmbedError> {
        Self::with_persistence(config, EmbedPersistenceConfig::disabled())
    }

    pub fn with_persistence(
        config: EmbedConfig,
        persistence: EmbedPersistenceConfig,
    ) -> Result<Self, EmbedError> {
        if config.dim == 0 {
            return Err(EmbedError::InvalidDimension(config.dim));
        }

        let provider: Box<dyn EmbeddingProvider + Send + Sync> = match &config.mode {
            EmbedMode::LocalDeterministic => Box::new(LocalDeterministicProvider),
            EmbedMode::Provider(name) => match name.as_str() {
                "ollama" => Box::new(OllamaProvider::new(&config)?),
                "openai-compatible" | "cohere" | "voyage" | "jina" | "mistral" | "together"
                | "nvidia" | "mixedbread" => Box::new(GenericOpenAIProvider::new(&config, name)?),
                _ => {
                    return Err(EmbedError::ProviderUnavailable(format!(
                        "unknown provider: {name}"
                    )))
                }
            },
        };

        let mut pipeline = Self {
            config,
            provider,
            docs: HashMap::new(),
            persistence: None,
        };

        if persistence.enabled {
            let (docs, load_state) = pipeline.load_docs_from_disk(&persistence.index_path);
            pipeline.docs = docs;
            pipeline.persistence = Some(EmbedPersistenceState {
                index_path: persistence.index_path,
                last_load: load_state,
            });
        }

        Ok(pipeline)
    }

    pub fn provider_name(&self) -> &str {
        self.provider.name()
    }

    pub fn persistence_enabled(&self) -> bool {
        self.persistence.is_some()
    }

    pub fn persistence_load_state(&self) -> EmbedPersistenceLoadState {
        self.persistence
            .as_ref()
            .map(|p| p.last_load.clone())
            .unwrap_or(EmbedPersistenceLoadState::Disabled)
    }

    pub fn persistence_index_path(&self) -> Option<&Path> {
        self.persistence.as_ref().map(|p| p.index_path.as_path())
    }

    pub fn upsert(
        &mut self,
        id: impl Into<String>,
        text: impl Into<String>,
    ) -> Result<usize, EmbedError> {
        self.upsert_with_tags(id, text, Vec::new())
    }

    pub fn upsert_with_tags(
        &mut self,
        id: impl Into<String>,
        text: impl Into<String>,
        tags: Vec<String>,
    ) -> Result<usize, EmbedError> {
        let id = id.into();
        let text = text.into();
        self.validate_text(&text)?;
        let vector = self.provider.embed(&text, self.config.dim)?;
        self.docs.insert(
            id.clone(),
            EmbeddedDocument {
                id,
                text,
                vector,
                tags,
            },
        );
        self.persist_best_effort();
        Ok(self.docs.len())
    }

    pub fn search(&self, query: &str, top_k: usize) -> Result<Vec<SearchHit>, EmbedError> {
        self.search_with_tags(query, top_k, None)
    }

    pub fn search_with_tags(
        &self,
        query: &str,
        top_k: usize,
        filter_tags: Option<&[String]>,
    ) -> Result<Vec<SearchHit>, EmbedError> {
        self.validate_text(query)?;
        let query_vec = self.provider.embed(query, self.config.dim)?;

        let mut hits: Vec<SearchHit> = self
            .docs
            .values()
            .filter(|doc| match_tags(doc, filter_tags))
            .map(|doc| SearchHit {
                id: doc.id.clone(),
                score: crate::store::cosine_similarity(&query_vec, &doc.vector),
                text_preview: preview(&doc.text, 80),
                tags: doc.tags.clone(),
            })
            .collect();

        hits.sort_by(|a, b| b.score.total_cmp(&a.score));
        hits.truncate(top_k.max(1));
        Ok(hits)
    }

    pub fn search_tuned(&self, query: &str, top_k: usize) -> Result<Vec<SearchHit>, EmbedError> {
        self.search_tuned_with_tags(query, top_k, None)
    }

    pub fn search_tuned_with_tags(
        &self,
        query: &str,
        top_k: usize,
        filter_tags: Option<&[String]>,
    ) -> Result<Vec<SearchHit>, EmbedError> {
        self.validate_text(query)?;

        let raw_vec = self.provider.embed(query, self.config.dim)?;
        let normalized = normalize_query(query);
        let tuned_vec = if normalized.trim().is_empty() {
            None
        } else {
            Some(self.provider.embed(normalized.as_str(), self.config.dim)?)
        };

        let mut hits: Vec<SearchHit> = self
            .docs
            .values()
            .filter(|doc| match_tags(doc, filter_tags))
            .map(|doc| {
                let raw_score = crate::store::cosine_similarity(&raw_vec, &doc.vector);
                let tuned_score = tuned_vec
                    .as_ref()
                    .map(|tv| crate::store::cosine_similarity(tv, &doc.vector))
                    .unwrap_or(raw_score);
                let lexical = lexical_overlap(normalized.as_str(), doc.text.as_str());
                SearchHit {
                    id: doc.id.clone(),
                    score: raw_score.max(tuned_score) + (0.15 * lexical),
                    text_preview: preview(&doc.text, 80),
                    tags: doc.tags.clone(),
                }
            })
            .collect();

        hits.sort_by(|a, b| b.score.total_cmp(&a.score));
        hits.truncate(top_k.max(1));
        Ok(hits)
    }

    pub fn dim(&self) -> usize {
        self.config.dim
    }

    pub fn len(&self) -> usize {
        self.docs.len()
    }

    pub fn is_empty(&self) -> bool {
        self.docs.is_empty()
    }

    pub fn clear(&mut self) {
        self.docs.clear();
        self.persist_best_effort();
    }

    fn load_docs_from_disk(
        &self,
        index_path: &Path,
    ) -> (HashMap<String, EmbeddedDocument>, EmbedPersistenceLoadState) {
        let raw = match fs::read_to_string(index_path) {
            Ok(content) => content,
            Err(_) => return (HashMap::new(), EmbedPersistenceLoadState::Missing),
        };

        if raw.trim().is_empty() {
            return (HashMap::new(), EmbedPersistenceLoadState::Empty);
        }

        let parsed: EmbedDiskIndexV1 = match serde_json::from_str(&raw) {
            Ok(v) => v,
            Err(_) => return (HashMap::new(), EmbedPersistenceLoadState::Corrupt),
        };

        if parsed.version != 1 {
            return (HashMap::new(), EmbedPersistenceLoadState::Corrupt);
        }

        let mut docs = HashMap::new();
        for doc in parsed.docs {
            if doc.id.trim().is_empty() || doc.text.trim().is_empty() {
                continue;
            }

            if self.validate_text(&doc.text).is_err() {
                continue;
            }

            let vector = match doc.vector {
                Some(existing) if existing.len() == self.config.dim => existing,
                _ => match self.provider.embed(&doc.text, self.config.dim) {
                    Ok(v) => v,
                    Err(_) => continue,
                },
            };

            docs.insert(
                doc.id.clone(),
                EmbeddedDocument {
                    id: doc.id,
                    text: doc.text,
                    vector,
                    tags: doc.tags,
                },
            );
        }

        (docs, EmbedPersistenceLoadState::Loaded)
    }

    fn persist_best_effort(&self) {
        let Some(state) = self.persistence.as_ref() else {
            return;
        };

        let parent = match state.index_path.parent() {
            Some(p) => p,
            None => return,
        };

        if fs::create_dir_all(parent).is_err() {
            return;
        }

        let payload = EmbedDiskIndexV1 {
            version: 1,
            dim: self.config.dim,
            docs: self
                .docs
                .values()
                .map(|doc| EmbedDiskDocV1 {
                    id: doc.id.clone(),
                    text: doc.text.clone(),
                    vector: Some(doc.vector.clone()),
                    tags: doc.tags.clone(),
                })
                .collect(),
        };

        let serialized = match serde_json::to_string_pretty(&payload) {
            Ok(v) => v,
            Err(_) => return,
        };

        let tmp_path = state.index_path.with_extension("tmp");
        if fs::write(&tmp_path, serialized.as_bytes()).is_err() {
            return;
        }

        let _ = fs::rename(tmp_path, &state.index_path);
    }

    fn validate_text(&self, text: &str) -> Result<(), EmbedError> {
        if text.trim().is_empty() {
            return Err(EmbedError::EmptyInput);
        }
        let size = text.len();
        if size > self.config.max_text_bytes {
            return Err(EmbedError::TextTooLarge {
                size,
                max: self.config.max_text_bytes,
            });
        }
        Ok(())
    }
}

fn match_tags(doc: &EmbeddedDocument, filter_tags: Option<&[String]>) -> bool {
    let Some(tags) = filter_tags else {
        return true;
    };
    if tags.is_empty() {
        return true;
    }
    // Document must have at least one of the requested tags
    tags.iter().any(|t| {
        let lower = t.to_lowercase();
        doc.tags.iter().any(|dt| dt.to_lowercase() == lower)
    })
}

fn preview(text: &str, max_chars: usize) -> String {
    let mut out = String::new();
    for (idx, ch) in text.chars().enumerate() {
        if idx >= max_chars {
            out.push('…');
            break;
        }
        out.push(ch);
    }
    out
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    use super::{
        EmbedConfig, EmbedMode, EmbedPersistenceConfig, EmbedPersistenceLoadState, EmbedPipeline,
        LocalDeterministicProvider,
    };
    use crate::{EmbedError, EmbeddingProvider};

    fn temp_path(name: &str) -> PathBuf {
        let ts = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        std::env::temp_dir().join(format!("memphis-embed-{name}-{ts}.json"))
    }

    #[test]
    fn deterministic_local_provider_is_stable() {
        let provider = LocalDeterministicProvider;
        let a = provider
            .embed("memphis deterministic", 16)
            .expect("embed a");
        let b = provider
            .embed("memphis deterministic", 16)
            .expect("embed b");
        assert_eq!(a, b);
        assert_eq!(a.len(), 16);
    }

    #[test]
    fn store_and_query_roundtrip() {
        let mut pipeline = EmbedPipeline::new(EmbedConfig::default()).expect("pipeline");
        pipeline
            .upsert("doc-1", "rust embedding deterministic pipeline")
            .expect("upsert 1");
        pipeline
            .upsert("doc-2", "typescript adapter bridge for query")
            .expect("upsert 2");

        let hits = pipeline
            .search("deterministic embedding", 2)
            .expect("search");
        assert_eq!(hits.len(), 2);
        assert!(hits.iter().any(|h| h.id == "doc-1"));
        assert!(hits[0].score >= hits[1].score);
    }

    #[test]
    fn unknown_provider_is_rejected() {
        let out = EmbedPipeline::new(EmbedConfig {
            mode: EmbedMode::Provider("nonexistent-provider".to_string()),
            ..EmbedConfig::default()
        });

        assert_eq!(
            out.err(),
            Some(EmbedError::ProviderUnavailable(
                "unknown provider: nonexistent-provider".to_string(),
            ))
        );
    }

    #[test]
    fn tuned_search_works() {
        let mut pipeline = EmbedPipeline::new(EmbedConfig::default()).expect("pipeline");
        pipeline
            .upsert("doc-1", "how to recover rust bridge after timeout")
            .expect("upsert 1");
        pipeline
            .upsert("doc-2", "emoji art and stickers")
            .expect("upsert 2");

        let hits = pipeline
            .search_tuned("HOW TO recover bridge?!", 2)
            .expect("search");
        assert!(hits.iter().any(|h| h.id == "doc-1"));
    }

    #[test]
    fn enforces_text_limits() {
        let mut pipeline = EmbedPipeline::new(EmbedConfig {
            max_text_bytes: 4,
            ..EmbedConfig::default()
        })
        .expect("pipeline");

        let out = pipeline.upsert("doc", "12345");
        assert!(matches!(
            out,
            Err(EmbedError::TextTooLarge { size: 5, max: 4 })
        ));
    }

    #[test]
    fn persistence_roundtrip_survives_restart() {
        let path = temp_path("roundtrip");

        let mut first = EmbedPipeline::with_persistence(
            EmbedConfig::default(),
            EmbedPersistenceConfig {
                enabled: true,
                index_path: path.clone(),
            },
        )
        .expect("first pipeline");

        assert_eq!(
            first.persistence_load_state(),
            EmbedPersistenceLoadState::Missing
        );
        first
            .upsert("doc-1", "persisted deterministic document")
            .expect("upsert");

        let second = EmbedPipeline::with_persistence(
            EmbedConfig::default(),
            EmbedPersistenceConfig {
                enabled: true,
                index_path: path.clone(),
            },
        )
        .expect("second pipeline");

        assert_eq!(
            second.persistence_load_state(),
            EmbedPersistenceLoadState::Loaded
        );
        assert_eq!(second.len(), 1);

        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn persistence_corrupt_file_falls_back_to_empty() {
        let path = temp_path("corrupt");
        std::fs::write(&path, "{ not valid json").expect("write corrupt");

        let pipeline = EmbedPipeline::with_persistence(
            EmbedConfig::default(),
            EmbedPersistenceConfig {
                enabled: true,
                index_path: path.clone(),
            },
        )
        .expect("pipeline");

        assert_eq!(
            pipeline.persistence_load_state(),
            EmbedPersistenceLoadState::Corrupt
        );
        assert_eq!(pipeline.len(), 0);

        let _ = std::fs::remove_file(path);
    }
}
