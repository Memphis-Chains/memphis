use std::collections::HashMap;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::error::EmbedError;
use crate::lockfile::IndexFileLock;

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

#[derive(Clone)]
pub struct EmbedConfig {
    pub mode: EmbedMode,
    pub dim: usize,
    pub max_text_bytes: usize,
    pub provider_url: Option<String>,
    pub provider_api_key: Option<String>,
    pub provider_model: Option<String>,
    pub provider_timeout_ms: u64,
    /// Ollama `keep_alive` for the provider request body.
    ///
    /// Without this field the Rust provider omitted `keep_alive` entirely,
    /// so Ollama fell back to its 5-minute idle unload. A rebuild that
    /// embeds ~80 chunks then paid a cold model load on EVERY request:
    /// measured 18-39 s per embed (2026-10-24), so a journal reindex took
    /// ~30 minutes instead of ~2. The TypeScript provider has sent
    /// `keep_alive` since the beginning (`src/providers/index.ts`); this
    /// mirrors that behaviour on the Rust side.
    pub provider_keep_alive: Option<String>,
}

// Debug is a diagnostic projection; serialized credential contracts stay unchanged.
impl std::fmt::Debug for EmbedConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let mode = match &self.mode {
            EmbedMode::LocalDeterministic => "local-deterministic",
            EmbedMode::Provider(_) => "provider",
            EmbedMode::Cascade(_) => "cascade",
        };
        f.debug_struct("EmbedConfig")
            .field("mode", &mode)
            .field("dim", &self.dim)
            .field("max_text_bytes", &self.max_text_bytes)
            .field("provider_timeout_ms", &self.provider_timeout_ms)
            .finish_non_exhaustive()
    }
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
            provider_keep_alive: None,
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
    /// Why the last load failed. Kept so `search` can report WHY it
    /// refuses to answer instead of returning an empty recall.
    last_error: Option<String>,
}

/// The outcome of loading the persisted index.
struct LoadedIndex {
    docs: HashMap<String, EmbeddedDocument>,
    state: EmbedPersistenceLoadState,
    /// Identity of the file the bytes came from — `None` when there is
    /// no file at all.
    fingerprint: Option<IndexFingerprint>,
    /// Why the load failed, when it did.
    error: Option<String>,
}

/// Is this path a v2 NDJSON index?
fn is_ndjson_path(path: &Path) -> bool {
    path.extension().and_then(|ext| ext.to_str()) == Some("ndjson")
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
    keep_alive: Option<String>,
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
            keep_alive: config
                .provider_keep_alive
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_string),
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

/// Build the Ollama embeddings request body.
///
/// `keep_alive` is optional on purpose: when it is absent the body must
/// stay exactly `{model, prompt}` so the server keeps its own default
/// (5-minute idle unload). When present it keeps the model resident
/// between requests — see `EmbedConfig::provider_keep_alive`.
pub(crate) fn ollama_embed_payload(
    model: &str,
    prompt: &str,
    keep_alive: Option<&str>,
) -> serde_json::Value {
    let mut payload = serde_json::json!({
        "model": model,
        "prompt": prompt,
    });
    if let Some(keep_alive) = keep_alive.map(str::trim).filter(|v| !v.is_empty()) {
        payload["keep_alive"] = serde_json::Value::String(keep_alive.to_string());
    }
    payload
}

/// Parse and validate a provider-returned embedding array.
///
/// A provider that answers with the wrong model — or with a model
/// whose output width does not match the configured `dim` — used to
/// be silently "repaired" here: the vector was truncated to `dim` and
/// padded with zeros. That made an incompatible embedding look
/// compatible, so a misconfigured provider filled the index with
/// half-real / half-zero vectors and search results were quietly
/// garbage instead of loudly wrong.
///
/// This helper is strict instead:
/// - the array length must equal `expected_dim` exactly,
/// - every element must be a JSON number (no strings, booleans or
///   nulls),
/// - the number must be finite *before* the conversion and must stay
///   finite *after* it — a value such as `1e300` is finite in `f64`
///   but becomes infinity in `f32` and would poison every dot
///   product downstream.
///
/// Error messages carry only the provider name, the expected/actual
/// dimension, or the offending component *index* — never the vector
/// contents and never the embedded input text.
pub(crate) fn parse_embedding_vector(
    provider: &str,
    values: &[serde_json::Value],
    expected_dim: usize,
) -> Result<Vec<f32>, EmbedError> {
    if expected_dim == 0 {
        return Err(EmbedError::InvalidDimension(expected_dim));
    }

    let actual_dim = values.len();
    if actual_dim == 0 {
        return Err(EmbedError::ProviderResponse(format!(
            "{provider} returned empty embedding"
        )));
    }
    if actual_dim != expected_dim {
        return Err(EmbedError::ProviderResponse(format!(
            "{provider} returned embedding dimension {actual_dim}, expected {expected_dim}"
        )));
    }

    let mut vector = Vec::with_capacity(actual_dim);
    for (index, value) in values.iter().enumerate() {
        let number = value.as_f64().ok_or_else(|| {
            EmbedError::ProviderResponse(format!(
                "{provider} returned a non-numeric embedding component at index {index}"
            ))
        })?;
        vector.push(validate_embedding_component(provider, index, number)?);
    }
    Ok(vector)
}

/// Narrow one provider-supplied component to `f32`, rejecting values
/// that are not finite before *or* after the conversion.
pub(crate) fn validate_embedding_component(
    provider: &str,
    index: usize,
    number: f64,
) -> Result<f32, EmbedError> {
    if !number.is_finite() {
        return Err(EmbedError::ProviderResponse(format!(
            "{provider} returned a non-finite embedding component at index {index}"
        )));
    }
    let converted = number as f32;
    if !converted.is_finite() {
        return Err(EmbedError::ProviderResponse(format!(
            "{provider} returned an out-of-range embedding component at index {index}"
        )));
    }
    Ok(converted)
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
        let payload = ollama_embed_payload(&self.model, &prompt, self.keep_alive.as_deref());

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

        // Strict: the returned width must match the configured dim and
        // every component must be a finite number. No truncation, no
        // zero padding — a wrong model must fail loudly instead of
        // producing a plausible-looking but incompatible vector.
        parse_embedding_vector("ollama", embedding, dim)
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

        // Strict: the returned width must match the configured dim and
        // every component must be a finite number. No truncation, no
        // zero padding — a wrong model must fail loudly instead of
        // producing a plausible-looking but incompatible vector.
        parse_embedding_vector(&self.provider_name, embedding, dim)
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
    /// persists immediately. Bulk callers (`upsert_many` + `flush`) flip
    /// this to `false` to amortize the per-call full-index rewrite that
    /// otherwise turns a 6326-block rebuild into ~290 GB of disk
    /// traffic.
    auto_persist: bool,
    /// Documents added or updated in memory that are not yet on disk.
    ///
    /// The persist path merges ONLY these entries into the latest
    /// persisted index (read under the cross-process advisory lock).
    /// Merging the whole in-memory snapshot instead is what let two
    /// processes overwrite each other: each held a stale copy of the
    /// index and wrote it back whole.
    pending: HashMap<String, EmbeddedDocument>,
    /// Fingerprint of the index file as of the last load / write /
    /// refresh. Used to skip needless large-index reloads and to detect
    /// conflicting writes made by another process.
    observed_fingerprint: Option<IndexFingerprint>,
    /// State of an explicit replacement of the index (clear / rebuild).
    ///
    /// A replacement writes the in-memory set as the complete new index
    /// — but only if nobody else wrote to the index since we last read
    /// it. While a replacement is in flight, ordinary merge-persists
    /// are refused: they would publish the half-finished rebuild and
    /// cancel the replacement.
    replacement_state: ReplacementState,
}

/// Lifecycle of an explicit index replacement.
///
/// `Armed` → the next flush publishes the in-memory set as the
/// complete new index. `Failed` → the last replacement attempt
/// failed, so the in-memory contents may be a partial rebuild and
/// NOTHING may be published until the caller explicitly re-arms the
/// replacement (`clear_in_memory_only`) or discards it
/// (`discard_replacement`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReplacementState {
    Idle,
    Armed,
    Failed,
}

/// What a shutdown flush actually did.
///
/// The distinction matters to the caller: a `Flushed` outcome means the
/// persisted index now contains the pending work, while a
/// `DiscardedReplacement` outcome means the pending work was DELIBERATELY
/// NOT written because it was a partial rebuild.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ShutdownFlushOutcome {
    /// Persistence is disabled — there was nothing to write.
    Noop,
    /// Ordinary pending entries were merged into the persisted index.
    Flushed,
    /// An armed or failed replacement was DISCARDED instead of
    /// published: the interrupted rebuild was not written.
    DiscardedReplacement(ReplacementState),
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

