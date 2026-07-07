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
/// in the NAPI crate after `pipeline.flush()` completes — from this
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
        let base = trimmed.strip_suffix("/api/embeddings").unwrap_or(trimmed);
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
    /// When `true` (default) every mutating call (`upsert*`, `clear`)
    /// triggers `persist_best_effort()` immediately. Bulk callers
    /// (`upsert_many` + `flush`) flip this to `false` to amortize the
    /// per-call full-index rewrite that otherwise turns a 6326-block
    /// rebuild into ~290 GB of disk traffic.
    auto_persist: bool,
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

            let provider =
                std::mem::replace(&mut self.provider, Box::new(ShutdownSentinelProvider));
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

/// NDJSON v2 header — first line of `embed_index.ndjson`.
///
/// The v2 format trades one big `to_string_pretty(EmbedDiskIndexV1)` —
/// quadratic in time when called per insert — for line-delimited writes
/// that scale linearly with corpus size. Each subsequent line is one
/// `EmbedDiskDocV2` JSON object.
///
/// Read path: callers try `embed_index.ndjson` first; if missing, fall
/// back to `embed_index.json` (v1). Write path is gated by env
/// `MEMPHIS_EMBED_DISK_V2=1` so an operator can opt in after one
/// successful rebuild verifies the new format on their corpus.
#[derive(Debug, Serialize, Deserialize)]
struct EmbedDiskHeaderV2 {
    version: u32,
    dim: usize,
}

#[derive(Debug, Serialize, Deserialize)]
struct EmbedDiskDocV2 {
    id: String,
    text: String,
    #[serde(default)]
    vector: Option<Vec<f32>>,
    #[serde(default)]
    tags: Vec<String>,
}

/// Resolve sibling NDJSON path for a given v1 JSON path.
/// `~/.../embed_index.json` → `~/.../embed_index.ndjson`.
fn ndjson_sibling_path(json_path: &Path) -> PathBuf {
    json_path.with_extension("ndjson")
}

