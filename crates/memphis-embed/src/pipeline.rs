use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::error::EmbedError;

/// Process-wide shutdown barrier. When `true`, `EmbedPipeline::drop`
/// becomes a no-op for heap-heavy fields — the heavy state (`docs`
/// HashMap, `provider` Box<dyn>) is leaked rather than freed because
/// the V8↔libc dlclose ordering at process exit is unsafe to free
/// heap allocations through (the global allocator's TLS may already
/// be invalidated when `dlclose` runs static destructors).
///
/// The leak is one-time per process exit; the OS reclaims memory
/// on termination. Crucially this is a **defensive** measure — it
/// activates only when an explicit shutdown signal is recorded via
/// `set_shutdown_barrier()`. Normal Drop paths (test cleanup, in-tree
/// EmbedPipeline construction/destruction inside the same process)
/// run the full Drop and free heap normally.
///
/// Pattern intent: any future static with a non-trivial Drop in
/// memphis-* crates should follow the same convention — check this
/// barrier in its Drop impl and skip work that could race the
/// allocator/libc teardown. See `docs/dev/SHUTDOWN-LIFECYCLE.md`.
pub static SHUTDOWN_BARRIER: AtomicBool = AtomicBool::new(false);

/// Set the process-wide shutdown barrier. Called by `embed_shutdown()`
/// in the NAPI crate after `pipeline.clear()` completes — from this
/// point on, any subsequent Drop of an EmbedPipeline (including the
/// implicit Drop of the OnceLock<Mutex<EmbedPipeline>> static at
/// `dlclose` time) leaks the heavy fields rather than freeing them.
///
/// Idempotent — repeated calls are no-ops.
pub fn set_shutdown_barrier() {
    SHUTDOWN_BARRIER.store(true, Ordering::Release);
}

/// Read the current shutdown-barrier state. Production code should not
/// branch on this; it exists for tests + diagnostics.
pub fn is_shutdown_barrier_set() -> bool {
    SHUTDOWN_BARRIER.load(Ordering::Acquire)
}

/// Test-only seam to clear the barrier. Production code never resets
/// the barrier — once shutdown is signalled, it stays signalled for
/// the rest of the process. The reset exists so unit tests that flip
/// the barrier don't pollute sibling tests in the same process (the
/// Cargo test runner shares one process across all tests in a crate).
///
/// `cfg(test)` covers the in-crate use today. If a downstream crate
/// later needs the same reset for its own integration tests, declare
/// a Cargo feature here (e.g. `test-utils`) and gate this fn on
/// `cfg(any(test, feature = "test-utils"))` instead.
#[cfg(test)]
pub fn __reset_shutdown_barrier_for_tests() {
    SHUTDOWN_BARRIER.store(false, Ordering::Release);
}

