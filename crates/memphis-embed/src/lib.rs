use std::collections::HashMap;

use thiserror::Error;

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
}

impl Default for EmbedConfig {
    fn default() -> Self {
        Self {
            mode: EmbedMode::LocalDeterministic,
            dim: DEFAULT_EMBEDDING_DIM,
            max_text_bytes: DEFAULT_MAX_TEXT_BYTES,
        }
    }
}

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

#[derive(Debug, Clone)]
pub struct EmbeddedDocument {
    pub id: String,
    pub text: String,
    pub vector: Vec<f32>,
}

#[derive(Debug, Clone)]
pub struct SearchHit {
    pub id: String,
    pub score: f32,
    pub text_preview: String,
}

pub struct EmbedPipeline {
    config: EmbedConfig,
    provider: Box<dyn EmbeddingProvider + Send + Sync>,
    docs: HashMap<String, EmbeddedDocument>,
}

impl EmbedPipeline {
    pub fn new(config: EmbedConfig) -> Result<Self, EmbedError> {
        if config.dim == 0 {
            return Err(EmbedError::InvalidDimension(config.dim));
        }

        let provider: Box<dyn EmbeddingProvider + Send + Sync> = match &config.mode {
            EmbedMode::LocalDeterministic => Box::new(LocalDeterministicProvider),
            EmbedMode::Provider(name) => return Err(EmbedError::ProviderUnavailable(name.clone())),
        };

        Ok(Self {
            config,
            provider,
            docs: HashMap::new(),
        })
    }

    pub fn provider_name(&self) -> &str {
        self.provider.name()
    }

    pub fn upsert(&mut self, id: impl Into<String>, text: impl Into<String>) -> Result<usize, EmbedError> {
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
            },
        );
        Ok(self.docs.len())
    }

    pub fn search(&self, query: &str, top_k: usize) -> Result<Vec<SearchHit>, EmbedError> {
        self.validate_text(query)?;
        let query_vec = self.provider.embed(query, self.config.dim)?;

        let mut hits: Vec<SearchHit> = self
            .docs
            .values()
            .map(|doc| SearchHit {
                id: doc.id.clone(),
                score: cosine_similarity(&query_vec, &doc.vector),
                text_preview: preview(&doc.text, 80),
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

fn cosine_similarity(a: &[f32], b: &[f32]) -> f32 {
    if a.len() != b.len() || a.is_empty() {
        return 0.0;
    }

    let mut dot = 0.0;
    let mut norm_a = 0.0;
    let mut norm_b = 0.0;

    for (va, vb) in a.iter().zip(b) {
        dot += va * vb;
        norm_a += va * va;
        norm_b += vb * vb;
    }

    if norm_a == 0.0 || norm_b == 0.0 {
        return 0.0;
    }

    dot / (norm_a.sqrt() * norm_b.sqrt())
}

#[cfg(test)]
mod tests {
    use super::{EmbedConfig, EmbedError, EmbedMode, EmbedPipeline, LocalDeterministicProvider};
    use crate::EmbeddingProvider;

    #[test]
    fn deterministic_local_provider_is_stable() {
        let provider = LocalDeterministicProvider;
        let a = provider.embed("memphis deterministic", 16).expect("embed a");
        let b = provider.embed("memphis deterministic", 16).expect("embed b");
        assert_eq!(a, b);
        assert_eq!(a.len(), 16);
    }

    #[test]
    fn store_and_query_roundtrip() {
        let mut pipeline = EmbedPipeline::new(EmbedConfig::default()).expect("pipeline");
        pipeline.upsert("doc-1", "rust embedding deterministic pipeline").expect("upsert 1");
        pipeline.upsert("doc-2", "typescript adapter bridge for query").expect("upsert 2");

        let hits = pipeline.search("deterministic embedding", 2).expect("search");
        assert_eq!(hits.len(), 2);
        assert!(hits.iter().any(|h| h.id == "doc-1"));
        assert!(hits[0].score >= hits[1].score);
    }

    #[test]
    fn provider_mode_boundary_is_explicit() {
        let out = EmbedPipeline::new(EmbedConfig {
            mode: EmbedMode::Provider("openai".to_string()),
            ..EmbedConfig::default()
        });

        assert_eq!(
            out.err(),
            Some(EmbedError::ProviderUnavailable("openai".to_string()))
        );
    }

    #[test]
    fn enforces_text_limits() {
        let mut pipeline = EmbedPipeline::new(EmbedConfig {
            max_text_bytes: 4,
            ..EmbedConfig::default()
        })
        .expect("pipeline");

        let out = pipeline.upsert("doc", "12345");
        assert!(matches!(out, Err(EmbedError::TextTooLarge { size: 5, max: 4 })));
    }
}