/// Read env var to decide whether to write v2 NDJSON.
/// Default off so unmodified deployments keep writing v1 until operator
/// flips the gate.
fn should_write_ndjson_v2() -> bool {
    std::env::var("MEMPHIS_EMBED_DISK_V2")
        .map(|v| matches!(v.trim(), "1" | "true" | "yes" | "on"))
        .unwrap_or(false)
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
            auto_persist: true,
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

    /// Bulk upsert. Iterates `validate → embed → insert` per item without
    /// any per-item disk write — caller MUST call `flush()` (or rely on
    /// a subsequent `auto_persist=true` mutation) to materialize. Fails
    /// fast on the first item that errors; partial state up to the
    /// failure point is left in memory so the caller can decide whether
    /// to retry per-item or roll back.
    ///
    /// Returns the post-upsert total doc count.
    pub fn upsert_many(
        &mut self,
        items: Vec<(String, String, Vec<String>)>,
    ) -> Result<usize, EmbedError> {
        for (id, text, tags) in items {
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
        }
        Ok(self.docs.len())
    }

    /// Toggle the per-call auto-persist flag. With `false`, single-item
    /// `upsert*` calls no longer write to disk — the caller is responsible
    /// for calling `flush()` to materialize. Restores to `true` for clean
    /// sandbox semantics; bulk callers should `set_auto_persist(true)`
    /// after their `flush()`.
    pub fn set_auto_persist(&mut self, on: bool) {
        self.auto_persist = on;
    }

    pub fn auto_persist_enabled(&self) -> bool {
        self.auto_persist
    }

    /// Force a write to disk regardless of `auto_persist`. Surfaces the
    /// I/O error rather than swallowing it — the legacy `persist_best_effort`
    /// path stays silent for backwards-compat with single-item callers
    /// that historically had no recourse on partial failure, but bulk
    /// rebuilders must hear about ENOSPC / EROFS / permission denied.
    pub fn flush(&self) -> Result<(), EmbedError> {
        self.persist_now()
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
        // v2 NDJSON sibling takes precedence — if it exists it's the
        // newer format. A corrupt sibling MUST NOT silently fall back to
        // a stale v1 .json; surface as Corrupt so the operator sees it.
        let ndjson_path = ndjson_sibling_path(index_path);
        if ndjson_path.exists() {
            return match fs::read_to_string(&ndjson_path) {
                Ok(content) => self.parse_ndjson_v2(&content),
                Err(_) => (HashMap::new(), EmbedPersistenceLoadState::Corrupt),
            };
        }

        // Legacy v1 JSON path.
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
            if let Some(materialized) = self.materialize_v1_doc(doc) {
                docs.insert(materialized.id.clone(), materialized);
            }
        }

        (docs, EmbedPersistenceLoadState::Loaded)
    }

    fn parse_ndjson_v2(
        &self,
        content: &str,
    ) -> (HashMap<String, EmbeddedDocument>, EmbedPersistenceLoadState) {
        let mut lines = content.lines();

        let header_line = match lines.next() {
            Some(l) if !l.trim().is_empty() => l,
            // Empty file or whitespace-only first line.
            _ => return (HashMap::new(), EmbedPersistenceLoadState::Empty),
        };

        let header: EmbedDiskHeaderV2 = match serde_json::from_str(header_line) {
            Ok(v) => v,
            Err(_) => return (HashMap::new(), EmbedPersistenceLoadState::Corrupt),
        };

        if header.version != 2 {
            return (HashMap::new(), EmbedPersistenceLoadState::Corrupt);
        }

        let mut docs = HashMap::new();
        for line in lines {
            if line.trim().is_empty() {
                continue;
            }
            let doc: EmbedDiskDocV2 = match serde_json::from_str(line) {
                Ok(v) => v,
                Err(_) => continue, // skip malformed line, keep loading
            };
            if let Some(materialized) = self.materialize_v2_doc(doc) {
                docs.insert(materialized.id.clone(), materialized);
            }
        }

        (docs, EmbedPersistenceLoadState::Loaded)
    }

    fn materialize_v1_doc(&self, doc: EmbedDiskDocV1) -> Option<EmbeddedDocument> {
        if doc.id.trim().is_empty() || doc.text.trim().is_empty() {
            return None;
        }
        if self.validate_text(&doc.text).is_err() {
            return None;
        }

        let vector = match doc.vector {
            Some(existing) if existing.len() == self.config.dim => existing,
            _ => self.provider.embed(&doc.text, self.config.dim).ok()?,
        };

        Some(EmbeddedDocument {
            id: doc.id,
            text: doc.text,
            vector,
            tags: doc.tags,
        })
    }

    fn materialize_v2_doc(&self, doc: EmbedDiskDocV2) -> Option<EmbeddedDocument> {
        if doc.id.trim().is_empty() || doc.text.trim().is_empty() {
            return None;
        }
        if self.validate_text(&doc.text).is_err() {
            return None;
        }

        let vector = match doc.vector {
            Some(existing) if existing.len() == self.config.dim => existing,
            _ => self.provider.embed(&doc.text, self.config.dim).ok()?,
        };

        Some(EmbeddedDocument {
            id: doc.id,
            text: doc.text,
            vector,
            tags: doc.tags,
        })
    }

    /// Backwards-compatible best-effort persist. Gated by `auto_persist`
    /// (default true) — bulk callers flip the flag off and use `flush()`
    /// to materialize once at the end. Errors are swallowed here so a
    /// flapping disk doesn't crash the live `embed_store` path; bulk
    /// rebuilders MUST use `flush()` to surface ENOSPC / EROFS.
    fn persist_best_effort(&self) {
        if !self.auto_persist {
            return;
        }
        let _ = self.persist_now();
    }

    /// Inner persistence work — selects v1 JSON or v2 NDJSON based on
    /// the `MEMPHIS_EMBED_DISK_V2` env gate. Errors are returned so
    /// callers can decide (best-effort silent, or `flush()` surfaces).
    fn persist_now(&self) -> Result<(), EmbedError> {
        let Some(state) = self.persistence.as_ref() else {
            return Ok(());
        };

        let parent = state
            .index_path
            .parent()
            .ok_or_else(|| EmbedError::DiskError("index_path has no parent".to_string()))?;
        fs::create_dir_all(parent).map_err(|e| EmbedError::DiskError(e.to_string()))?;

        if should_write_ndjson_v2() {
            self.persist_now_ndjson_v2(state)
        } else {
            self.persist_now_json_v1(state)
        }
    }

    fn persist_now_json_v1(&self, state: &EmbedPersistenceState) -> Result<(), EmbedError> {
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

        // `to_string` (compact) instead of `to_string_pretty` — pretty-print
        // bloats the file ~4x and roughly doubles serialize time for a
        // machine-read index. The repair-runtime amplification was
        // dominated by the pretty path's allocation pressure on 6326-doc
        // corpora.
        let serialized = serde_json::to_string(&payload)
            .map_err(|e| EmbedError::SerializationError(format!("serialize_failed: {e}")))?;

        let tmp_path = state.index_path.with_extension("tmp");
        fs::write(&tmp_path, serialized.as_bytes())
            .map_err(|e| EmbedError::DiskError(e.to_string()))?;
        fs::rename(&tmp_path, &state.index_path)
            .map_err(|e| EmbedError::DiskError(e.to_string()))?;
        Ok(())
    }

    fn persist_now_ndjson_v2(&self, state: &EmbedPersistenceState) -> Result<(), EmbedError> {
        let ndjson_path = ndjson_sibling_path(&state.index_path);

        // Header line + one line per doc. Atomic via tmp+rename.
        let header = EmbedDiskHeaderV2 {
            version: 2,
            dim: self.config.dim,
        };

        let mut buf = String::new();
        buf.push_str(
            &serde_json::to_string(&header)
                .map_err(|e| EmbedError::SerializationError(format!("header_serialize: {e}")))?,
        );
        buf.push('\n');

        for doc in self.docs.values() {
            let line = EmbedDiskDocV2 {
                id: doc.id.clone(),
                text: doc.text.clone(),
                vector: Some(doc.vector.clone()),
                tags: doc.tags.clone(),
            };
            buf.push_str(
                &serde_json::to_string(&line)
                    .map_err(|e| EmbedError::SerializationError(format!("doc_serialize: {e}")))?,
            );
            buf.push('\n');
        }

        let tmp_path = ndjson_path.with_extension("ndjson.tmp");
        fs::write(&tmp_path, buf.as_bytes()).map_err(|e| EmbedError::DiskError(e.to_string()))?;
        fs::rename(&tmp_path, &ndjson_path).map_err(|e| EmbedError::DiskError(e.to_string()))?;
        Ok(())
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
        EmbedPersistenceLoadState, EmbedPipeline, LocalDeterministicProvider,
        DEFAULT_EMBEDDING_DIM,
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

        let flaky: Box<dyn EmbeddingProvider + Send + Sync> = Box::new(FlakyProvider::default());
        let local: Box<dyn EmbeddingProvider + Send + Sync> = Box::new(LocalDeterministicProvider);
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
        let mut pipeline = EmbedPipeline::new(EmbedConfig::default()).expect("pipeline construct");
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

    // ─── Bulk + flush + NDJSON v2 ────────────────────────────────────────
    //
    // Tests for the 2026-05-10 embed-reindex amplification fix: per-item
    // `upsert*` no longer writes O(N) full-index rewrites; bulk callers
    // use `upsert_many` + `flush()`, NDJSON v2 disk format opt-in via
    // `MEMPHIS_EMBED_DISK_V2=1`.

    static FORMAT_ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    #[test]
    fn auto_persist_false_skips_writes() {
        let path = temp_path("autopersist-skip");
        let mut pipeline = EmbedPipeline::with_persistence(
            EmbedConfig::default(),
            EmbedPersistenceConfig {
                enabled: true,
                index_path: path.clone(),
            },
        )
        .expect("pipeline");

        pipeline.set_auto_persist(false);
        pipeline.upsert("doc-1", "no-write please").expect("upsert");

        assert!(
            !path.exists(),
            "auto_persist=false must not write {} to disk",
            path.display(),
        );

        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn flush_materializes_after_deferred_upserts() {
        let path = temp_path("flush-materialize");
        let mut pipeline = EmbedPipeline::with_persistence(
            EmbedConfig::default(),
            EmbedPersistenceConfig {
                enabled: true,
                index_path: path.clone(),
            },
        )
        .expect("pipeline");

        pipeline.set_auto_persist(false);
        pipeline.upsert("doc-1", "first").expect("upsert");
        pipeline.upsert("doc-2", "second").expect("upsert");
        assert!(!path.exists(), "no per-item write expected before flush");

        pipeline.flush().expect("flush");
        assert!(path.exists(), "flush must materialize {}", path.display());

        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn bulk_upsert_inserts_all_items_under_single_call() {
        let path = temp_path("bulk-upsert");
        let mut pipeline = EmbedPipeline::with_persistence(
            EmbedConfig::default(),
            EmbedPersistenceConfig {
                enabled: true,
                index_path: path.clone(),
            },
        )
        .expect("pipeline");

        let items: Vec<(String, String, Vec<String>)> = (0..50)
            .map(|i| (format!("doc-{i}"), format!("content {i}"), Vec::new()))
            .collect();

        let count = pipeline.upsert_many(items).expect("bulk upsert");
        assert_eq!(count, 50);
        assert_eq!(pipeline.len(), 50);

        // upsert_many on its own does NOT persist — caller must flush.
        // (The disk side-effect from the per-item path is exactly the
        // amplification we're trying to kill.)
        // We don't assert path absence here because the pipeline is
        // mid-config; with auto_persist=true the next mutating call
        // would persist. Just confirm flush works:
        pipeline.flush().expect("flush");
        assert!(path.exists(), "flush after bulk must materialize");

        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn flush_surfaces_disk_error_for_unwritable_path() {
        // /proc is a virtual filesystem; mkdir under it returns EROFS,
        // surfacing the I/O error path that legacy `persist_best_effort`
        // used to swallow.
        let path = std::path::PathBuf::from("/proc/memphis-embed-readonly/embed_index.json");
        let pipeline = EmbedPipeline::with_persistence(
            EmbedConfig::default(),
            EmbedPersistenceConfig {
                enabled: true,
                index_path: path,
            },
        )
        .expect("pipeline construct");

        let result = pipeline.flush();
        assert!(
            result.is_err(),
            "flush to /proc/... must surface the disk error, got {:?}",
            result,
        );
    }

    #[test]
    fn ndjson_v2_roundtrip_when_env_enabled() {
        let _guard = FORMAT_ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let path = temp_path("ndjson-roundtrip");
        let prev = std::env::var("MEMPHIS_EMBED_DISK_V2").ok();
        std::env::set_var("MEMPHIS_EMBED_DISK_V2", "1");

        // Scope so the first pipeline drops before reading state back.
        {
            let mut first = EmbedPipeline::with_persistence(
                EmbedConfig::default(),
                EmbedPersistenceConfig {
                    enabled: true,
                    index_path: path.clone(),
                },
            )
            .expect("first pipeline");
            first.upsert("doc-x", "ndjson v2 contents").expect("upsert");
        }

        // The v2 sibling MUST exist; the v1 .json MUST NOT (we never
        // touched the v1 path in this run).
        let ndjson_path = path.with_extension("ndjson");
        assert!(
            ndjson_path.exists(),
            "v2 mode must write {}",
            ndjson_path.display(),
        );
        assert!(
            !path.exists(),
            "v2 mode must NOT also write v1 sibling {}",
            path.display(),
        );

        // A second pipeline reads the v2 file back via load_docs_from_disk.
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
            EmbedPersistenceLoadState::Loaded,
        );
        assert_eq!(second.len(), 1);

        // Restore env + cleanup.
        match prev {
            Some(v) => std::env::set_var("MEMPHIS_EMBED_DISK_V2", v),
            None => std::env::remove_var("MEMPHIS_EMBED_DISK_V2"),
        }
        let _ = std::fs::remove_file(&ndjson_path);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn ndjson_v2_falls_back_to_v1_when_ndjson_missing() {
        // Hand-craft a v1 file with no .ndjson sibling — load path must
        // pick up v1 transparently.
        let path = temp_path("v1-fallback");
        let payload = serde_json::json!({
            "version": 1,
            "dim": DEFAULT_EMBEDDING_DIM,
            "docs": [
                {
                    "id": "doc-only-v1",
                    "text": "fallback content",
                    "vector": null,
                    "tags": ["legacy"],
                }
            ],
        });
        std::fs::write(&path, serde_json::to_string(&payload).unwrap()).expect("write v1");

        // Defensive: ensure no stray ndjson from a flaky earlier run.
        let ndjson_path = path.with_extension("ndjson");
        let _ = std::fs::remove_file(&ndjson_path);

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
            EmbedPersistenceLoadState::Loaded,
        );
        assert_eq!(pipeline.len(), 1);

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn ndjson_v2_corrupt_does_not_silently_fall_back_to_v1() {
        // If both .ndjson and .json exist and .ndjson is unreadable JSON,
        // we MUST NOT silently load the v1 — that would mask data loss
        // (operator wrote v2, v2 corrupted, falling back to a stale v1
        // would diverge in-memory state from the operator's last write).
        let _guard = FORMAT_ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let path = temp_path("v2-corrupt");
        let ndjson_path = path.with_extension("ndjson");

        // Stale v1 (looks valid).
        let v1_payload = serde_json::json!({
            "version": 1,
            "dim": DEFAULT_EMBEDDING_DIM,
            "docs": [],
        });
        std::fs::write(&path, serde_json::to_string(&v1_payload).unwrap()).expect("write v1");

        // Corrupt v2 sibling.
        std::fs::write(&ndjson_path, "{ not valid header\n").expect("write corrupt v2");

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
            EmbedPersistenceLoadState::Corrupt,
            "corrupt v2 must surface as Corrupt, not silently load v1",
        );

        let _ = std::fs::remove_file(&ndjson_path);
        let _ = std::fs::remove_file(&path);
    }
}