pub const DEFAULT_EMBEDDING_DIM: usize = 32;
pub const DEFAULT_MAX_TEXT_BYTES: usize = 4096;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EmbedMode {
    LocalDeterministic,
    Provider(String),
    /// Try each mode in order, falling back to the next on error.
    /// The first successful response wins. The cascade's effective
    /// provider name at runtime is the name of the inner provider
    /// that actually produced the embedding.
    ///
    /// Introduced for N21 (Y1 roadmap): lets operators configure
    /// `[kartograf, nomic-embed, local-deterministic]` so a Kartograf
    /// miss transparently falls back to nomic, with
    /// `LocalDeterministic` as the unconditional floor.
    Cascade(Vec<EmbedMode>),
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

/// Sanitise text before sending to a remote embedding provider.
///
/// Ollama's `nomic-embed-text` (and several other providers) returns
/// HTTP 500 on prompts containing certain control characters or
/// pathological whitespace patterns. Operator session 2026-05-05
/// caught the rebuild aborting on the first such block — the whole
/// chain corpus stayed un-indexed (`vectors≈0`).
///
/// Rules:
/// - Strip ASCII control chars (U+0000..U+001F) except common
///   whitespace (`\t \n \r`) — those are safe and preserve semantics.
/// - Drop the Unicode replacement character (U+FFFD) which signals
///   prior decode failure.
/// - Collapse runs of more than 4 consecutive whitespace chars.
/// - Truncate to `max_bytes` at a Unicode char boundary so we don't
///   hand the provider an invalid UTF-8 slice.
pub(crate) fn sanitize_for_embed(text: &str, max_bytes: usize) -> String {
    let mut out = String::with_capacity(text.len().min(max_bytes));
    let mut consecutive_ws = 0usize;
    for ch in text.chars() {
        if ch == '\u{FFFD}' {
            continue;
        }
        if (ch as u32) < 0x20 && ch != '\t' && ch != '\n' && ch != '\r' {
            continue;
        }
        if ch.is_whitespace() {
            consecutive_ws += 1;
            if consecutive_ws > 4 {
                continue;
            }
        } else {
            consecutive_ws = 0;
        }
        // Char boundary aware: only push if the resulting byte length
        // stays within max_bytes.
        let needed = ch.len_utf8();
        if out.len() + needed > max_bytes {
            break;
        }
        out.push(ch);
    }
    out
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
        // Sanitise + cap. 16384 bytes is the upstream-config max; we
        // re-cap here so a stale config or a direct call past the
        // pipeline's validate_text() can't blow up the provider.
        let prompt = sanitize_for_embed(text, 16384);
        if prompt.trim().is_empty() {
            return Err(EmbedError::EmptyInput);
        }
        let payload = serde_json::json!({
            "model": &self.model,
            "prompt": prompt,
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

/// Defensive Drop. When `SHUTDOWN_BARRIER` is set (i.e. `embed_shutdown()`
/// has run and the process is winding down), leak the heap-heavy fields
/// rather than free them. The implicit Drop of `EMBED_PIPELINE` at
/// `dlclose` time would otherwise call `HashMap::drop` (frees buckets +
/// entries) and `Box<dyn>::drop` (frees the inner provider state) on a
/// global allocator whose TLS may already be invalidated by libc /
/// V8 teardown — the original BUG3 SEGV signature.
///
/// Outside the shutdown barrier the Drop is a no-op wrapper — fields
/// drop in declaration order with their normal semantics. This means
/// in-test EmbedPipeline lifecycles (construct, use, drop) free heap
/// normally and leak detectors continue to work.
impl Drop for EmbedPipeline {
    fn drop(&mut self) {
        if SHUTDOWN_BARRIER.load(Ordering::Acquire) {
            // Take ALL heap-backed fields out and forget them. The
            // remaining (empty) struct drops trivially when the
            // automatic field-drop runs after this returns.
            //
            // Codex Round 1 #534: original implementation only forgot
            // `docs` and `provider`. But `config` carries Strings (the
            // Provider URL/api-key/model under EmbedMode::Provider, plus
            // EmbedMode::Cascade Vec<EmbedMode>) and `persistence`
            // carries a PathBuf — all of those would still be freed by
            // the field-drop pass on a teardown-state allocator,
            // partially defeating the barrier. Replacing each with a
            // freshly-defaulted value moves the heap allocations into
            // forgotten owners; the field-drop pass then only frees
            // the trivial defaults.
            let docs = std::mem::take(&mut self.docs);
            std::mem::forget(docs);

            let provider = std::mem::replace(
                &mut self.provider,
                Box::new(ShutdownSentinelProvider),
            );
            std::mem::forget(provider);

            let config = std::mem::take(&mut self.config);
            std::mem::forget(config);

            let persistence = self.persistence.take();
            std::mem::forget(persistence);
        }
        // else: normal Drop semantics — fields drop in declaration order
        // when this method returns.
    }
}

/// Zero-state placeholder swapped in for `EmbedPipeline.provider` during
/// the shutdown-barrier Drop path. It implements `EmbeddingProvider`
/// only so the type matches; calling `embed()` on it would error
/// because it has no concrete embedding source. Reach is bounded — by
/// the time it's swapped in, the process is exiting and nothing else
/// will call into the pipeline.
struct ShutdownSentinelProvider;

impl EmbeddingProvider for ShutdownSentinelProvider {
    fn embed(&self, _text: &str, _dim: usize) -> Result<Vec<f32>, EmbedError> {
        Err(EmbedError::ProviderUnavailable(
            "shutdown sentinel — process is exiting".into(),
        ))
    }

    fn name(&self) -> &str {
        "shutdown-sentinel"
    }
}

/// Cascade wrapper — tries each inner provider in order, returning the
/// first successful embedding. The provider `name()` reflects the
/// configured cascade tail (e.g. `cascade[kartograf,nomic,local]`)
/// so observers can correlate this pipeline with its configuration;
/// per-call attribution (which inner provider answered) is planned
/// for the N21 follow-up alongside latency stats.
pub struct CascadeProvider {
    label: String,
    inner: Vec<Box<dyn EmbeddingProvider + Send + Sync>>,
}

impl CascadeProvider {
    fn new(inner: Vec<Box<dyn EmbeddingProvider + Send + Sync>>) -> Self {
        let names: Vec<&str> = inner.iter().map(|p| p.name()).collect();
        let label = format!("cascade[{}]", names.join(","));
        Self { label, inner }
    }
}

impl EmbeddingProvider for CascadeProvider {
    fn name(&self) -> &str {
        &self.label
    }

    fn embed(&self, text: &str, dim: usize) -> Result<Vec<f32>, EmbedError> {
        let mut last_err: Option<EmbedError> = None;
        for provider in &self.inner {
            match provider.embed(text, dim) {
                Ok(vec) => return Ok(vec),
                Err(err) => last_err = Some(err),
            }
        }
        Err(last_err.unwrap_or_else(|| {
            EmbedError::ProviderUnavailable("cascade has no inner providers".to_string())
        }))
    }
}

/// Max nesting depth for `Cascade` — generous for any real-world
/// configuration (operators compose 2-3 levels in practice) but
/// finite so a malformed/hostile config can't stack-overflow the
/// pipeline builder.
const CASCADE_MAX_DEPTH: usize = 8;

/// Recursive provider builder. Keeps nested cascades legal
/// (e.g. `Cascade([kartograf, Cascade([nomic, minilm]), local])`)
/// so operators can compose tiered fallback chains without a rewrite
/// of the enum. Depth-bounded to prevent stack exhaustion.
fn build_provider(
    mode: &EmbedMode,
    config: &EmbedConfig,
) -> Result<Box<dyn EmbeddingProvider + Send + Sync>, EmbedError> {
    build_provider_at_depth(mode, config, 0)
}

fn build_provider_at_depth(
    mode: &EmbedMode,
    config: &EmbedConfig,
    depth: usize,
) -> Result<Box<dyn EmbeddingProvider + Send + Sync>, EmbedError> {
    if depth > CASCADE_MAX_DEPTH {
        return Err(EmbedError::ProviderUnavailable(format!(
            "cascade nesting exceeds max depth {CASCADE_MAX_DEPTH}"
        )));
    }
    match mode {
        EmbedMode::LocalDeterministic => Ok(Box::new(LocalDeterministicProvider)),
        EmbedMode::Provider(name) => match name.as_str() {
            "ollama" => Ok(Box::new(OllamaProvider::new(config)?)),
            "openai-compatible" | "cohere" | "voyage" | "jina" | "mistral" | "together"
            | "nvidia" | "mixedbread" => Ok(Box::new(GenericOpenAIProvider::new(config, name)?)),
            other => Err(EmbedError::ProviderUnavailable(format!(
                "unknown provider: {other}"
            ))),
        },
        EmbedMode::Cascade(modes) => {
            if modes.is_empty() {
                return Err(EmbedError::ProviderUnavailable(
                    "cascade mode requires at least one inner mode".to_string(),
                ));
            }
            let mut inner: Vec<Box<dyn EmbeddingProvider + Send + Sync>> =
                Vec::with_capacity(modes.len());
            for m in modes {
                inner.push(build_provider_at_depth(m, config, depth + 1)?);
            }
            Ok(Box::new(CascadeProvider::new(inner)))
        }
    }
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

        let provider = build_provider(&config.mode, &config)?;

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
        sanitize_for_embed, CascadeProvider, EmbedConfig, EmbedMode, EmbedPersistenceConfig,
        EmbedPersistenceLoadState, EmbedPipeline, LocalDeterministicProvider, DEFAULT_EMBEDDING_DIM,
    };
    use crate::{EmbedError, EmbeddingProvider};

    #[test]
    fn sanitize_strips_control_chars_and_keeps_whitespace() {
        let raw = "hello\x00\x01world\twith\nnewlines\rand\x1Fcontrol";
        let cleaned = sanitize_for_embed(raw, 1024);
        assert_eq!(cleaned, "helloworld\twith\nnewlines\randcontrol");
    }

    #[test]
    fn sanitize_drops_replacement_character() {
        let raw = "before\u{FFFD}after";
        assert_eq!(sanitize_for_embed(raw, 1024), "beforeafter");
    }

    #[test]
    fn sanitize_collapses_runs_of_whitespace() {
        let raw = "a          b"; // 10 spaces — keep first 4, drop rest
        assert_eq!(sanitize_for_embed(raw, 1024), "a    b");
    }

    #[test]
    fn sanitize_truncates_at_char_boundary_not_byte_split() {
        // Polish "ąćęłńóśźż" — each is 2 bytes UTF-8.
        let raw = "ąćęłńóśźż"; // 18 bytes, 9 chars
        let truncated = sanitize_for_embed(raw, 5);
        // We cannot fit 3 full chars (6 bytes); cap is 4 bytes = 2 chars.
        assert_eq!(truncated.len(), 4);
        assert!(truncated.chars().all(|c| !c.is_ascii_control()));
        // No partial bytes — string is valid UTF-8 by construction.
        assert!(std::str::from_utf8(truncated.as_bytes()).is_ok());
    }

    #[test]
    fn sanitize_preserves_normal_text() {
        let raw = "Memphis chains test 2026 — pl_PL";
        assert_eq!(sanitize_for_embed(raw, 1024), raw);
    }

    #[test]
    fn sanitize_returns_empty_for_pure_control_input() {
        let raw = "\x00\x01\x02\x03";
        assert_eq!(sanitize_for_embed(raw, 1024), "");
    }

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
    fn cascade_empty_is_rejected() {
        let out = EmbedPipeline::new(EmbedConfig {
            mode: EmbedMode::Cascade(vec![]),
            ..EmbedConfig::default()
        });
        assert!(matches!(out, Err(EmbedError::ProviderUnavailable(_))));
    }

    #[test]
    fn cascade_single_local_behaves_like_local() {
        let mut pipeline = EmbedPipeline::new(EmbedConfig {
            mode: EmbedMode::Cascade(vec![EmbedMode::LocalDeterministic]),
            ..EmbedConfig::default()
        })
        .expect("cascade pipeline");
        pipeline.upsert("doc-1", "hello").expect("upsert");
        let hits = pipeline.search("hello", 1).expect("search");
        assert_eq!(hits.len(), 1);
        assert!(pipeline.provider_name().starts_with("cascade["));
    }

    #[test]
    fn cascade_falls_back_when_first_provider_errors() {
        use std::sync::Mutex;
        // Counting provider that always fails — simulates Kartograf /
        // nomic being unavailable so the cascade tail (local
        // deterministic) must answer.
        #[derive(Default)]
        struct FlakyProvider {
            calls: Mutex<u32>,
        }
        impl EmbeddingProvider for FlakyProvider {
            fn name(&self) -> &str {
                "flaky-test"
            }
            fn embed(&self, _text: &str, _dim: usize) -> Result<Vec<f32>, EmbedError> {
                *self.calls.lock().unwrap() += 1;
                Err(EmbedError::ProviderUnavailable("flaky".to_string()))
            }
        }

        let flaky: Box<dyn EmbeddingProvider + Send + Sync> =
            Box::new(FlakyProvider::default());
        let local: Box<dyn EmbeddingProvider + Send + Sync> =
            Box::new(LocalDeterministicProvider);
        let cascade = CascadeProvider::new(vec![flaky, local]);
        let out = cascade.embed("fallback works", DEFAULT_EMBEDDING_DIM);
        assert!(out.is_ok());
        assert_eq!(out.unwrap().len(), DEFAULT_EMBEDDING_DIM);
    }

    #[test]
    fn cascade_nested_is_legal() {
        let mode = EmbedMode::Cascade(vec![
            EmbedMode::Cascade(vec![EmbedMode::LocalDeterministic]),
            EmbedMode::LocalDeterministic,
        ]);
        let pipeline = EmbedPipeline::new(EmbedConfig {
            mode,
            ..EmbedConfig::default()
        });
        assert!(pipeline.is_ok(), "nested cascades should compose");
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

    // ─── Shutdown barrier (Track B, issue #270) ──────────────────────────
    //
    // The barrier is process-wide and one-way in production. These
    // tests flip the global flag, so they MUST run serialised even
    // though Cargo's default test runner uses thread-pool parallelism.
    // Codex Round 1 #534 caught the gap: without the mutex, one test
    // would clear the flag while another expected it set, producing
    // intermittent failures.
    //
    // The mutex is acquired at the start of each test and released
    // automatically when the guard goes out of scope. We avoid pulling
    // in `serial_test` as a dev-dep — std::sync::Mutex is enough.

    static BARRIER_TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    #[test]
    fn shutdown_barrier_starts_unset_and_is_idempotent() {
        let _guard = BARRIER_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        super::__reset_shutdown_barrier_for_tests();
        assert!(!super::is_shutdown_barrier_set());
        super::set_shutdown_barrier();
        assert!(super::is_shutdown_barrier_set());
        super::set_shutdown_barrier(); // idempotent
        assert!(super::is_shutdown_barrier_set());
        super::__reset_shutdown_barrier_for_tests();
    }

    #[test]
    fn embed_pipeline_drop_with_barrier_set_does_not_panic() {
        let _guard = BARRIER_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        // Construct, populate, set barrier, drop. The Drop path swaps
        // `docs` for an empty HashMap and `provider` for a sentinel,
        // forgets the originals. We assert the pipeline drops without
        // panicking — the leak itself is unobservable from inside the
        // process by design (the OS reclaims at process exit).
        super::__reset_shutdown_barrier_for_tests();
        let mut pipeline =
            EmbedPipeline::new(EmbedConfig::default()).expect("pipeline construct");
        pipeline
            .upsert("doc-1", "the quick brown fox")
            .expect("upsert");
        assert_eq!(pipeline.len(), 1);

        super::set_shutdown_barrier();
        // Drop runs at end of scope. We wrap in a closure so any panic
        // surfaces to the test harness rather than aborting the process.
        let dropper = std::panic::AssertUnwindSafe(move || drop(pipeline));
        let outcome = std::panic::catch_unwind(dropper);
        assert!(outcome.is_ok(), "Drop with barrier set must not panic");

        super::__reset_shutdown_barrier_for_tests();
    }

    #[test]
    fn embed_pipeline_drop_without_barrier_runs_normal_cleanup() {
        let _guard = BARRIER_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        // The complement: when the barrier is unset, Drop runs the
        // normal field-by-field destructor path. We assert by storing
        // and dropping a pipeline twice in the same test — if Drop
        // were leaking the heap globally even without the barrier, a
        // memory leak detector would catch it across many tests, but
        // we settle here for "doesn't panic + barrier remains unset".
        super::__reset_shutdown_barrier_for_tests();
        {
            let mut pipeline =
                EmbedPipeline::new(EmbedConfig::default()).expect("pipeline construct");
            pipeline.upsert("doc-a", "first").expect("upsert");
            // Pipeline drops at end of inner scope.
        }
        assert!(!super::is_shutdown_barrier_set());
        {
            let mut pipeline =
                EmbedPipeline::new(EmbedConfig::default()).expect("pipeline construct");
            pipeline.upsert("doc-b", "second").expect("upsert");
        }
        assert!(!super::is_shutdown_barrier_set());
    }
}