/// The index file that is authoritative right now.
///
/// The v2 NDJSON sibling takes precedence over the v1 JSON file. When
/// both exist the NDJSON file is the newer one — and it is also the
/// file every writer must update, otherwise a v1 write would be
/// shadowed by the stale v2 sibling on the next load.
fn active_index_path(index_path: &Path) -> PathBuf {
    let ndjson = ndjson_sibling_path(index_path);
    if ndjson.exists() {
        return ndjson;
    }
    index_path.to_path_buf()
}

/// Where the next write must land. Keeping the writer and the reader
/// on the same file is what stops a write from being shadowed by a
/// stale sibling.
fn resolve_write_target(index_path: &Path) -> PathBuf {
    let ndjson = ndjson_sibling_path(index_path);
    if ndjson.exists() || should_write_ndjson_v2() {
        return ndjson;
    }
    index_path.to_path_buf()
}

/// Cheap identity of an index file — used to skip needless large-index
/// reloads.
///
/// Device + inode are part of it because app writers publish through an
/// atomic `rename`: the inode moves on every publish, so two files
/// with the same size and mtime are still distinguishable.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct IndexStat {
    len: u64,
    mtime_ns: u128,
    dev: u64,
    ino: u64,
}

/// Authoritative identity of an index file: the cheap stat identity
/// PLUS a cryptographic digest of the bytes that were actually read.
///
/// The stat part alone cannot detect a change that preserves size and
/// mtime — and a publish through `rename` keeps the size while the
/// inode moves. The digest closes that hole: the bytes that were
/// parsed and the fingerprint that was recorded always describe the
/// same file.
#[derive(Debug, Clone, PartialEq, Eq)]
struct IndexFingerprint {
    stat: IndexStat,
    digest: [u8; 32],
}

/// SHA-256 of the index bytes.
///
/// Used for replacement-conflict detection: two writers that published
/// different content always disagree here, even when the size and the
/// mtime are identical.
fn digest_of(bytes: &[u8]) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    let out = hasher.finalize();
    let mut digest = [0u8; 32];
    digest.copy_from_slice(&out);
    digest
}

/// Device + inode of a file, when the platform exposes them.
#[cfg(unix)]
fn device_inode(metadata: &fs::Metadata) -> (u64, u64) {
    use std::os::unix::fs::MetadataExt;
    (metadata.dev(), metadata.ino())
}

#[cfg(not(unix))]
fn device_inode(_metadata: &fs::Metadata) -> (u64, u64) {
    (0, 0)
}

/// Cheap stat-only identity of `path`.
fn stat_of(path: &Path) -> Option<IndexStat> {
    let metadata = fs::metadata(path).ok()?;
    Some(stat_from_metadata(&metadata))
}

fn stat_from_metadata(metadata: &fs::Metadata) -> IndexStat {
    let mtime_ns = metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|delta| delta.as_nanos())
        .unwrap_or(0);
    let (dev, ino) = device_inode(metadata);
    IndexStat {
        len: metadata.len(),
        mtime_ns,
        dev,
        ino,
    }
}

/// Read the index bytes together with the identity of the EXACT file
/// those bytes came from.
///
/// The stat is taken from the open descriptor (`fstat`), never from a
/// second `stat` of the path: an atomic `rename` between the two would
/// otherwise pair the old bytes with the new file's identity.
fn read_index_bytes(path: &Path) -> Result<Option<(String, IndexFingerprint)>, EmbedError> {
    let mut file = match fs::File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            return Err(EmbedError::DiskError(format!(
                "index_read_failed: {}: {error}",
                path.display()
            )))
        }
    };

    let metadata = file.metadata().map_err(|error| {
        EmbedError::DiskError(format!("index_stat_failed: {}: {error}", path.display()))
    })?;
    let stat = stat_from_metadata(&metadata);

    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes).map_err(|error| {
        EmbedError::DiskError(format!("index_read_failed: {}: {error}", path.display()))
    })?;

    let digest = digest_of(&bytes);
    let content = String::from_utf8(bytes).map_err(|_| {
        EmbedError::SerializationError(format!("index_not_utf8: {}", path.display()))
    })?;

    Ok(Some((content, IndexFingerprint { stat, digest })))
}

/// Atomic index write: temp file → rename → verify.
fn write_index_file(target: &Path, content: &str) -> Result<(), EmbedError> {
    let tmp_path = unique_tmp_path(target);
    fs::write(&tmp_path, content.as_bytes()).map_err(|e| {
        EmbedError::DiskError(format!("index_write_failed: {}: {e}", tmp_path.display()))
    })?;
    if let Err(error) = fs::rename(&tmp_path, target) {
        // Best-effort cleanup: the rename failed, so the temp file is
        // still ours and would otherwise linger next to the index.
        let _ = fs::remove_file(&tmp_path);
        return Err(EmbedError::DiskError(format!(
            "index_rename_failed: {}: {error}",
            target.display()
        )));
    }
    verify_persisted_index(target, content)
}

/// Build a collision-free temp path for an atomic index write.
///
/// Two processes can persist the same index concurrently (the Rust
/// operator runtime and the TS/CLI path both reach this crate through
/// the napi bridge). A shared `index-v1.tmp` lets one process's
/// `write` interleave with another's, so the later `rename` can move a
/// file that contains the other process's bytes.
///
/// Naming the temp after pid + nanos keeps each writer isolated; the
/// `rename` itself stays atomic, so readers only ever observe a
/// complete file. Mirrors the TS-side pattern in
/// `src/infra/storage/chain-file-io.ts` (`${filename}.tmp-${pid}-${now}`).
fn unique_tmp_path(target: &Path) -> PathBuf {
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let pid = std::process::id();
    let file_name = target
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| "index".to_string());
    let tmp_name = format!("{file_name}.tmp-{pid}-{stamp}");
    match target.parent() {
        Some(parent) => parent.join(tmp_name),
        None => PathBuf::from(tmp_name),
    }
}

/// Read the index back after `rename` and confirm the bytes on disk are
/// the ones this process serialized.
///
/// The rename is atomic, so a reader can never observe a half-written
/// file — but atomicity alone does not prove the right bytes landed.
/// A truncated write, a concurrent writer, or a serializer that appended
/// trailing bytes all survive `rename` silently: the file is complete and
/// well-formed, just not what we meant to store. Catching that here keeps
/// a bad index from being discovered only when recall returns nonsense.
///
/// On mismatch the on-disk copy is removed so the next load reports
/// `Missing` (a clean rebuild) rather than reading a known-bad index.
/// Returns the read error as `Ok` only when the file is byte-identical.
fn verify_persisted_index(path: &Path, expected: &str) -> Result<(), EmbedError> {
    let written = match fs::read_to_string(path) {
        Ok(contents) => contents,
        Err(error) => {
            return Err(EmbedError::DiskError(format!(
                "index_verification_read_failed: {}: {error}",
                path.display()
            )))
        }
    };
    if written == expected {
        return Ok(());
    }
    // Quarantine rather than delete: an operator debugging a bad index
    // wants the bytes, and the load path already ignores unknown siblings.
    let quarantine = unique_tmp_path(path);
    let _ = fs::remove_file(&quarantine);
    let _ = fs::rename(path, &quarantine);
    Err(EmbedError::DiskError(format!(
        "index_verification_failed: {} (on-disk {} bytes vs expected {}); \
         mismatched file quarantined at {}",
        path.display(),
        written.len(),
        expected.len(),
        quarantine.display()
    )))
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
            pending: HashMap::new(),
            observed_fingerprint: None,
            replacement_state: ReplacementState::Idle,
        };

        if persistence.enabled {
            let index_path = persistence.index_path.clone();
            // The load must observe a file that is not being replaced
            // underneath it: the read → fingerprint snapshot runs under
            // the writer lock, so the bytes we parse and the identity we
            // record always describe the same file.
            let _lock = IndexFileLock::acquire(&index_path)?;
            let loaded = pipeline.load_docs_from_disk(&index_path);
            pipeline.docs = loaded.docs;
            pipeline.observed_fingerprint = loaded.fingerprint;
            pipeline.persistence = Some(EmbedPersistenceState {
                index_path,
                last_load: loaded.state,
                last_error: loaded.error,
            });
        }

        Ok(pipeline)
    }

    /// Build a pipeline that knows its provider but has NOT loaded any
    /// persisted documents.
    ///
    /// For callers that only need `provider_name()` — which is a config
    /// field, not index state. `with_persistence` reads and parses the
    /// whole index (107 MB on this operator's runtime) to serve that one
    /// string, which is why the TUI's startup probe used to spend seconds
    /// on JSON alone. Search callers still need `with_persistence`; this
    /// constructor would return zero hits.
    pub fn with_provider_only(config: EmbedConfig) -> Result<Self, EmbedError> {
        if config.dim == 0 {
            return Err(EmbedError::InvalidDimension(config.dim));
        }
        let provider = build_provider(&config.mode, &config)?;
        Ok(Self {
            config,
            provider,
            docs: HashMap::new(),
            persistence: None,
            auto_persist: true,
            pending: HashMap::new(),
            observed_fingerprint: None,
            replacement_state: ReplacementState::Idle,
        })
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
        // The provider call happens BEFORE the lock is taken: a slow
        // provider HTTP request must never be held under the
        // filesystem lock.
        self.upsert_one_in_memory(id, text, tags)?;
        if self.persistence.is_some() && self.auto_persist {
            // Durable write: report a REAL error instead of claiming a
            // successful persistence that never happened.
            self.persist_pending_merge()?;
        }
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
            if let Err(error) = self.upsert_one_in_memory(id, text, tags) {
                if self.replacement_state == ReplacementState::Armed {
                    // The rebuild failed halfway: the in-memory set is
                    // a PARTIAL rebuild and must never be published as
                    // a replacement.
                    self.replacement_state = ReplacementState::Failed;
                }
                return Err(error);
            }
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
    /// Materialize pending changes on disk.
    ///
    /// Ordinary pending entries are merged into the LATEST persisted
    /// index; an explicit replacement (clear / rebuild) replaces it
    /// wholesale but fails closed on a conflicting external write.
    pub fn flush(&mut self) -> Result<(), EmbedError> {
        if self.persistence.is_none() {
            return Ok(());
        }
        match self.replacement_state {
            ReplacementState::Failed => Err(EmbedError::DiskError(
                "index_replacement_failed: a previous index replacement failed and the \
                 in-memory contents may be partial; re-run the rebuild with \
                 clear_in_memory_only() or discard it with discard_replacement()"
                    .to_string(),
            )),
            ReplacementState::Armed => self.persist_replacement(),
            ReplacementState::Idle => self.persist_pending_merge(),
        }
    }

    /// Current state of an explicit index replacement.
    ///
    /// `Failed` means the last replacement attempt failed: the
    /// in-memory contents may be a partial rebuild and nothing may be
    /// published until the replacement is re-armed or discarded.
    pub fn replacement_state(&self) -> ReplacementState {
        self.replacement_state
    }

    /// Explicitly abandon an armed or failed replacement.
    ///
    /// The on-disk index is left exactly as it is. The in-memory
    /// contents are reloaded from it, so the pipeline continues from the
    /// persisted state instead of a possibly-partial rebuild.
    ///
    /// Fails closed on unreadable storage: if the persisted index cannot
    /// be read back, the discard is still performed (nothing partial is
    /// ever published) but the failure is REPORTED, because a silent
    /// "empty and healthy" pipeline would answer searches with nothing
    /// instead of the error the operator needs to see.
    pub fn discard_replacement(&mut self) -> Result<(), EmbedError> {
        let Some(state) = self.persistence.as_ref() else {
            self.docs.clear();
            self.pending.clear();
            self.replacement_state = ReplacementState::Idle;
            return Ok(());
        };
        let index_path = state.index_path.clone();
        let _lock = IndexFileLock::acquire(&index_path)?;
        let loaded = self.load_docs_from_disk(&index_path);
        self.docs = loaded.docs;
        self.pending.clear();
        self.observed_fingerprint = loaded.fingerprint;
        // The replacement IS discarded either way: the in-memory set may
        // be a partial rebuild and must never reach the disk.
        self.replacement_state = ReplacementState::Idle;
        if let Some(persistence) = self.persistence.as_mut() {
            persistence.last_load = loaded.state.clone();
            persistence.last_error = loaded.error.clone();
        }
        if loaded.state == EmbedPersistenceLoadState::Corrupt {
            return Err(EmbedError::SerializationError(format!(
                "index_discard_failed: the persisted index at {} could not be read; the \
                 replacement was discarded but the index itself is unreadable",
                index_path.display()
            )));
        }
        Ok(())
    }

    /// Flush for process shutdown.
    ///
    /// An interrupted rebuild — a replacement that is `Armed` or
    /// `Failed` — is DISCARDED, never published: its in-memory set may
    /// be a partial rebuild, and writing it would replace a good index
    /// with a half-finished copy. Ordinary pending entries are still
    /// merged: a normal shutdown must not lose them.
    ///
    /// This is the policy the NAPI `embed_shutdown` export runs.
    pub fn shutdown_flush(&mut self) -> Result<ShutdownFlushOutcome, EmbedError> {
        match self.replacement_state {
            ReplacementState::Idle => {
                if self.persistence.is_none() {
                    return Ok(ShutdownFlushOutcome::Noop);
                }
                self.flush()?;
                Ok(ShutdownFlushOutcome::Flushed)
            }
            ReplacementState::Armed | ReplacementState::Failed => {
                let discarded = self.replacement_state;
                self.discard_replacement()?;
                Ok(ShutdownFlushOutcome::DiscardedReplacement(discarded))
            }
        }
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
        // A corrupt or unreadable source must never turn into a
        // successful EMPTY recall.
        self.ensure_searchable()?;
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
        // A corrupt or unreadable source must never turn into a
        // successful EMPTY recall.
        self.ensure_searchable()?;
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

    /// Destructive clear. Writes an empty index — but only when nobody
    /// else wrote to the index since we last read it. A conflicting
    /// external write is reported as an error instead of being deleted.
    pub fn clear(&mut self) -> Result<(), EmbedError> {
        self.docs.clear();
        self.pending.clear();
        self.replacement_state = ReplacementState::Armed;
        if self.persistence.is_none() || !self.auto_persist {
            return Ok(());
        }
        self.persist_replacement()
    }

    /// In-memory only destructive clear. The on-disk index is left untouched —
    /// the caller MUST follow with `flush()` to materialise a replacement, or
    /// accept that the next `with_persistence` load sees the previous index.
    ///
    /// Added in ADR-006 to fix the embed reindex data-loss path (issue #628):
    /// bulk rebuilders no longer have to choose between "wipe to empty before
    /// I know whether rebuild will succeed" and "leave stale data in memory".
    /// The destructive on-disk write then happens only after the bulk upsert
    /// succeeds and the materialising flush commits atomically via the
    /// `write tmp + fs::rename` already used by `persist_now_json_v1` /
    /// `persist_now_ndjson_v2`.
    pub fn clear_in_memory_only(&mut self) {
        self.docs.clear();
        self.pending.clear();
        // The next flush replaces the index wholesale instead of
        // merging into it. It still fails closed if another writer
        // touched the index since we last read it.
        //
        // Re-arming from `Failed` is the explicit way to retry a
        // rebuild that failed halfway.
        self.replacement_state = ReplacementState::Armed;
    }

    fn load_docs_from_disk(&self, index_path: &Path) -> LoadedIndex {
        // v2 NDJSON sibling takes precedence — if it exists it's the
        // newer format. A corrupt sibling MUST NOT silently fall back to
        // a stale v1 .json; surface as Corrupt so the operator sees it.
        let ndjson_path = ndjson_sibling_path(index_path);
        let active = if ndjson_path.exists() {
            ndjson_path
        } else {
            index_path.to_path_buf()
        };

        match read_index_bytes(&active) {
            Ok(None) => LoadedIndex {
                docs: HashMap::new(),
                state: EmbedPersistenceLoadState::Missing,
                fingerprint: None,
                error: None,
            },
            Ok(Some((raw, fingerprint))) => {
                let parsed = if is_ndjson_path(&active) {
                    self.parse_ndjson_v2(&raw, &active)
                } else {
                    self.parse_index_v1(&raw, &active)
                };
                match parsed {
                    Ok(docs) => LoadedIndex {
                        docs,
                        state: EmbedPersistenceLoadState::Loaded,
                        fingerprint: Some(fingerprint),
                        error: None,
                    },
                    Err(error) => LoadedIndex {
                        docs: HashMap::new(),
                        state: EmbedPersistenceLoadState::Corrupt,
                        fingerprint: Some(fingerprint),
                        error: Some(error.to_string()),
                    },
                }
            }
            Err(error) => LoadedIndex {
                docs: HashMap::new(),
                state: EmbedPersistenceLoadState::Corrupt,
                fingerprint: None,
                error: Some(error.to_string()),
            },
        }
    }

    /// Parse the v2 NDJSON index.
    ///
    /// Fails closed on ANY malformed record: a skipped record is a
    /// dropped document, and on the write path the dropped document
    /// would be lost for good.
    fn parse_ndjson_v2(
        &self,
        raw: &str,
        origin: &Path,
    ) -> Result<HashMap<String, EmbeddedDocument>, EmbedError> {
        let mut lines = raw.lines().enumerate();

        let (header_index, header_line) = match lines.next() {
            Some((index, line)) if !line.trim().is_empty() => (index + 1, line),
            // Empty file or whitespace-only first line.
            _ => {
                return Err(EmbedError::SerializationError(format!(
                    "index_corrupt: {}: the index file has no header line",
                    origin.display()
                )))
            }
        };

        let header: EmbedDiskHeaderV2 = serde_json::from_str(header_line).map_err(|error| {
            EmbedError::SerializationError(format!(
                "index_parse_failed: {}: header line {header_index}: {error}",
                origin.display()
            ))
        })?;

        if header.version != 2 {
            return Err(EmbedError::SerializationError(format!(
                "index_version_unsupported: {} in {}",
                header.version,
                origin.display()
            )));
        }

        // Same dimension guard as the v1 path — never mix vector spaces.
        if header.dim != self.config.dim {
            return Err(EmbedError::DiskError(format!(
                "index_dimension_mismatch: disk_dim={} config_dim={}",
                header.dim, self.config.dim
            )));
        }

        let mut docs = HashMap::new();
        for (index, line) in lines {
            if line.trim().is_empty() {
                continue;
            }
            let position = index + 1;
            let doc: EmbedDiskDocV2 = serde_json::from_str(line).map_err(|error| {
                EmbedError::SerializationError(format!(
                    "index_parse_failed: {}: line {position}: {error}",
                    origin.display()
                ))
            })?;
            let materialized =
                self.materialize_record(position, doc.id, doc.text, doc.vector, doc.tags, origin)?;
            if docs.insert(materialized.id.clone(), materialized).is_some() {
                return Err(EmbedError::SerializationError(format!(
                    "index_corrupt: {}: duplicate record id at line {position}",
                    origin.display()
                )));
            }
        }

        Ok(docs)
    }

    /// Parse the legacy v1 JSON index.
    ///
    /// Legacy compatibility is kept only where it cannot destroy data:
    /// the container format is still read, but a record that cannot be
    /// materialized as-is fails the whole load instead of being
    /// re-embedded or dropped.
    fn parse_index_v1(
        &self,
        raw: &str,
        origin: &Path,
    ) -> Result<HashMap<String, EmbeddedDocument>, EmbedError> {
        if raw.trim().is_empty() {
            // An existing but EMPTY index file is a truncated write, not
            // an empty-but-valid index. Treating it as "nothing to
            // read" would let the next write replace it and silently
            // drop every document it used to hold.
            return Err(EmbedError::SerializationError(format!(
                "index_corrupt: {}: the index file is empty",
                origin.display()
            )));
        }

        let parsed: EmbedDiskIndexV1 = serde_json::from_str(raw).map_err(|error| {
            EmbedError::SerializationError(format!(
                "index_parse_failed: {}: {error}",
                origin.display()
            ))
        })?;
        if parsed.version != 1 {
            return Err(EmbedError::SerializationError(format!(
                "index_version_unsupported: {} in {}",
                parsed.version,
                origin.display()
            )));
        }

        // A different embedding dimension means a different vector
        // space — fail closed instead of silently re-embedding the
        // corpus into a space that does not match the stored vectors.
        if parsed.dim != self.config.dim {
            return Err(EmbedError::DiskError(format!(
                "index_dimension_mismatch: disk_dim={} config_dim={}",
                parsed.dim, self.config.dim
            )));
        }

        let mut docs = HashMap::new();
        for (index, doc) in parsed.docs.into_iter().enumerate() {
            let position = index + 1;
            let materialized =
                self.materialize_record(position, doc.id, doc.text, doc.vector, doc.tags, origin)?;
            if docs.insert(materialized.id.clone(), materialized).is_some() {
                return Err(EmbedError::SerializationError(format!(
                    "index_corrupt: {}: duplicate record id at position {position}",
                    origin.display()
                )));
            }
        }

        Ok(docs)
    }

    /// Validate a decoded record and turn it into an in-memory
    /// document.
    ///
    /// Fails closed. A record with a missing, wrong-sized, or
    /// non-finite vector, an empty id or text, or text that violates
    /// the configured limits is NOT repaired by re-embedding it:
    /// re-embedding would move the document into a different vector
    /// space and, on the write path, would silently drop it from an
    /// existing index. No provider call happens here — the writer lock
    /// is held around this code.
    ///
    /// The error message never carries the record's text or id.
    fn materialize_record(
        &self,
        position: usize,
        id: String,
        text: String,
        vector: Option<Vec<f32>>,
        tags: Vec<String>,
        origin: &Path,
    ) -> Result<EmbeddedDocument, EmbedError> {
        if id.trim().is_empty() {
            return Err(EmbedError::SerializationError(format!(
                "index_corrupt: {}: record #{position} has an empty id",
                origin.display()
            )));
        }
        if text.trim().is_empty() {
            return Err(EmbedError::SerializationError(format!(
                "index_corrupt: {}: record #{position} has empty text",
                origin.display()
            )));
        }
        if self.validate_text(&text).is_err() {
            return Err(EmbedError::SerializationError(format!(
                "index_corrupt: {}: record #{position} violates the text limits",
                origin.display()
            )));
        }

        let vector = vector.ok_or_else(|| {
            EmbedError::SerializationError(format!(
                "index_corrupt: {}: record #{position} has no vector",
                origin.display()
            ))
        })?;
        if vector.len() != self.config.dim {
            return Err(EmbedError::SerializationError(format!(
                "index_corrupt: {}: record #{position} has a {}-dimensional vector, expected {}",
                origin.display(),
                vector.len(),
                self.config.dim
            )));
        }
        if let Some(lane) = vector.iter().position(|value| !value.is_finite()) {
            return Err(EmbedError::SerializationError(format!(
                "index_corrupt: {}: record #{position} has a non-finite vector at lane {lane}",
                origin.display()
            )));
        }

        Ok(EmbeddedDocument {
            id,
            text,
            vector,
            tags,
        })
    }

    /// Update the reported persistence load state (after a successful
    /// write or refresh it must stop saying "missing").
    fn set_load_state(&mut self, state: EmbedPersistenceLoadState) {
        if let Some(persistence) = self.persistence.as_mut() {
            // The comparison happens BEFORE the assignment:
            // `EmbedPersistenceLoadState` is `Clone` but not `Copy`,
            // so `persistence.last_load = state` would move `state`
            // out and the comparison below would not compile.
            let keep_error = state == EmbedPersistenceLoadState::Corrupt;
            persistence.last_load = state;
            if !keep_error {
                persistence.last_error = None;
            }
        }
    }

    /// Refuse to answer from a source that could not be read.
    ///
    /// A corrupt or unreadable index must never degrade into a
    /// successful EMPTY recall: the caller has to see the error.
    fn ensure_searchable(&self) -> Result<(), EmbedError> {
        if let Some(state) = self.persistence.as_ref() {
            if state.last_load == EmbedPersistenceLoadState::Corrupt {
                return Err(EmbedError::SerializationError(
                    state
                        .last_error
                        .clone()
                        .unwrap_or(format!("index_corrupt: {}", state.index_path.display())),
                ));
            }
        }
        Ok(())
    }

    /// Validate + embed + record ONE document in memory.
    ///
    /// The provider call happens before any lock is taken: a slow
    /// provider HTTP request must never be held under the filesystem
    /// lock.
    fn upsert_one_in_memory(
        &mut self,
        id: String,
        text: String,
        tags: Vec<String>,
    ) -> Result<(), EmbedError> {
        self.validate_text(&text)?;
        let vector = self.provider.embed(&text, self.config.dim)?;
        let doc = EmbeddedDocument {
            id: id.clone(),
            text,
            vector,
            tags,
        };
        self.docs.insert(id.clone(), doc.clone());
        if self.persistence.is_some() {
            // Track the actual pending additions/updates so the flush
            // merges only these into the latest index.
            self.pending.insert(id, doc);
        }
        Ok(())
    }

    /// Re-read the persisted index so a long-running process observes
    /// writes made by another process.
    ///
    /// Pending (not yet persisted) entries are preserved and win over
    /// the on-disk copy — a refresh must never discard a bulk write
    /// that has not been flushed yet. The reload is skipped when the
    /// index file has not changed since we last read it: re-parsing a
    /// 100 MB index on every search would be unusable.
    ///
    /// Returns `true` when the in-memory index was refreshed.
    pub fn refresh_from_disk(&mut self) -> Result<bool, EmbedError> {
        let Some(state) = self.persistence.as_ref() else {
            return Ok(false);
        };
        let index_path = state.index_path.clone();

        // The read → fingerprint snapshot runs under the writer lock:
        // otherwise an atomic replacement between the read and the
        // fingerprint would tag STALE contents with the NEW file's
        // identity, and the stale contents would be served as if they
        // were current.
        let _lock = IndexFileLock::acquire(&index_path)?;
        let active = active_index_path(&index_path);

        // Cheap skip: the file identity (size, mtime, device, inode) is
        // unchanged, so the parsed index we already hold still
        // describes the file. Re-parsing a 150 MB index on every
        // search is not viable.
        match (stat_of(&active), self.observed_fingerprint.as_ref()) {
            (Some(current), Some(observed)) if current == observed.stat => return Ok(false),
            (None, None) => return Ok(false),
            _ => {}
        }

        // A corrupt or unreadable index is propagated — never turned
        // into an empty index.
        let (on_disk, fingerprint) = self.read_index_for_merge(&index_path)?;
        let mut merged = on_disk;
        for (id, doc) in self.pending.iter() {
            merged.insert(id.clone(), doc.clone());
        }

        self.docs = merged;
        self.observed_fingerprint = fingerprint;
        self.set_load_state(EmbedPersistenceLoadState::Loaded);
        Ok(true)
    }

    /// Merge the pending additions/updates into the LATEST persisted
    /// index and write it back.
    ///
    /// The complete read → merge → write sequence runs under the
    /// cross-process advisory lock, so a second writer can neither read
    /// a half-merged index nor lose this writer's documents. Writing
    /// the whole in-memory snapshot instead is what let two processes
    /// overwrite each other.
    fn persist_pending_merge(&mut self) -> Result<(), EmbedError> {
        let Some(state) = self.persistence.as_ref() else {
            return Ok(());
        };
        if self.replacement_state != ReplacementState::Idle {
            // An explicit replacement is in flight. Merging here would
            // publish the half-finished rebuild and cancel the
            // replacement. The caller must flush (or discard) the
            // replacement explicitly.
            return Err(EmbedError::DiskError(
                "index_replacement_pending: an explicit index replacement is in flight; \
                 flush the replacement or discard it before merging ordinary entries"
                    .to_string(),
            ));
        }
        if self.pending.is_empty() {
            // Nothing changed: a flush must never rewrite the whole
            // index (150 MB on a real corpus) just to say "no change".
            return Ok(());
        }
        let index_path = state.index_path.clone();

        let _lock = IndexFileLock::acquire(&index_path)?;
        let (on_disk, _read_fingerprint) = self.read_index_for_merge(&index_path)?;

        let mut merged = on_disk;
        for (id, doc) in self.pending.iter() {
            merged.insert(id.clone(), doc.clone());
        }

        let target = resolve_write_target(&index_path);
        let fingerprint = self.write_index(&target, &merged)?;

        self.docs = merged;
        self.pending.clear();
        self.observed_fingerprint = Some(fingerprint);
        self.set_load_state(EmbedPersistenceLoadState::Loaded);
        Ok(())
    }

    /// Replace the index wholesale with the in-memory set.
    ///
    /// Fails closed when another writer touched the index since we last
    /// read it: deleting their newer work would be worse than refusing
    /// the replacement.
    fn persist_replacement(&mut self) -> Result<(), EmbedError> {
        let Some(state) = self.persistence.as_ref() else {
            return Ok(());
        };
        let index_path = state.index_path.clone();

        let result = self.persist_replacement_locked(&index_path);
        match result {
            Ok(fingerprint) => {
                self.pending.clear();
                self.observed_fingerprint = Some(fingerprint);
                self.replacement_state = ReplacementState::Idle;
                self.set_load_state(EmbedPersistenceLoadState::Loaded);
                Ok(())
            }
            Err(error) => {
                // A failed replacement leaves the in-memory contents
                // possibly partial: nothing may be published until the
                // caller explicitly completes or discards it.
                self.replacement_state = ReplacementState::Failed;
                Err(error)
            }
        }
    }

    /// The locked part of a replacement write.
    fn persist_replacement_locked(
        &self,
        index_path: &Path,
    ) -> Result<IndexFingerprint, EmbedError> {
        let _lock = IndexFileLock::acquire(index_path)?;
        let (_on_disk, current) = self.read_index_for_merge(index_path)?;

        // Conflict detection is on CONTENT, not on size + mtime: a
        // publish through atomic rename preserves the size, and an
        // in-place edit can preserve both size and mtime. The digest is
        // computed over the bytes that were actually read.
        let conflict = match (self.observed_fingerprint.as_ref(), current.as_ref()) {
            (None, None) => false,
            (None, Some(_)) => true,
            (Some(_), None) => true,
            (Some(observed), Some(current)) => observed.digest != current.digest,
        };
        if conflict {
            return Err(EmbedError::DiskError(format!(
                "index_conflict: refusing to replace {} — it changed since it was last read",
                index_path.display()
            )));
        }

        let replacement = self.docs.clone();
        let target = resolve_write_target(index_path);
        self.write_index(&target, &replacement)
    }

    /// Read the CURRENT persisted index.
    ///
    /// Fails closed on unreadable or corrupt storage and on a dimension
    /// mismatch: a merge must never mix vector spaces and must never
    /// destroy a damaged index.
    fn read_index_for_merge(
        &self,
        index_path: &Path,
    ) -> Result<(HashMap<String, EmbeddedDocument>, Option<IndexFingerprint>), EmbedError> {
        let active = active_index_path(index_path);

        // The bytes and the fingerprint come from the SAME open file,
        // so the parsed content and the recorded identity always
        // describe the same file.
        let Some((raw, fingerprint)) = read_index_bytes(&active)? else {
            // No index on disk yet: an empty merge base is legitimate.
            return Ok((HashMap::new(), None));
        };

        let docs = if is_ndjson_path(&active) {
            self.parse_ndjson_v2(&raw, &active)?
        } else {
            self.parse_index_v1(&raw, &active)?
        };

        Ok((docs, Some(fingerprint)))
    }

    /// Serialize + atomically write the index to `target`.
    ///
    /// Returns the identity of the published file: the stat of the
    /// file that is on disk plus the digest of the exact bytes that
    /// were published, so the observed fingerprint always describes the
    /// content that was written.
    fn write_index(
        &self,
        target: &Path,
        docs: &HashMap<String, EmbeddedDocument>,
    ) -> Result<IndexFingerprint, EmbedError> {
        let content = if is_ndjson_path(target) {
            self.serialize_index_v2(docs)?
        } else {
            self.serialize_index_v1(docs)?
        };
        write_index_file(target, &content)?;
        let stat = stat_of(target).ok_or_else(|| {
            EmbedError::DiskError(format!("index_stat_failed: {}", target.display()))
        })?;
        Ok(IndexFingerprint {
            stat,
            digest: digest_of(content.as_bytes()),
        })
    }

    fn serialize_index_v1(
        &self,
        docs: &HashMap<String, EmbeddedDocument>,
    ) -> Result<String, EmbedError> {
        let payload = EmbedDiskIndexV1 {
            version: 1,
            dim: self.config.dim,
            docs: docs
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
        // machine-read index.
        serde_json::to_string(&payload)
            .map_err(|e| EmbedError::SerializationError(format!("serialize_failed: {e}")))
    }

    fn serialize_index_v2(
        &self,
        docs: &HashMap<String, EmbeddedDocument>,
    ) -> Result<String, EmbedError> {
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

        for doc in docs.values() {
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

        Ok(buf)
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

    use std::path::Path;

    use super::{
        parse_embedding_vector, sanitize_for_embed, validate_embedding_component, CascadeProvider,
        EmbedConfig, EmbedMode, EmbedPersistenceConfig, EmbedPersistenceLoadState, EmbedPipeline,
        LocalDeterministicProvider, DEFAULT_EMBEDDING_DIM,
    };
    use crate::pipeline::{ollama_embed_payload, OllamaProvider};
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

    // --- provider embedding validation (synthetic, no network) ---

    #[test]
    fn provider_vector_with_matching_dimension_is_accepted() {
        let values = vec![
            serde_json::json!(0.5),
            serde_json::json!(-0.25),
            serde_json::json!(0.0),
            serde_json::json!(1.0),
        ];
        let vector = parse_embedding_vector("ollama", &values, 4).expect("valid embedding");
        assert_eq!(vector, vec![0.5_f32, -0.25_f32, 0.0_f32, 1.0_f32]);
    }

    #[test]
    fn provider_vector_too_short_is_rejected_with_dimensions() {
        let values = vec![serde_json::json!(0.5), serde_json::json!(0.25)];
        let err = parse_embedding_vector("ollama", &values, 4).expect_err("dimension mismatch");
        assert!(matches!(err, EmbedError::ProviderResponse(_)));
        assert!(
            err.to_string()
                .contains("embedding dimension 2, expected 4"),
            "unexpected message: {err}"
        );
    }

    #[test]
    fn provider_vector_too_long_is_rejected_with_dimensions() {
        let values = vec![
            serde_json::json!(0.5),
            serde_json::json!(0.25),
            serde_json::json!(0.125),
            serde_json::json!(0.0625),
            serde_json::json!(0.03125),
        ];
        let err = parse_embedding_vector("nomic", &values, 3).expect_err("dimension mismatch");
        assert!(matches!(err, EmbedError::ProviderResponse(_)));
        assert!(
            err.to_string()
                .contains("embedding dimension 5, expected 3"),
            "unexpected message: {err}"
        );
    }

    #[test]
    fn provider_vector_with_empty_array_is_rejected() {
        let err = parse_embedding_vector("ollama", &[], 4).expect_err("empty embedding");
        assert!(matches!(err, EmbedError::ProviderResponse(_)));
        assert!(
            err.to_string().contains("returned empty embedding"),
            "unexpected message: {err}"
        );
    }

    #[test]
    fn provider_vector_with_zero_expected_dim_is_rejected() {
        let err = parse_embedding_vector("ollama", &[], 0).expect_err("invalid dimension");
        assert_eq!(err, EmbedError::InvalidDimension(0));
    }

    #[test]
    fn provider_vector_with_non_numeric_component_is_rejected() {
        for bad in [
            serde_json::json!("0.5"),
            serde_json::json!(true),
            serde_json::Value::Null,
            serde_json::json!([0.5]),
        ] {
            let values = vec![serde_json::json!(0.5), bad];
            let err =
                parse_embedding_vector("ollama", &values, 2).expect_err("non-numeric component");
            assert!(matches!(err, EmbedError::ProviderResponse(_)));
            assert!(
                err.to_string()
                    .contains("non-numeric embedding component at index 1"),
                "unexpected message: {err}"
            );
        }
    }

    #[test]
    fn provider_vector_with_nonfinite_component_is_rejected() {
        for bad in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
            let err =
                validate_embedding_component("ollama", 2, bad).expect_err("non-finite component");
            assert!(matches!(err, EmbedError::ProviderResponse(_)));
            assert!(
                err.to_string()
                    .contains("non-finite embedding component at index 2"),
                "unexpected message: {err}"
            );
        }
    }

    #[test]
    fn provider_vector_that_overflows_f32_is_rejected() {
        // Finite in f64, infinity in f32 — must not reach the index.
        let values = vec![serde_json::json!(1e300)];
        let err = parse_embedding_vector("ollama", &values, 1).expect_err("out of range");
        assert!(matches!(err, EmbedError::ProviderResponse(_)));
        assert!(
            err.to_string()
                .contains("out-of-range embedding component at index 0"),
            "unexpected message: {err}"
        );

        let err = validate_embedding_component("ollama", 0, 1e300).expect_err("out of range");
        assert!(err.to_string().contains("out-of-range"));
    }

    #[test]
    fn provider_vector_error_does_not_leak_vector_or_input_contents() {
        let values = vec![
            serde_json::json!(0.123456789),
            serde_json::json!(9.87654321),
        ];
        let err = parse_embedding_vector("ollama", &values, 8).expect_err("dimension mismatch");
        let message = err.to_string();
        assert!(!message.contains("0.123456789"), "leaked value: {message}");
        assert!(!message.contains("9.87654321"), "leaked value: {message}");
        assert!(!message.contains("secret"), "leaked input: {message}");
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
    fn ollama_payload_carries_keep_alive_when_configured() {
        // Regression (2026-10-24): the Rust provider omitted `keep_alive`,
        // so Ollama unloaded the model after 5 idle minutes and every
        // embed paid a cold load (18-39 s measured). The TypeScript
        // provider has always sent it.
        let payload = ollama_embed_payload("nomic-embed-text", "tekst", Some("5m"));
        assert_eq!(
            payload["keep_alive"],
            serde_json::Value::String("5m".to_string())
        );
        assert_eq!(payload["model"], "nomic-embed-text");
        assert_eq!(payload["prompt"], "tekst");
    }

    #[test]
    fn ollama_payload_omits_keep_alive_when_unset() {
        // Absent must mean ABSENT from the body, not a null/empty value:
        // the server then applies its own default instead of being told
        // to unload immediately.
        let payload = ollama_embed_payload("nomic-embed-text", "tekst", None);
        assert!(payload.get("keep_alive").is_none());

        // A blank value is treated as unset too.
        let payload = ollama_embed_payload("nomic-embed-text", "tekst", Some("   "));
        assert!(payload.get("keep_alive").is_none());
    }

    #[test]
    fn embed_config_keep_alive_flows_into_the_provider() {
        let mut config = EmbedConfig {
            mode: EmbedMode::Provider("ollama".to_string()),
            provider_url: Some("http://127.0.0.1:11434".to_string()),
            provider_model: Some("nomic-embed-text".to_string()),
            provider_keep_alive: Some("24h".to_string()),
            ..EmbedConfig::default()
        };
        config.dim = 8;
        let provider = OllamaProvider::new(&config).expect("provider");
        assert_eq!(provider.keep_alive.as_deref(), Some("24h"));
        let payload =
            ollama_embed_payload(&provider.model, "tekst", provider.keep_alive.as_deref());
        assert_eq!(
            payload["keep_alive"],
            serde_json::Value::String("24h".to_string())
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

    /// ADR-006 regression: the bulk rebuilder MUST be able to drop the
    /// previous index from the in-memory HashMap without committing a
    /// destructive empty write to disk. If the process is killed (SIGKILL,
    /// OOM, JS exception, racing reindex) between the in-memory clear and
    /// the materialising flush, the on-disk file must remain byte-identical
    /// to what the previous flush produced — that's the index the next
    /// `with_persistence` load will pick up.
    #[test]
    fn clear_in_memory_only_leaves_disk_unchanged_on_drop() {
        let path = temp_path("clear-in-memory-only");
        let mut pipeline = EmbedPipeline::with_persistence(
            EmbedConfig::default(),
            EmbedPersistenceConfig {
                enabled: true,
                index_path: path.clone(),
            },
        )
        .expect("pipeline");

        // Seed + materialise a known-good payload.
        pipeline.set_auto_persist(false);
        pipeline.upsert("doc-1", "first").expect("upsert 1");
        pipeline.upsert("doc-2", "second").expect("upsert 2");
        pipeline.flush().expect("flush");
        assert!(path.exists(), "seed flush must materialise");

        let pre_clear = std::fs::read(&path).expect("read pre-clear snapshot");

        // Simulate the bulk rebuilder: in-memory clear, repopulate with
        // different items, then SIGKILL-equivalent (drop the pipeline
        // without flushing). The on-disk file must NOT reflect the new
        // state — and crucially must NOT be the destructive empty payload
        // the old `clear()` would have written.
        pipeline.clear_in_memory_only();
        pipeline
            .upsert("doc-3", "third")
            .expect("upsert 3 after in-memory clear");
        drop(pipeline);

        let post_drop = std::fs::read(&path).expect("read post-drop snapshot");
        assert_eq!(
            pre_clear, post_drop,
            "clear_in_memory_only must NOT modify the on-disk index"
        );

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
        // /proc is a virtual filesystem; creating the index lock under it
        // fails with EROFS, surfacing the I/O error path that legacy
        // `persist_best_effort` used to swallow.
        //
        // The failure now happens EARLY: `with_persistence` acquires the
        // index writer lock before it can build the pipeline, so the disk
        // error surfaces at construction time instead of at flush time.
        let path = std::path::PathBuf::from("/proc/memphis-embed-readonly/embed_index.json");
        let result = EmbedPipeline::with_persistence(
            EmbedConfig::default(),
            EmbedPersistenceConfig {
                enabled: true,
                index_path: path,
            },
        );

        let error = result
            .err()
            .expect("constructing a pipeline on /proc/... must surface the disk error");
        assert!(
            !error.to_string().is_empty(),
            "the disk error must be reported, not swallowed"
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
        // A null vector is fail-closed by design: such a record cannot be
        // materialized, so it is never repaired by re-embedding. The fixture
        // therefore carries a real, finite vector of the configured
        // dimension. The v1 fallback itself is still what is under test.
        let vector: Vec<f32> = (0..DEFAULT_EMBEDDING_DIM)
            .map(|lane| 0.01 * lane as f32)
            .collect();
        let payload = serde_json::json!({
            "version": 1,
            "dim": DEFAULT_EMBEDDING_DIM,
            "docs": [
                {
                    "id": "doc-only-v1",
                    "text": "fallback content",
                    "vector": vector,
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

    // ─── 1b: collision-free temp path ─────────────────────────────────
    // Two processes (Rust operator runtime + TS/CLI through the napi
    // bridge) persist the same index concurrently. A shared `index-v1.tmp`
    // lets one process's `write` land inside the other's, so the later
    // `rename` can move bytes the writer never produced. These tests pin
    // the per-process temp naming that prevents that.

    #[test]
    fn unique_tmp_path_is_not_the_shared_with_extension_form() {
        let index = Path::new("/tmp/embed/index-v1.json");
        let tmp = super::unique_tmp_path(index);
        let shared = index.with_extension("tmp");
        assert_ne!(
            tmp, shared,
            "temp path must not collide with the shared with_extension(\"tmp\") form"
        );
    }

    #[test]
    fn unique_tmp_path_differs_between_calls() {
        let index = Path::new("/tmp/embed/index-v1.json");
        let a = super::unique_tmp_path(index);
        let b = super::unique_tmp_path(index);
        assert_ne!(
            a, b,
            "two writes in the same process must not share a temp file"
        );
    }

    #[test]
    fn unique_tmp_path_stays_in_the_target_directory() {
        let index = Path::new("/tmp/embed/index-v1.json");
        let tmp = super::unique_tmp_path(index);
        assert_eq!(
            tmp.parent(),
            index.parent(),
            "rename() is only atomic within the same filesystem, so the temp \
             file must be a sibling of the target"
        );
        let name = tmp.file_name().unwrap().to_string_lossy().into_owned();
        assert!(
            name.starts_with("index-v1.json.tmp-"),
            "temp name must keep the full target name for traceability, got {name}"
        );
    }

    #[test]
    fn unique_tmp_path_embeds_the_writing_pid() {
        let index = Path::new("index-v1.json");
        let tmp = super::unique_tmp_path(index);
        let name = tmp.file_name().unwrap().to_string_lossy().into_owned();
        let pid = std::process::id().to_string();
        assert!(
            name.contains(&pid),
            "temp name must carry the pid so concurrent writers are separable, got {name}"
        );
    }

    #[test]
    fn unique_tmp_path_handles_extensionless_target() {
        let tmp = super::unique_tmp_path(Path::new("index"));
        let name = tmp.file_name().unwrap().to_string_lossy().into_owned();
        assert!(
            name.starts_with("index.tmp-"),
            "extensionless targets must still get a namespaced temp, got {name}"
        );
    }

    // ─── 1a: read-after-write verification ─────────────────────────────
    // Mirrors `writeBlockAtomic` in src/infra/storage/chain-file-io.ts,
    // which already does this for chain blocks. The embed index was the
    // remaining gap in issue #628: atomic rename, no read-back.

    fn temp_index_path(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "memphis-embed-verify-{}-{}",
            std::process::id(),
            tag
        ));
        std::fs::create_dir_all(&dir).expect("mkdir");
        dir.join("index-v1.json")
    }

    #[test]
    fn verify_accepts_byte_identical_file() {
        let path = temp_index_path("identical");
        std::fs::write(&path, b"{\"version\":1}").expect("write");
        let result = super::verify_persisted_index(&path, "{\"version\":1}");
        assert!(result.is_ok(), "identical bytes must pass: {result:?}");
        assert!(
            path.exists(),
            "a passing verification must leave the file in place"
        );
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn verify_rejects_truncated_write() {
        let path = temp_index_path("truncated");
        std::fs::write(&path, b"{\"version\":1,\"docs\":[]}").expect("write");
        let result = super::verify_persisted_index(&path, "{\"version\":1}");
        assert!(
            result.is_err(),
            "a truncated write must not pass verification"
        );
        let message = result.unwrap_err().to_string();
        assert!(
            message.contains("index_verification_failed"),
            "error must be classifiable, got: {message}"
        );
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn verify_rejects_trailing_garbage_like_issue_385() {
        // Issue #04 case #385: a stray '}' appended after the JSON close.
        let path = temp_index_path("trailing-brace");
        std::fs::write(&path, b"{\"version\":1}}").expect("write");
        assert!(
            super::verify_persisted_index(&path, "{\"version\":1}").is_err(),
            "trailing brace (issue #385 pattern) must fail verification"
        );
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn verify_quarantines_instead_of_deleting() {
        // An operator debugging a bad index needs the bytes, so the
        // mismatched file is moved aside rather than dropped.
        let path = temp_index_path("quarantine");
        std::fs::write(&path, b"corrupted").expect("write");
        let _ = super::verify_persisted_index(&path, "expected");
        let dir = path.parent().unwrap();
        assert!(
            !path.exists(),
            "the bad index must not stay at the load path"
        );
        let quarantined = std::fs::read_dir(dir)
            .expect("readdir")
            .filter_map(Result::ok)
            .any(|entry| {
                entry.file_name().to_string_lossy().contains("quarantine")
                    || entry.file_name().to_string_lossy().contains("tmp-")
            });
        assert!(
            quarantined,
            "the mismatched bytes must be preserved for inspection"
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn verify_reports_read_failure_distinctly() {
        let dir = std::env::temp_dir().join(format!(
            "memphis-embed-verify-missing-{}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).expect("mkdir");
        let result = super::verify_persisted_index(&dir.join("absent.json"), "x");
        let message = result.unwrap_err().to_string();
        assert!(
            message.contains("index_verification_read_failed"),
            "a missing file is not a content mismatch, got: {message}"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
    #[test]
    fn credential_debug_embed_config_omits_key_and_url_credentials() {
        let secret = "synthetic-native-private-debug-material";
        let config = EmbedConfig {
            mode: EmbedMode::Provider(secret.into()),
            provider_api_key: Some(secret.into()),
            provider_url: Some(format!(
                "https://user:{secret}@example.test/?token={secret}"
            )),
            provider_model: Some(secret.into()),
            ..EmbedConfig::default()
        };
        for debug in [format!("{config:?}"), format!("{config:#?}")] {
            assert!(!debug.contains(secret));
            assert!(!debug.contains(&secret[..16]));
            assert!(!debug.contains(&secret[secret.len() - 16..]));
        }
        assert_eq!(config.provider_api_key.as_deref(), Some(secret));
    }
}

#[cfg(test)]
mod integrity_tests {
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::time::{SystemTime, UNIX_EPOCH};

    use super::{
        EmbedConfig, EmbedError, EmbedPersistenceConfig, EmbedPersistenceLoadState, EmbedPipeline,
        ReplacementState,
    };

    fn temp_index_path(name: &str) -> PathBuf {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        std::env::temp_dir()
            .join(format!(
                "memphis-embed-integrity-{name}-{}-{stamp}",
                std::process::id()
            ))
            .join("index-v1.json")
    }

    fn pipeline_for(path: &Path) -> EmbedPipeline {
        EmbedPipeline::with_persistence(
            EmbedConfig {
                dim: 8,
                ..EmbedConfig::default()
            },
            EmbedPersistenceConfig {
                enabled: true,
                index_path: path.to_path_buf(),
            },
        )
        .expect("pipeline")
    }

    fn ids_on_disk(path: &Path) -> Vec<String> {
        pipeline_for(path)
            .search("document corpus", 64)
            .expect("search")
            .into_iter()
            .map(|hit| hit.id)
            .collect()
    }

    fn write_raw(path: &Path, raw: &str) {
        fs::create_dir_all(path.parent().expect("parent")).expect("mkdir");
        fs::write(path, raw).expect("write");
    }

    #[cfg(unix)]
    fn inode_of(path: &Path) -> u64 {
        use std::os::unix::fs::MetadataExt;
        fs::metadata(path).expect("metadata").ino()
    }

    /// A flush with nothing pending must not rewrite the whole index.
    #[cfg(unix)]
    #[test]
    fn flush_without_pending_changes_does_not_rewrite_the_index() {
        let path = temp_index_path("flush-noop");
        let mut pipeline = pipeline_for(&path);
        pipeline
            .upsert("doc-a", "a document that gets persisted")
            .expect("upsert");

        let before = inode_of(&path);
        pipeline.flush().expect("no-op flush");
        assert_eq!(
            before,
            inode_of(&path),
            "a flush with no changes rewrote the whole index"
        );
    }

    /// A corrupt source must never degrade into a successful EMPTY
    /// recall.
    #[test]
    fn search_fails_closed_on_a_corrupt_index() {
        let path = temp_index_path("search-corrupt");
        write_raw(&path, "{ not valid json");

        let pipeline = pipeline_for(&path);
        assert_eq!(
            pipeline.persistence_load_state(),
            EmbedPersistenceLoadState::Corrupt
        );
        let error = pipeline
            .search("anything", 5)
            .expect_err("a corrupt index must not answer");
        assert!(
            matches!(error, EmbedError::SerializationError(_)),
            "unexpected error: {error:?}"
        );
    }

    /// A record without a vector must fail closed and leave the file
    /// alone — never be re-embedded, never be dropped.
    #[test]
    fn malformed_record_fails_closed_and_preserves_the_file() {
        let path = temp_index_path("malformed-record");
        let raw =
            r#"{"version":1,"dim":8,"docs":[{"id":"d1","text":"a stored document","tags":[]}]}"#;
        write_raw(&path, raw);

        let mut pipeline = pipeline_for(&path);
        let error = pipeline
            .upsert("doc-a", "must not be written")
            .expect_err("a malformed record must fail closed");
        assert!(
            matches!(error, EmbedError::SerializationError(_)),
            "unexpected error: {error:?}"
        );
        assert_eq!(
            fs::read_to_string(&path).expect("read back"),
            raw,
            "the index must be preserved"
        );
    }

    /// A vector with the wrong width is a different vector space.
    #[test]
    fn wrong_dimension_vector_fails_closed() {
        let path = temp_index_path("wrong-dim");
        let raw = r#"{"version":1,"dim":8,"docs":[{"id":"d1","text":"a stored document","vector":[0.1,0.2],"tags":[]}]}"#;
        write_raw(&path, raw);

        let mut pipeline = pipeline_for(&path);
        let error = pipeline
            .upsert("doc-a", "must not be written")
            .expect_err("a wrong-sized vector must fail closed");
        assert!(
            matches!(error, EmbedError::SerializationError(_)),
            "unexpected error: {error:?}"
        );
        assert_eq!(fs::read_to_string(&path).expect("read back"), raw);
    }

    /// A duplicate id means two documents would collapse into one.
    #[test]
    fn duplicate_record_id_fails_closed() {
        let path = temp_index_path("duplicate");
        let raw = r#"{"version":1,"dim":8,"docs":[{"id":"d1","text":"first document","vector":[0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1],"tags":[]},{"id":"d1","text":"second document","vector":[0.2,0.2,0.2,0.2,0.2,0.2,0.2,0.2],"tags":[]}]}"#;
        write_raw(&path, raw);

        let mut pipeline = pipeline_for(&path);
        let error = pipeline
            .upsert("doc-a", "must not be written")
            .expect_err("a duplicate id must fail closed");
        assert!(
            matches!(error, EmbedError::SerializationError(_)),
            "unexpected error: {error:?}"
        );
        assert_eq!(fs::read_to_string(&path).expect("read back"), raw);
    }

    /// An existing but empty index file is a truncated write, not an
    /// empty valid index.
    #[test]
    fn empty_index_file_is_corrupt_not_empty() {
        let path = temp_index_path("empty-file");
        write_raw(&path, "");

        let mut pipeline = pipeline_for(&path);
        assert_eq!(
            pipeline.persistence_load_state(),
            EmbedPersistenceLoadState::Corrupt
        );
        let error = pipeline
            .upsert("doc-a", "must not be written")
            .expect_err("an empty index file must fail closed");
        assert!(
            matches!(error, EmbedError::SerializationError(_)),
            "unexpected error: {error:?}"
        );
        assert_eq!(fs::read_to_string(&path).expect("read back"), "");
    }

    /// A rebuild that failed halfway must never publish a partial
    /// index — not through a flush, not through a later ordinary
    /// upsert.
    #[test]
    fn failed_rebuild_never_publishes_a_partial_index() {
        let path = temp_index_path("failed-rebuild");
        let mut pipeline = pipeline_for(&path);
        pipeline
            .upsert("doc-original", "the original document")
            .expect("upsert");

        pipeline.clear_in_memory_only();
        pipeline.set_auto_persist(false);
        let error = pipeline
            .upsert_many(vec![
                (
                    "doc-new-1".to_string(),
                    "new document one".to_string(),
                    vec![],
                ),
                ("doc-new-2".to_string(), "   ".to_string(), vec![]),
            ])
            .expect_err("the rebuild must fail");
        assert!(
            matches!(error, EmbedError::EmptyInput),
            "unexpected error: {error:?}"
        );
        assert_eq!(
            pipeline.replacement_state(),
            ReplacementState::Failed,
            "a failed rebuild must poison the replacement"
        );

        // The partial rebuild must not be published by a flush.
        let error = pipeline
            .flush()
            .expect_err("a failed rebuild must not flush");
        assert!(
            matches!(error, EmbedError::DiskError(_)),
            "unexpected error: {error:?}"
        );

        // Nor by an ordinary later upsert.
        pipeline.set_auto_persist(true);
        let error = pipeline
            .upsert("doc-later", "an ordinary later upsert")
            .expect_err("an ordinary upsert must not publish a partial rebuild");
        assert!(
            matches!(error, EmbedError::DiskError(_)),
            "unexpected error: {error:?}"
        );

        let ids = ids_on_disk(&path);
        assert!(
            ids.contains(&"doc-original".to_string()),
            "the original document was lost: {ids:?}"
        );
        assert!(
            !ids.contains(&"doc-new-1".to_string()),
            "a partial rebuild was published: {ids:?}"
        );

        // An explicit discard restores the persisted state.
        pipeline.discard_replacement().expect("discard");
        assert_eq!(pipeline.replacement_state(), ReplacementState::Idle);
        assert_eq!(pipeline.len(), 1, "the discarded rebuild must be gone");
    }

    /// A conflicting write that preserves size AND mtime must still be
    /// detected — the conflict check compares a digest of the bytes.
    #[test]
    fn replacement_conflict_detects_same_size_same_timestamp_change() {
        let path = temp_index_path("digest-conflict");
        let mut pipeline = pipeline_for(&path);
        pipeline.upsert("doc-a", "aaaa").expect("upsert");

        let original = fs::read_to_string(&path).expect("read");
        let original_mtime = fs::metadata(&path)
            .expect("metadata")
            .modified()
            .expect("mtime");

        // Another writer rewrites the file IN PLACE with different
        // content of the SAME length and restores the mtime: the stat
        // fingerprint (size + mtime + inode) is unchanged.
        let conflicting = original.replace("aaaa", "bbbb");
        assert_eq!(
            conflicting.len(),
            original.len(),
            "the conflicting write must keep the size"
        );
        {
            use std::io::Write;
            let mut file = fs::OpenOptions::new()
                .write(true)
                .open(&path)
                .expect("open");
            file.set_len(0).expect("truncate");
            file.write_all(conflicting.as_bytes()).expect("write");
            file.sync_all().expect("sync");
            let times = fs::FileTimes::new().set_modified(original_mtime);
            file.set_times(times).expect("set times");
        }

        pipeline.clear_in_memory_only();
        let error = pipeline
            .flush()
            .expect_err("the conflicting replacement must fail closed");
        assert!(
            matches!(error, EmbedError::DiskError(_)),
            "unexpected error: {error:?}"
        );
        assert!(
            error.to_string().contains("index_conflict"),
            "unexpected error: {error:?}"
        );
        assert_eq!(
            fs::read_to_string(&path).expect("read back"),
            conflicting,
            "the conflicting file must be preserved"
        );
    }
}
