use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

use memphis_case_index::CaseIndexRow;
use memphis_core::block::Block;
use memphis_core::harness;
use memphis_core::loop_engine::{LoopAction, LoopLimits, LoopState};
use memphis_core::signature::{sign_block, verify_block_signature_with_allowlist};
use memphis_core::soul::{validate_block, validate_block_strict};use memphis_embed::{
    set_shutdown_barrier, EmbedConfig, EmbedPersistenceConfig,
    EmbedPersistenceLoadState, EmbedPipeline, ReplacementState,
};
// `EmbedMode` is only named by the test-time view of the process
// environment (`current_embed_mode`); the production path reads the mode
// off the map it already holds, so the import would be dead code there.
#[cfg(test)]
use memphis_embed::EmbedMode;
// `napi-derive` does NOT generate the export registration when it expands
// under `cfg(test)` — see `gen_fn_register` in napi-derive-backend, which
// returns an empty token stream when `cfg!(test)` is true. The result is that
// under `cargo test` nothing references these functions, and the dead-code
// lint reports every one of them as unused.
//
// They are not unused. `src/infra/storage/rust-bridge-manifest.ts` and
// `rust-vault-adapter.ts` map all six of them onto the JS surface, and the
// production build -- where the registration IS generated -- exports them.
// The lint is measuring the test build, not the code.
//
// The allow is scoped to `cfg(test)` on purpose: in a normal build the
// registration exists and the lint has nothing to say.
#[cfg_attr(test, allow(dead_code))]
mod vault_bridge;

// The bridge's export vocabulary — one owner. See `bridge_exports.rs`.
pub mod bridge_exports;
use bridge_exports::BridgeExportBinding;

// The bridge's payload shapes — one owner. See `bridge_payloads.rs`.
pub mod bridge_payloads;

use memphis_vault::types::VaultInitRequest;
use memphis_vault::vault::init_vault;
use napi_derive::napi;
use serde::{Deserialize, Serialize};

#[derive(Serialize)]
struct ApiResult<T: Serialize> {
    ok: bool,
    data: Option<T>,
    error: Option<String>,
}

fn ok<T: Serialize>(data: T) -> String {
    serde_json::to_string(&ApiResult {
        ok: true,
        data: Some(data),
        error: None,
    })
    .unwrap_or_else(|_| "{\"ok\":false,\"error\":\"serialization_failed\"}".to_string())
}

fn err(msg: impl Into<String>) -> String {
    serde_json::to_string(&ApiResult::<serde_json::Value> {
        ok: false,
        data: None,
        error: Some(msg.into()),
    })
    .unwrap_or_else(|_| "{\"ok\":false,\"error\":\"unknown\"}".to_string())
}

/// The manifest of the bridge — its export vocabulary, served.
///
/// It used to be a `serde_json::json!` literal — a payload with no owner,
/// which is how the TypeScript side ended up hand-writing the shape (and
/// writing it with two fields the wire always sends marked OPTIONAL).
///
/// The fields are declared in the order the literal produced them —
/// alphabetically, because a literal is a `serde_json::Value` with a
/// sorted map — so the wire this struct writes is byte for byte the wire
/// the literal wrote.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BridgeManifestOut {
    /// The bindings. OPTIONAL in the CONTRACT: a binary older than the
    /// vocabulary table (before 2026-11-23) does not send it, and the
    /// export projection fails loudly when it is missing. THIS binary
    /// always sends it.
    #[serde(skip_serializing_if = "Option::is_none")]
    export_bindings: Option<Vec<BridgeExportBinding>>,
    /// Every export, by its canonical name.
    exports: Vec<&'static str>,
    /// The name of the bridge.
    name: &'static str,
    /// The exports the runtime does NOT require.
    ///
    /// It used to be a hand-written list of two names — a leftover from
    /// June 2026, from before the vocabulary table existed. It named
    /// `mv2_export` and `mv2_inspect` while the table already knew TEN
    /// optional exports. It is derived from the table now, so the answer
    /// cannot drift from the rule it reports.
    optional_exports: Vec<&'static str>,
    /// The exports the runtime requires.
    required_exports: Vec<&'static str>,
    /// The version of the manifest's own shape.
    schema_version: u32,
}

#[napi(catch_unwind, js_name = "bridge_manifest")]
pub fn bridge_manifest() -> String {
    // The vocabulary comes from ONE table — `bridge_exports::BRIDGE_EXPORTS`.
    // It used to be a hand-written list right here, and it had drifted: it
    // named 34 exports where the bridge has 42, and it named nine of them
    // with a spelling the bridge never exports. The table is checked against
    // this crate's own `#[napi]` declarations by
    // `crates/memphis-napi/tests/bridge_export_contract.rs`.
    ok(BridgeManifestOut {
        export_bindings: Some(bridge_exports::bindings()),
        exports: bridge_exports::canonical_names(),
        name: "memphis-napi",
        optional_exports: bridge_exports::optional_names(),
        required_exports: bridge_exports::required_names(),
        schema_version: 1,
    })
}

/// The bridge's payload shapes — the layer under the vocabulary.
///
/// E-01 gave the export NAMES one owner. This gives the SHAPE of what
/// those exports carry one owner: `bridge_payloads::BRIDGE_PAYLOADS`,
/// measured off the built module on 2026-11-24. Until then the shape was
/// guessed in seven TypeScript files — `entries_json ?? entriesJson`,
/// `error_code ?? errorCode`, a hand-written `RawEmbedStoreResult` whose
/// `normalized` was the wrong type — and every guess was a second copy of
/// a rule the owner already knew.
///
/// `required: false` in the export table: the runtime does not need this
/// export to start, and an old binary without it keeps working.
#[napi(catch_unwind, js_name = "bridge_payload_manifest")]
pub fn bridge_payload_manifest() -> String {
    ok(bridge_payloads::manifest())
}

/// The answer of `chain_validate`.
///
/// It used to be a `serde_json::json!` literal — a payload with no owner,
/// which is how the TypeScript side ended up hand-writing its shape. The
/// struct makes the shape checkable, and `skip_serializing_if` keeps the
/// keys exactly as they were: `errors` is ABSENT on the success path, not
/// null.
#[derive(Serialize)]
struct ChainValidateOut {
    valid: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    errors: Option<Vec<String>>,
}

/// The answer of `chain_append`.
///
/// Two variants, one struct: the accepted path carries `length` and
/// `chain`, the rejected path carries `errors`. The three keys that are
/// not there are absent, not null.
#[derive(Serialize)]
struct ChainAppendOut {
    appended: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    errors: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    length: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    chain: Option<Vec<Block>>,
}

/// The answer of `chain_query` — the chain and how many blocks it holds.
#[derive(Serialize)]
struct ChainQueryOut {
    count: usize,
    blocks: Vec<Block>,
}

/// The answer of `soul_loop_step`.
///
/// `reason` is ABSENT when the step applied, and present when it did not.
#[derive(Serialize)]
struct SoulLoopStepOut {
    applied: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    reason: Option<String>,
    state: LoopState,
}

/// The answer of `case_append`.
///
/// Same two-variant shape as `chain_append`, plus `indexed` — whether the
/// SQLite case index took the block.
#[derive(Serialize)]
struct CaseAppendOut {
    appended: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    errors: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    indexed: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    length: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    chain: Option<Vec<Block>>,
}

/// The answer of `case_query` — the rows the case index holds.
#[derive(Serialize)]
struct CaseQueryOut {
    count: usize,
    entries: Vec<CaseIndexRow>,
}

#[derive(Serialize)]
struct EmbedStoreOut {
    id: String,
    count: usize,
    dim: usize,
    dtype: String,
    provider: String,
    normalized: String,
    persistence_enabled: bool,
    persistence_load_state: String,
}

#[derive(Deserialize)]
struct EmbedStoreItem {
    id: String,
    text: String,
    #[serde(default)]
    tags: Vec<String>,
}

#[derive(Serialize)]
struct EmbedStoreManyOut {
    inserted: usize,
    count: usize,
    dim: usize,
    dtype: String,
    provider: String,
    normalized: String,
    persistence_enabled: bool,
}

/// The answer of `embed_clear_in_memory`.
///
/// It used to be a `serde_json::json!({ "cleared": true })` literal — a
/// payload with no owner, which is how the TypeScript side ended up
/// hand-writing its shape. The struct makes the shape checkable.
#[derive(Serialize)]
struct EmbedClearOut {
    cleared: bool,
}

/// The answer of `embed_reset`.
///
/// Same wire as `EmbedClearOut`, different meaning: `embed_reset` commits
/// the empty index to disk, `embed_clear_in_memory` does not. Two exports,
/// two payloads — the TypeScript side used to read both as "cleared",
/// which is true of the key and silent about the difference.
#[derive(Serialize)]
struct EmbedResetOut {
    cleared: bool,
}

/// The answer of `embed_discard_replacement`.
///
/// MEASURED 2026-11-24 on the built module: this payload has TWO shapes.
/// Without an initialized pipeline it carries three keys; with one it
/// carries seven. The four variant-only keys are `Option`s with
/// `skip_serializing_if`, so they stay ABSENT — the wire keeps exactly the
/// keys it had, in exactly the order it had them.
///
/// The TypeScript side declared `{ discarded: boolean }` and threw the
/// other six away without knowing they were there. The owner declares
/// all seven now, and the gate checks the struct against the table.
#[derive(Serialize)]
struct EmbedDiscardOut {
    discarded: bool,
    was_initialized: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    previous_replacement_state: Option<String>,
    replacement_state: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    count: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    persistence_enabled: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    persistence_load_state: Option<String>,
}

#[derive(Serialize)]
struct EmbedFlushOut {
    flushed: bool,
    dim: usize,
    dtype: String,
}

#[derive(Serialize)]
struct EmbedSearchHitOut {
    id: String,
    score: f32,
    text_preview: String,
    tags: Vec<String>,
}

#[derive(Serialize)]
struct EmbedSearchOut {
    query: String,
    count: usize,
    dim: usize,
    dtype: String,
    provider: String,
    normalized: String,
    hits: Vec<EmbedSearchHitOut>,
}

static EMBED_PIPELINE: OnceLock<Mutex<EmbedPipeline>> = OnceLock::new();

fn parse_bool_env(name: &str, default: bool) -> bool {
    std::env::var(name)
        .ok()
        .map(|v| v.trim().eq_ignore_ascii_case("true"))
        .unwrap_or(default)
}

fn require_signed_blocks() -> bool {
    parse_bool_env("RUST_CHAIN_REQUIRE_SIGNATURES", false)
}

fn signer_key_from_env() -> Result<Option<[u8; 32]>, String> {
    let raw = match std::env::var("RUST_CHAIN_SIGNER_KEY_HEX") {
        Ok(v) => v,
        Err(_) => return Ok(None),
    };

    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }

    let bytes =
        hex::decode(trimmed).map_err(|e| format!("invalid RUST_CHAIN_SIGNER_KEY_HEX: {e}"))?;
    let key_bytes: [u8; 32] = bytes
        .as_slice()
        .try_into()
        .map_err(|_| "invalid RUST_CHAIN_SIGNER_KEY_HEX: expected 32-byte hex".to_string())?;
    Ok(Some(key_bytes))
}

fn maybe_sign_unsigned_block(block: &mut Block) -> Result<(), String> {
    if block.signer.is_some() || block.signature.is_some() {
        return Ok(());
    }

    let signer_key = signer_key_from_env()?;
    if let Some(key) = signer_key {
        sign_block(block, &key).map_err(|e| format!("block_sign_failed: {e}"))?;
    }
    Ok(())
}

fn parse_u64_env(name: &str, default: u64) -> u64 {
    std::env::var(name)
        .ok()
        .and_then(|v| v.trim().parse::<u64>().ok())
        .unwrap_or(default)
}

fn parse_usize_env(name: &str, default: usize) -> usize {
    std::env::var(name)
        .ok()
        .and_then(|v| v.trim().parse::<usize>().ok())
        .unwrap_or(default)
}

fn signer_allowlist_from_env() -> Vec<String> {
    match std::env::var("RUST_CHAIN_SIGNER_ALLOWLIST") {
        Ok(v) => v
            .split(',')
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect(),
        Err(_) => vec![],
    }
}

fn trim_opt_env(name: &str) -> Option<String> {
    std::env::var(name).ok().and_then(|v| {
        let s = v.trim().to_string();
        if s.is_empty() {
            None
        } else {
            Some(s)
        }
    })
}

/// The embedding mode of THIS process, as the owner sees it.
///
/// A thin delegate: the vocabulary lives in the owner
/// (`memphis_embed::profile::embed_mode_from_env`). This file used to carry
/// its own copy of the same words in the same order, which is one copy too
/// many - a name added to one side silently means "local deterministic" on
/// the other, and the profile's verdict flips to `no-provider`.
///
/// Test-only on purpose: production reads the mode off the environment map
/// it already has (`embed_config_from_env`), and a second reading of the
/// process environment could only ever disagree with the first.
#[cfg(test)]
fn current_embed_mode() -> EmbedMode {
    let env = std::env::vars().collect::<HashMap<String, String>>();
    memphis_embed::embed_mode_from_env(&env)
}

fn embed_config_from_env() -> EmbedConfig {
    // The embed profile has ONE owner (`memphis_embed::profile`). This used
    // to carry its own copy of the mode vocabulary and a hard-coded dimension
    // of 32 - `DEFAULT_EMBEDDING_DIM`, the width of the local deterministic
    // embedder, applied even when a real provider was configured. Measured
    // 2026-11-23: the service answers `mode: semantic` with dim 1024, while
    // a process without the service's environment answered
    // `index_dimension_mismatch: disk_dim=768 config_dim=32`.
    let env = std::env::vars().collect::<HashMap<String, String>>();
    let mode = memphis_embed::embed_mode_from_env(&env);
    let dim = memphis_embed::resolve_embed_profile(&env, &napi_runtime_root(), &mode).dimension;
    EmbedConfig {
        mode,
        dim,
        max_text_bytes: parse_usize_env("RUST_EMBED_MAX_TEXT_BYTES", 4096),
        provider_url: trim_opt_env("RUST_EMBED_PROVIDER_URL"),
        provider_api_key: trim_opt_env("RUST_EMBED_PROVIDER_API_KEY"),
        provider_model: trim_opt_env("RUST_EMBED_PROVIDER_MODEL"),
        provider_timeout_ms: parse_u64_env("RUST_EMBED_PROVIDER_TIMEOUT_MS", 8000),
        // Same env var the TypeScript provider reads
        // (`src/providers/index.ts`). Without it the Rust side omits
        // `keep_alive` from the Ollama request, so the server unloads
        // the model after 5 idle minutes and every embed pays a cold load.
        provider_keep_alive: trim_opt_env("OLLAMA_KEEP_ALIVE"),
    }
}

/// The directory relative paths are resolved against.
///
/// `MEMPHIS_RUNTIME_ROOT` when the operator sets it, the working directory
/// otherwise - the same rule `embed_persistence_path_from_env` used.
fn napi_runtime_root() -> PathBuf {
    std::env::var("MEMPHIS_RUNTIME_ROOT")
        .map(PathBuf::from)
        .unwrap_or_else(|_| std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")))
}

fn embed_persistence_enabled_from_env() -> bool {
    parse_bool_env("RUST_EMBED_PERSIST_ENABLED", true)
}

fn embed_persistence_path_from_env() -> PathBuf {
    let env = std::env::vars().collect();
    let root = std::env::var("MEMPHIS_RUNTIME_ROOT")
        .map(PathBuf::from)
        .unwrap_or_else(|_| std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")));
    memphis_paths::resolve_embed_index_path(&env, &root)
}

fn load_state_to_str(state: EmbedPersistenceLoadState) -> &'static str {
    match state {
        EmbedPersistenceLoadState::Disabled => "disabled",
        EmbedPersistenceLoadState::Missing => "missing",
        EmbedPersistenceLoadState::Empty => "empty",
        EmbedPersistenceLoadState::Loaded => "loaded",
        EmbedPersistenceLoadState::Corrupt => "corrupt",
    }
}

fn embed_normalized_to_str(provider: &str) -> &'static str {
    if provider == "local-deterministic" {
        "true"
    } else {
        "provider-dependent"
    }
}

fn replacement_state_to_str(state: ReplacementState) -> &'static str {
    match state {
        ReplacementState::Idle => "idle",
        ReplacementState::Armed => "armed",
        ReplacementState::Failed => "failed",
    }
}

fn get_embed_pipeline() -> Result<&'static Mutex<EmbedPipeline>, String> {
    if let Some(p) = EMBED_PIPELINE.get() {
        return Ok(p);
    }

    let persistence_enabled = embed_persistence_enabled_from_env();
    let persistence = EmbedPersistenceConfig {
        enabled: persistence_enabled,
        index_path: embed_persistence_path_from_env(),
    };

    let pipeline = EmbedPipeline::with_persistence(embed_config_from_env(), persistence)
        .map_err(|e| format!("embed_pipeline_init_failed: {e}"))?;

    Ok(EMBED_PIPELINE.get_or_init(|| Mutex::new(pipeline)))
}

#[napi(catch_unwind, js_name = "embed_index_metadata")]
pub fn embed_index_metadata(path: String) -> String {
    ok(memphis_embed::metadata::inspect_index(
        std::path::Path::new(&path),
    ))
}

#[napi(catch_unwind, js_name = "chain_validate")]
pub fn chain_validate(block_json: String, prev_json: Option<String>) -> String {
    let block: Block = match serde_json::from_str(&block_json) {
        Ok(v) => v,
        Err(e) => return err(format!("invalid_block_json: {e}")),
    };

    let prev: Option<Block> = match prev_json {
        Some(s) => match serde_json::from_str(&s) {
            Ok(v) => Some(v),
            Err(e) => return err(format!("invalid_prev_json: {e}")),
        },
        None => None,
    };

    let validation = if require_signed_blocks() {
        validate_block_strict(&block, prev.as_ref())
    } else {
        validate_block(&block, prev.as_ref())
    };

    match validation {
        Ok(()) => {
            let allowlist = signer_allowlist_from_env();
            if !allowlist.is_empty() {
                match verify_block_signature_with_allowlist(&block, &allowlist) {
                    Ok(true) => ok(ChainValidateOut { valid: true, errors: None }),
                    Ok(false) => ok(ChainValidateOut {
                        valid: false,
                        errors: Some(vec!["block unsigned but signer allowlist is configured".to_string()]),
                    }),
                    Err(e) => ok(ChainValidateOut {
                        valid: false,
                        errors: Some(vec![format!("signer allowlist check failed: {e}")]),
                    }),
                }
            } else {
                ok(ChainValidateOut { valid: true, errors: None })
            }
        }
        Err(errors) => ok(ChainValidateOut { valid: false, errors: Some(errors) }),
    }
}

#[napi(catch_unwind, js_name = "chain_append")]
pub fn chain_append(chain_json: String, block_json: String) -> String {
    let mut blocks: Vec<Block> = match serde_json::from_str(&chain_json) {
        Ok(v) => v,
        Err(e) => return err(format!("invalid_chain_json: {e}")),
    };

    let mut block: Block = match serde_json::from_str(&block_json) {
        Ok(v) => v,
        Err(e) => return err(format!("invalid_block_json: {e}")),
    };

    if let Err(e) = maybe_sign_unsigned_block(&mut block) {
        return err(e);
    }

    let prev = blocks.last();
    let validation = if require_signed_blocks() {
        validate_block_strict(&block, prev)
    } else {
        validate_block(&block, prev)
    };

    if let Err(errors) = validation {
        return ok(ChainAppendOut { appended: false, errors: Some(errors), length: None, chain: None });
    }

    let allowlist = signer_allowlist_from_env();
    if !allowlist.is_empty() {
        match verify_block_signature_with_allowlist(&block, &allowlist) {
            Ok(true) => {}
            Ok(false) => {
                return ok(ChainAppendOut {
                    appended: false,
                    errors: Some(vec!["block unsigned but signer allowlist is configured".to_string()]),
                    length: None,
                    chain: None,
                });
            }
            Err(e) => {
                return ok(ChainAppendOut {
                    appended: false,
                    errors: Some(vec![format!("signer allowlist check failed: {e}")]),
                    length: None,
                    chain: None,
                });
            }
        }
    }

    blocks.push(block);
    ok(ChainAppendOut {
        appended: true,
        errors: None,
        length: Some(blocks.len()),
        chain: Some(blocks),
    })
}

#[napi(catch_unwind, js_name = "chain_query")]
pub fn chain_query(chain_json: String, contains: Option<String>, tag: Option<String>) -> String {
    let blocks: Vec<Block> = match serde_json::from_str(&chain_json) {
        Ok(v) => v,
        Err(e) => return err(format!("invalid_chain_json: {e}")),
    };

    let contains_lc = contains.as_ref().map(|s| s.to_lowercase());
    let tag_lc = tag.as_ref().map(|s| s.to_lowercase());

    let result: Vec<&Block> = blocks
        .iter()
        .filter(|b| {
            let content_ok = contains_lc
                .as_ref()
                .map(|needle| b.data.content.to_lowercase().contains(needle))
                .unwrap_or(true);

            let tag_ok = tag_lc
                .as_ref()
                .map(|needle| b.data.tags.iter().any(|t| t.to_lowercase() == *needle))
                .unwrap_or(true);

            content_ok && tag_ok
        })
        .collect();

    // The payload owns its blocks: the struct carries `Vec<Block>`, so the
    // matches are cloned. Only the MATCHING blocks are cloned — the chain
    // itself is not copied.
    ok(ChainQueryOut {
        count: result.len(),
        blocks: result.into_iter().cloned().collect(),
    })
}

#[napi(catch_unwind, js_name = "vault_init_json")]
pub fn vault_init_json(request_json: String) -> String {
    let req: VaultInitRequest = match serde_json::from_str(&request_json) {
        Ok(v) => v,
        Err(e) => return err(format!("invalid_vault_init_json: {e}")),
    };

    match init_vault(req) {
        Ok(v) => ok(v),
        Err(e) => err(format!("vault_init_failed: {e}")),
    }
}

#[napi(catch_unwind, js_name = "embed_store")]
pub fn embed_store(id: String, text: String, tags_json: Option<String>) -> String {
    let pipeline = match get_embed_pipeline() {
        Ok(p) => p,
        Err(e) => return err(e),
    };

    let mut pipeline = match pipeline.lock() {
        Ok(v) => v,
        Err(_) => return err("embed_pipeline_lock_failed"),
    };

    let tags: Vec<String> = tags_json
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default();

    match pipeline.upsert_with_tags(id.clone(), text, tags) {
        Ok(count) => ok(EmbedStoreOut {
            id,
            count,
            dim: pipeline.dim(),
            dtype: "f32".to_string(),
            provider: pipeline.provider_name().to_string(),
            normalized: embed_normalized_to_str(pipeline.provider_name()).to_string(),
            persistence_enabled: pipeline.persistence_enabled(),
            persistence_load_state: load_state_to_str(pipeline.persistence_load_state())
                .to_string(),
        }),
        Err(e) => err(format!("embed_store_failed: {e}")),
    }
}

/// Bulk upsert. Accepts `[{id, text, tags?}, ...]` and inserts every
/// item in one Mutex acquisition WITHOUT triggering a per-item disk
/// write. Caller MUST follow with `embed_flush()` to materialize.
///
/// Why: the per-item `embed_store` path rewrites the entire on-disk
/// index (atomic rename of the full serialized payload) on every call.
/// For a 6326-block rebuild that's ~290 GB of cumulative writes — the
/// bug operator hit on 2026-05-10.
#[napi(catch_unwind, js_name = "embed_store_many")]
pub fn embed_store_many(items_json: String) -> String {
    let items: Vec<EmbedStoreItem> = match serde_json::from_str(&items_json) {
        Ok(v) => v,
        Err(e) => return err(format!("embed_store_many_invalid_input: {e}")),
    };

    let pipeline = match get_embed_pipeline() {
        Ok(p) => p,
        Err(e) => return err(e),
    };

    let mut pipeline = match pipeline.lock() {
        Ok(v) => v,
        Err(_) => return err("embed_pipeline_lock_failed"),
    };

    // Defer per-item persist for the duration of this bulk call. The
    // flag is restored on the way out (set true again) so single-item
    // callers afterwards behave identically.
    let prior_auto_persist = pipeline.auto_persist_enabled();
    pipeline.set_auto_persist(false);

    let inserted = items.len();
    let triples: Vec<(String, String, Vec<String>)> = items
        .into_iter()
        .map(|item| (item.id, item.text, item.tags))
        .collect();

    let result = pipeline.upsert_many(triples);
    pipeline.set_auto_persist(prior_auto_persist);

    match result {
        Ok(count) => ok(EmbedStoreManyOut {
            inserted,
            count,
            dim: pipeline.dim(),
            dtype: "f32".to_string(),
            provider: pipeline.provider_name().to_string(),
            normalized: embed_normalized_to_str(pipeline.provider_name()).to_string(),
            persistence_enabled: pipeline.persistence_enabled(),
        }),
        Err(e) => err(format!("embed_store_many_failed: {e}")),
    }
}

/// Force a write of the in-memory index to disk. Surfaces the I/O
/// error rather than swallowing it (`embed_store`'s best-effort path
/// keeps the live-write loop quiet on flapping disks; bulk rebuilders
/// need to hear about ENOSPC / EROFS / permission denied).
#[napi(catch_unwind, js_name = "embed_flush")]
pub fn embed_flush() -> String {
    let pipeline = match get_embed_pipeline() {
        Ok(p) => p,
        Err(e) => return err(e),
    };

    let mut pipeline = match pipeline.lock() {
        Ok(v) => v,
        Err(_) => return err("embed_pipeline_lock_failed"),
    };

    match pipeline.flush() {
        Ok(_) => ok(EmbedFlushOut {
            flushed: pipeline.persistence_enabled(),
            dim: pipeline.dim(),
            dtype: "f32".to_string(),
        }),
        Err(e) => err(format!("embed_flush_failed: {e}")),
    }
}

#[napi(catch_unwind, js_name = "embed_search")]
pub fn embed_search(query: String, top_k: Option<u32>, tags_json: Option<String>) -> String {
    let pipeline = match get_embed_pipeline() {
        Ok(p) => p,
        Err(e) => return err(e),
    };

    let mut pipeline = match pipeline.lock() {
        Ok(v) => v,
        Err(_) => return err("embed_pipeline_lock_failed"),
    };

    // Observe writes made by another process (operator TUI / daemon)
    // without discarding pending bulk writes.
    if let Err(error) = pipeline.refresh_from_disk() {
        return err(format!("embed_search_failed: {error}"));
    }

    let filter_tags: Option<Vec<String>> = tags_json.and_then(|s| serde_json::from_str(&s).ok());
    let limit = top_k.unwrap_or(5) as usize;
    match pipeline.search_with_tags(&query, limit, filter_tags.as_deref()) {
        Ok(hits) => ok(EmbedSearchOut {
            query,
            count: hits.len(),
            dim: pipeline.dim(),
            dtype: "f32".to_string(),
            provider: pipeline.provider_name().to_string(),
            normalized: embed_normalized_to_str(pipeline.provider_name()).to_string(),
            hits: hits
                .into_iter()
                .map(|h| EmbedSearchHitOut {
                    id: h.id,
                    score: h.score,
                    text_preview: h.text_preview,
                    tags: h.tags,
                })
                .collect(),
        }),
        Err(e) => err(format!("embed_search_failed: {e}")),
    }
}

#[napi(catch_unwind, js_name = "embed_search_tuned")]
pub fn embed_search_tuned(query: String, top_k: Option<u32>, tags_json: Option<String>) -> String {
    let pipeline = match get_embed_pipeline() {
        Ok(p) => p,
        Err(e) => return err(e),
    };

    let mut pipeline = match pipeline.lock() {
        Ok(v) => v,
        Err(_) => return err("embed_pipeline_lock_failed"),
    };

    // Observe writes made by another process (operator TUI / daemon)
    // without discarding pending bulk writes.
    if let Err(error) = pipeline.refresh_from_disk() {
        return err(format!("embed_search_tuned_failed: {error}"));
    }

    let filter_tags: Option<Vec<String>> = tags_json.and_then(|s| serde_json::from_str(&s).ok());
    let limit = top_k.unwrap_or(5) as usize;
    match pipeline.search_tuned_with_tags(&query, limit, filter_tags.as_deref()) {
        Ok(hits) => ok(EmbedSearchOut {
            query,
            count: hits.len(),
            dim: pipeline.dim(),
            dtype: "f32".to_string(),
            provider: pipeline.provider_name().to_string(),
            normalized: embed_normalized_to_str(pipeline.provider_name()).to_string(),
            hits: hits
                .into_iter()
                .map(|h| EmbedSearchHitOut {
                    id: h.id,
                    score: h.score,
                    text_preview: h.text_preview,
                    tags: h.tags,
                })
                .collect(),
        }),
        Err(e) => err(format!("embed_search_tuned_failed: {e}")),
    }
}

#[napi(catch_unwind, js_name = "embed_reset")]
pub fn embed_reset() -> String {
    let pipeline = match get_embed_pipeline() {
        Ok(p) => p,
        Err(e) => return err(e),
    };

    let mut pipeline = match pipeline.lock() {
        Ok(v) => v,
        Err(_) => return err("embed_pipeline_lock_failed"),
    };
    match pipeline.clear() {
        Ok(()) => ok(EmbedResetOut { cleared: true }),
        Err(e) => err(format!("embed_reset_failed: {e}")),
    }
}

/// In-memory only destructive clear (ADR-006, issue #628). The on-disk
/// index is left untouched until the caller invokes `embed_flush`. Use
/// this from bulk rebuild paths that want to avoid the
/// "clear-then-rebuild" data-loss pattern (destructive empty write
/// committed before the new payload is ready). Returns `{cleared: true}`.
///
/// `embed_reset` (above) keeps its current "wipe and persist" semantics
/// for the CLI subcommand and doctor diagnostics, where the operator
/// explicitly wants the on-disk file emptied.
#[napi(catch_unwind, js_name = "embed_clear_in_memory")]
pub fn embed_clear_in_memory() -> String {
    let pipeline = match get_embed_pipeline() {
        Ok(p) => p,
        Err(e) => return err(e),
    };

    let mut pipeline = match pipeline.lock() {
        Ok(v) => v,
        Err(_) => return err("embed_pipeline_lock_failed"),
    };
    pipeline.clear_in_memory_only();
    ok(EmbedClearOut { cleared: true })
}

/// Explicitly abandon an armed or failed index replacement.
///
/// The on-disk index is left EXACTLY as it is: a rebuild that was
/// interrupted between batches must never publish a partial index. The
/// in-memory contents are reloaded from the persisted index, so the
/// pipeline continues from the persisted state instead of the
/// half-finished rebuild.
///
/// Returns `{discarded: true, previous_replacement_state, replacement_state,
/// count, persistence_enabled, persistence_load_state}`. When the pipeline
/// was never initialized there is nothing to discard and the call
/// reports `{discarded: false, was_initialized: false}`.
#[napi(catch_unwind, js_name = "embed_discard_replacement")]
pub fn embed_discard_replacement() -> String {
    let Some(pipeline_mutex) = EMBED_PIPELINE.get() else {
        // Nothing was ever initialized: there is no replacement in
        // flight and nothing to discard. Not an error — the caller
        // asked for a no-op and got one.
        return ok(EmbedDiscardOut {
            discarded: false,
            was_initialized: false,
            previous_replacement_state: None,
            replacement_state: replacement_state_to_str(ReplacementState::Idle).to_string(),
            count: None,
            persistence_enabled: None,
            persistence_load_state: None,
        });
    };

    let mut pipeline = match pipeline_mutex.lock() {
        Ok(v) => v,
        Err(_) => return err("embed_pipeline_lock_failed"),
    };

    let previous = pipeline.replacement_state();
    match pipeline.discard_replacement() {
        Ok(()) => ok(EmbedDiscardOut {
            discarded: true,
            was_initialized: true,
            previous_replacement_state: Some(replacement_state_to_str(previous).to_string()),
            replacement_state: replacement_state_to_str(ReplacementState::Idle).to_string(),
            count: Some(pipeline.len()),
            persistence_enabled: Some(pipeline.persistence_enabled()),
            persistence_load_state: Some(
                load_state_to_str(pipeline.persistence_load_state()).to_string(),
            ),
        }),
        // Fail closed: a replacement that cannot be restored from
        // unreadable storage is still NOT published, but the caller
        // must see the failure.
        Err(e) => err(format!("embed_discard_replacement_failed: {e}")),
    }
}

/// Release the embed pipeline synchronously before V8 teardown.
///
/// Bug 3 (docs/dev/BUG3-SEGV-INVESTIGATION.md): intermittent SIGSEGV on
/// process exit caused by a race between V8 isolate teardown and the
/// Rust `OnceLock<Mutex<EmbedPipeline>>` static's implicit destructor.
/// By serializing the teardown — callers invoke `embed_shutdown()`
/// **before** calling `process.exit()` — we guarantee the Mutex is not
/// held and any persistence flush has already completed before V8
/// starts freeing NAPI env resources.
///
/// Semantics:
///   - If the pipeline was initialized: acquire the Mutex, flush persistence
///     without clearing the in-memory index, return {"shutdown": true,
///     "was_initialized": true}. The shutdown barrier below makes the later
///     static Drop leak heap-heavy fields safely, so clearing is unnecessary
///     and would destroy the persisted recall index.
///   - If never initialized: no-op, return {"shutdown": true,
///     "was_initialized": false}. Safe to call unconditionally.
///   - If Mutex is poisoned (another thread panicked while holding it):
///     return "embed_pipeline_lock_poisoned" so the JS side can log.
///     Non-fatal — process still exits cleanly.
///
/// Idempotent: calling twice is safe; second call finds the pipeline
/// empty and does nothing. Called from `performGracefulShutdown()`
/// between PULSE flush and `exitFn()` per graceful-shutdown.ts step 4.5.
#[napi(catch_unwind, js_name = "embed_shutdown")]
pub fn embed_shutdown() -> String {
    let result = match EMBED_PIPELINE.get() {
        Some(pipeline_mutex) => match pipeline_mutex.lock() {
            Ok(mut pipeline) => {
                // An interrupted rebuild — a replacement that is `Armed` or
                // `Failed` — must NEVER be published at shutdown: its
                // in-memory contents may be a partial rebuild, and writing
                // it would replace a good index with a half-finished copy.
                // Discard it instead and report that nothing was flushed.
                let replacement_state = pipeline.replacement_state();
                match replacement_state {
                    ReplacementState::Armed | ReplacementState::Failed => {
                        match pipeline.discard_replacement() {
                            Ok(()) => ok(serde_json::json!({
                                "shutdown": true,
                                "was_initialized": true,
                                "discarded_replacement": true,
                                "replacement_state": replacement_state_to_str(replacement_state),
                            })),
                            Err(e) => {
                                err(format!("embed_shutdown_discard_replacement_failed: {e}"))
                            }
                        }
                    }
                    ReplacementState::Idle => match pipeline.flush() {
                        Ok(_) => {
                            ok(serde_json::json!({ "shutdown": true, "was_initialized": true }))
                        }
                        Err(e) => err(format!("embed_shutdown_flush_failed: {e}")),
                    },
                }
            }
            Err(_) => err("embed_pipeline_lock_poisoned"),
        },
        None => ok(serde_json::json!({ "shutdown": true, "was_initialized": false })),
    };
    // Track B: arm the shutdown barrier so any subsequent Drop of an
    // EmbedPipeline (including the implicit Drop of the static at
    // dlclose time) leaks heap-heavy fields rather than freeing them
    // through a teardown-state allocator. The barrier is process-wide
    // and one-way; idempotent if `embed_shutdown()` is called more
    // than once. See `crates/memphis-embed/src/pipeline.rs::SHUTDOWN_BARRIER`
    // and `docs/dev/SHUTDOWN-LIFECYCLE.md` (Track B).
    set_shutdown_barrier();
    result
}

#[napi(catch_unwind, js_name = "soul_loop_step")]
pub fn soul_loop_step(
    state_json: String,
    action_json: String,
    limits_json: Option<String>,
) -> String {
    let mut state: LoopState = match serde_json::from_str(&state_json) {
        Ok(v) => v,
        Err(e) => return err(format!("invalid_state_json: {e}")),
    };

    let action: LoopAction = match serde_json::from_str(&action_json) {
        Ok(v) => v,
        Err(e) => return err(format!("invalid_action_json: {e}")),
    };

    let limits: LoopLimits = match limits_json {
        Some(s) => match serde_json::from_str(&s) {
            Ok(v) => v,
            Err(e) => return err(format!("invalid_limits_json: {e}")),
        },
        None => LoopLimits::default(),
    };

    match state.apply(&action, &limits) {
        Ok(()) => ok(SoulLoopStepOut { applied: true, reason: None, state }),
        Err(reason) => ok(SoulLoopStepOut { applied: false, reason: Some(reason), state }),
    }
}

#[napi(catch_unwind, js_name = "soul_replay")]
pub fn soul_replay(chain_name: String, blocks_json: String) -> String {
    let blocks: Vec<Block> = match serde_json::from_str(&blocks_json) {
        Ok(v) => v,
        Err(e) => return err(format!("invalid_blocks_json: {e}")),
    };

    let report = harness::replay(chain_name, &blocks);
    ok(report)
}

// ── Case-based chain functions ────────────────────────────────────────

/// Append a case entry to a chain and index it.
///
/// The SOURCE is the chain DIRECTORY the blocks were read from, and it is
/// OPTIONAL: a caller that does not pass one gets the legacy behaviour
/// (the legacy bucket), so an older caller against this bridge keeps
/// working exactly as it did.
#[napi(catch_unwind, js_name = "case_append")]
pub fn case_append(
    chain_json: String,
    entry_json: String,
    index_db_path: String,
    source: Option<String>,
) -> String {
    use memphis_case_index::CaseIndex;
    use memphis_core::block::{BlockData, BlockType};
    use memphis_core::case_entry::CaseEntry;
    use memphis_core::hash::compute_hash;

    // Parse existing chain blocks
    let mut blocks: Vec<Block> = match serde_json::from_str(&chain_json) {
        Ok(v) => v,
        Err(e) => return err(format!("invalid_chain_json: {e}")),
    };

    // Parse and validate case entry
    let entry: CaseEntry = match serde_json::from_str(&entry_json) {
        Ok(v) => v,
        Err(e) => return err(format!("invalid_entry_json: {e}")),
    };
    if let Err(e) = entry.validate() {
        return err(format!("case_entry_validation_failed: {e}"));
    }

    // Build block
    let prev = blocks.last();
    let index = prev.map(|b| b.index + 1).unwrap_or(0);
    let prev_hash = prev
        .map(|b| b.hash.clone())
        .unwrap_or_else(|| "0".repeat(64));
    let timestamp = chrono::Utc::now().to_rfc3339();

    let content = match entry.to_block_content() {
        Ok(c) => c,
        Err(e) => return err(format!("case_entry_serialize_failed: {e}")),
    };

    let mut block = Block {
        index,
        timestamp,
        chain: "cases".to_string(),
        data: BlockData {
            block_type: BlockType::Case,
            content,
            tags: vec![entry.tag()],
        },
        prev_hash,
        hash: String::new(),
        signer: None,
        signature: None,
    };
    block.hash = compute_hash(&block);

    // Auto-sign if configured
    if let Err(e) = maybe_sign_unsigned_block(&mut block) {
        return err(e);
    }

    // Validate block
    let validation = if require_signed_blocks() {
        validate_block_strict(&block, blocks.last())
    } else {
        validate_block(&block, blocks.last())
    };
    if let Err(errors) = validation {
        return ok(CaseAppendOut {
            appended: false,
            errors: Some(errors),
            indexed: None,
            length: None,
            chain: None,
        });
    }

    // Index into SQLite
    let index_result = CaseIndex::open(std::path::Path::new(&index_db_path))
        .and_then(|idx| {
            idx.index_block(
                &block,
                source.as_deref().unwrap_or(memphis_case_index::LEGACY_SOURCE),
            )
            .map(|_| ())
        });
    let indexed = index_result.is_ok();
    if let Err(e) = index_result {
        eprintln!("case_index warning: {e}");
    }

    blocks.push(block);
    ok(CaseAppendOut {
        appended: true,
        errors: None,
        indexed: Some(indexed),
        length: Some(blocks.len()),
        chain: Some(blocks),
    })
}

/// Query the index within one SOURCE.
///
/// The source is optional for the same reason as in `case_append`: without
/// one the query runs in the legacy bucket, which is what it did before.
#[napi(catch_unwind, js_name = "case_query")]
pub fn case_query(
    query_json: String,
    index_db_path: String,
    source: Option<String>,
) -> String {
    use memphis_case_index::CaseIndex;
    use memphis_core::case_entry::CaseQuery;

    let query: CaseQuery = match serde_json::from_str(&query_json) {
        Ok(v) => v,
        Err(e) => return err(format!("invalid_query_json: {e}")),
    };

    let idx = match CaseIndex::open(std::path::Path::new(&index_db_path)) {
        Ok(v) => v,
        Err(e) => return err(format!("case_index_open_failed: {e}")),
    };

    match idx.query(
        &query,
        source.as_deref().unwrap_or(memphis_case_index::LEGACY_SOURCE),
    ) {
        Ok(rows) => ok(CaseQueryOut { count: rows.len(), entries: rows }),
        Err(e) => err(format!("case_query_failed: {e}")),
    }
}

/// Rebuild the index from a chain's blocks, within one SOURCE.
///
/// The source is optional for the same reason as in `case_append`. The
/// rebuild's scope is the source: it replaces that source's rows and
/// leaves every other source's alone.
#[napi(catch_unwind, js_name = "case_rebuild")]
pub fn case_rebuild(
    blocks_json: String,
    index_db_path: String,
    source: Option<String>,
) -> String {
    std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        case_rebuild_inner(blocks_json, index_db_path, source)
    }))
    .unwrap_or_else(|_| err("case_rebuild_panic"))
}

fn case_rebuild_inner(
    blocks_json: String,
    index_db_path: String,
    source: Option<String>,
) -> String {
    use memphis_case_index::CaseIndex;

    let blocks: Vec<Block> = match serde_json::from_str(&blocks_json) {
        Ok(v) => v,
        Err(e) => return err(format!("invalid_blocks_json: {e}")),
    };

    let idx = match CaseIndex::open(std::path::Path::new(&index_db_path)) {
        Ok(v) => v,
        Err(e) => return err(format!("case_index_open_failed: {e}")),
    };

    match idx.rebuild(
        &blocks,
        source.as_deref().unwrap_or(memphis_case_index::LEGACY_SOURCE),
    ) {
        Ok(report) => ok(report),
        Err(e) => err(format!("case_rebuild_failed: {e}")),
    }
}

/// What the case index holds — the health of the cache.
///
/// MEASURED 2026-11-24 on the operator's host: the index held 1 372
/// entries where the `cases` chain holds 2 190 case blocks, and the
/// missing 818 included the host's ONLY nominative entry and BOTH
/// instrumental ones. The index is a cache of the chain — the chain files
/// are the source of truth — and nothing asked it whether it was in step.
///
/// This export is the question. The caller compares the count with the
/// chain's own count of case blocks and repairs the index when they
/// differ; the repair (`case_rebuild`) already existed and was never
/// called.
/// What the index holds for one SOURCE — the health of the cache.
///
/// The source is optional, and the answer says which source it is about
/// and whether this binary understands the source at all. That last flag is
/// the compatibility window's handshake: a caller that does not find it
/// knows the binary in front of it predates the source.
#[napi(catch_unwind, js_name = "case_index_status")]
pub fn case_index_status(index_db_path: String, source: Option<String>) -> String {
    use memphis_case_index::CaseIndex;

    let idx = match CaseIndex::open(std::path::Path::new(&index_db_path)) {
        Ok(v) => v,
        Err(e) => return err(format!("case_index_open_failed: {e}")),
    };

    match idx.status(source.as_deref().unwrap_or(memphis_case_index::LEGACY_SOURCE)) {
        Ok(status) => ok(status),
        Err(e) => err(format!("case_index_status_failed: {e}")),
    }
}

// ── memphis-paths bridge ────────────────────────────────────────────────────
//
// Pure path resolution shared with TS callers (src/config/paths.ts +
// src/infra/storage/vault-paths.ts after the PR8 migration). The Rust
// crate `memphis-paths` is the single source of truth — these wrappers
// just deserialize the env map / cwd, call the resolver, and stringify
// the absolute path back into the standard ApiResult JSON envelope.

fn parse_env_json(env_json: &str) -> Result<std::collections::HashMap<String, String>, String> {
    serde_json::from_str::<std::collections::HashMap<String, String>>(env_json)
        .map_err(|e| format!("env_json must deserialize to a string→string map: {e}"))
}

fn pathbuf_to_string(p: std::path::PathBuf) -> Result<String, String> {
    p.to_str()
        .map(|s| s.to_string())
        .ok_or_else(|| "resolved path is not valid UTF-8".to_string())
}

#[napi(catch_unwind)]
pub fn paths_resolve_data_dir(env_json: String, cwd: String) -> String {
    let env = match parse_env_json(&env_json) {
        Ok(env) => env,
        Err(e) => return err(e),
    };
    let resolved = memphis_paths::resolve_data_dir(&env, std::path::Path::new(&cwd));
    match pathbuf_to_string(resolved) {
        Ok(s) => ok(s),
        Err(e) => err(e),
    }
}

#[napi(catch_unwind)]
pub fn paths_resolve_vault_state(env_json: String, cwd: String) -> String {
    let env = match parse_env_json(&env_json) {
        Ok(env) => env,
        Err(e) => return err(e),
    };
    let resolved = memphis_paths::resolve_vault_state_path(&env, std::path::Path::new(&cwd));
    match pathbuf_to_string(resolved) {
        Ok(s) => ok(s),
        Err(e) => err(e),
    }
}

#[napi(catch_unwind)]
pub fn paths_resolve_vault_entries(env_json: String, cwd: String) -> String {
    let env = match parse_env_json(&env_json) {
        Ok(env) => env,
        Err(e) => return err(e),
    };
    let resolved = memphis_paths::resolve_vault_entries_path(&env, std::path::Path::new(&cwd));
    match pathbuf_to_string(resolved) {
        Ok(s) => ok(s),
        Err(e) => err(e),
    }
}

#[napi(catch_unwind)]
pub fn paths_resolve_chains_dir(env_json: String, cwd: String) -> String {
    let env = match parse_env_json(&env_json) {
        Ok(env) => env,
        Err(e) => return err(e),
    };
    let resolved = memphis_paths::resolve_chains_dir(&env, std::path::Path::new(&cwd));
    match pathbuf_to_string(resolved) {
        Ok(s) => ok(s),
        Err(e) => err(e),
    }
}

#[napi(catch_unwind)]
pub fn paths_resolve_chain_path(env_json: String, cwd: String, chain_name: String) -> String {
    let env = match parse_env_json(&env_json) {
        Ok(env) => env,
        Err(e) => return err(e),
    };
    let resolved = memphis_paths::resolve_chain_path(&env, std::path::Path::new(&cwd), &chain_name);
    match pathbuf_to_string(resolved) {
        Ok(s) => ok(s),
        Err(e) => err(e),
    }
}

#[napi(catch_unwind)]
pub fn paths_resolve_embed_index(env_json: String, cwd: String) -> String {
    let env = match parse_env_json(&env_json) {
        Ok(env) => env,
        Err(e) => return err(e),
    };
    let resolved = memphis_paths::resolve_embed_index_path(&env, std::path::Path::new(&cwd));
    match pathbuf_to_string(resolved) {
        Ok(s) => ok(s),
        Err(e) => err(e),
    }
}

#[napi(catch_unwind)]
pub fn paths_resolve_case_index(env_json: String, cwd: String) -> String {
    let env = match parse_env_json(&env_json) {
        Ok(env) => env,
        Err(e) => return err(e),
    };
    let resolved = memphis_paths::resolve_case_index_path(&env, std::path::Path::new(&cwd));
    match pathbuf_to_string(resolved) {
        Ok(s) => ok(s),
        Err(e) => err(e),
    }
}

#[napi(catch_unwind)]
pub fn paths_resolve_database_path(env_json: String, cwd: String) -> String {
    let env = match parse_env_json(&env_json) {
        Ok(env) => env,
        Err(e) => return err(e),
    };
    let resolved = memphis_paths::resolve_database_path(&env, std::path::Path::new(&cwd));
    match pathbuf_to_string(resolved) {
        Ok(s) => ok(s),
        Err(e) => err(e),
    }
}

#[napi(catch_unwind)]
pub fn paths_normalize_chain_name(input: String) -> String {
    ok(memphis_paths::normalize_chain_name(&input).to_string())
}

/// The chain-name vocabulary, as its owner publishes it.
///
/// The projection (`scripts/sync-chain-name-contract.mts`) reads the
/// vocabulary through THIS function, so the TypeScript mirror is a
/// projection of the Rust owner (`memphis_paths::chain_names`) and not a
/// second hand-written copy. The rule itself lives in the owner, because
/// the rule is a cross-arm contract and the owner is the crate both arms
/// can reach.
// The embed PROFILE — the index path, the dimension, the model, and the
// source of each — has one owner: `memphis_embed::profile`. The TypeScript
// side reads the RULE through the manifest and the LIVE values through the
// facts, so the two sides cannot answer "which embedding profile is in
// force?" differently.
//
// Why the facts take an environment as an argument: the operator's runtime
// and the bridge read the PROCESS environment, but a TypeScript surface may
// be asked about a different environment (a test, a dry run, the setup
// wizard). The owner takes a map, so the question can be asked about any
// environment — and the answer is the owner's, not a second implementation's.

#[napi(catch_unwind, js_name = "bridge_embed_profile_manifest")]
pub fn bridge_embed_profile_manifest() -> String {
    ok(memphis_embed::embed_profile_manifest())
}

#[napi(catch_unwind, js_name = "bridge_embed_profile_facts")]
pub fn bridge_embed_profile_facts(env_json: String, root: String) -> String {
    let env = match parse_env_json(&env_json) {
        Ok(env) => env,
        Err(e) => return err(e),
    };
    let mode = memphis_embed::embed_mode_from_env(&env);
    let profile = memphis_embed::resolve_embed_profile(&env, std::path::Path::new(&root), &mode);
    ok(profile)
}

#[napi(catch_unwind, js_name = "bridge_chain_name_manifest")]
pub fn bridge_chain_name_manifest() -> String {
    use memphis_paths::chain_names as names;
    ok(serde_json::json!({
        "plainChainNamePattern": names::PLAIN_CHAIN_NAME_PATTERN,
        "maxChainNameLength": names::MAX_CHAIN_NAME_LEN,
        "archiveChainPartPattern": names::ARCHIVE_CHAIN_PART_PATTERN,
        "archiveSeparator": names::ARCHIVE_SEPARATOR,
        "archiveStampPatterns": names::ARCHIVE_STAMP_PATTERNS,
        "chainNameAliases": names::CHAIN_NAME_ALIASES
            .iter()
            .map(|(alias, canonical)| serde_json::json!({
                "alias": alias,
                "canonical": canonical,
            }))
            .collect::<Vec<_>>(),
    }))
}

/// The facts about one chain directory name.
///
/// `kind` — `chain`, `archive` or `foreign`; `logical` — the chain the
/// directory holds; `normalized` — the canonical name of a user-supplied
/// reference (trimmed, then aliased).
///
/// The ONE question the runtime, the audit, the verifier and the cockpit
/// used to answer with three rules. The projection reads the answers from
/// here, so the artefact of cases carries the OWNER's answers and not the
/// projection's own arithmetic.
#[napi(catch_unwind, js_name = "bridge_chain_name_facts")]
pub fn bridge_chain_name_facts(name: String) -> String {
    use memphis_paths::chain_names as names;
    ok(serde_json::json!({
        "kind": names::classify_chain_directory(&name).as_str(),
        "logical": names::logical_chain_name(&name),
        "normalized": names::normalize_chain_name(name.trim()),
    }))
}

// `.mv2` export bridge (Sprint G N12). The TS layer collects records via
// the existing CLI/MCP machinery, hands them to `mv2_export` as a JSON
// array, and gets back a Buffer it writes to disk. `mv2_inspect` is the
// reader-side hook used by the import path + Q1 verification harness.
//
// Returning the container bytes through `Vec<u8>` materializes a Node
// Buffer on the JS side automatically (napi v3). Don't switch to
// hex-encoded strings — large exports (10MB+) pay 2x memory + 100ms
// parse penalty for nothing.
#[napi(catch_unwind)]
pub fn mv2_export(records_json: String, include_tracks_json: String) -> String {
    use memphis_export::{Mv2Record, Mv2Writer, Track};

    let allow: Vec<Track> = match serde_json::from_str::<Vec<String>>(&include_tracks_json) {
        Ok(v) => v
            .into_iter()
            .filter_map(|s| match s.as_str() {
                "journal" => Some(Track::Journal),
                "chains" => Some(Track::Chains),
                "embeddings" => Some(Track::Embeddings),
                _ => None,
            })
            .collect(),
        Err(e) => return err(format!("invalid include_tracks_json: {e}")),
    };

    let records: Vec<Mv2Record> = match serde_json::from_str(&records_json) {
        Ok(v) => v,
        Err(e) => return err(format!("invalid records_json: {e}")),
    };

    let mut writer = Mv2Writer::new();
    for record in records.iter().filter(|r| allow.contains(&r.track)) {
        if let Err(e) = writer.append(record) {
            return err(format!("mv2 append failed: {e}"));
        }
    }

    #[derive(Serialize)]
    struct Mv2ExportOut {
        frame_count: u32,
        bytes_hex: String,
    }

    let frame_count = writer.frame_count();
    let bytes = writer.finish();
    let mut hex_buf = String::with_capacity(bytes.len() * 2);
    for b in &bytes {
        hex_buf.push_str(&format!("{b:02x}"));
    }
    ok(Mv2ExportOut {
        frame_count,
        bytes_hex: hex_buf,
    })
}

#[napi(catch_unwind)]
pub fn mv2_inspect(bytes_hex: String) -> String {
    use memphis_export::Mv2Reader;

    let bytes = match hex::decode(bytes_hex.trim()) {
        Ok(b) => b,
        Err(e) => return err(format!("invalid bytes_hex: {e}")),
    };
    let reader = match Mv2Reader::open(&bytes) {
        Ok(r) => r,
        Err(e) => return err(format!("mv2 parse failed: {e}")),
    };

    #[derive(Serialize)]
    struct Mv2InspectOut {
        count: usize,
        tracks: Vec<String>,
    }

    let tracks: Vec<String> = reader
        .records()
        .iter()
        .map(|r| r.track.label().to_string())
        .collect();
    ok(Mv2InspectOut {
        count: reader.count(),
        tracks,
    })
}

#[cfg(test)]
mod tests {
    use super::{
        bridge_exports, bridge_manifest, case_append, case_index_status, case_query, case_rebuild,
        chain_append, chain_validate, current_embed_mode, embed_persistence_enabled_from_env,
        embed_reset, embed_search, embed_search_tuned, embed_shutdown, embed_store,
        paths_normalize_chain_name, paths_resolve_chain_path, paths_resolve_chains_dir,
        paths_resolve_data_dir, paths_resolve_vault_entries, paths_resolve_vault_state,
        soul_loop_step, soul_replay,
    };
    use memphis_core::block::{Block, BlockData, BlockType};
    use memphis_core::hash::compute_hash;
    use memphis_embed::EmbedMode;
    use std::path::PathBuf;
    use std::sync::{
        atomic::{AtomicU64, Ordering},
        Mutex, MutexGuard, OnceLock,
    };
    use std::time::{SystemTime, UNIX_EPOCH};

    /// Codex review #585 — `cargo test` ran fine on dev boxes but
    /// `testRust` exited 101 on every release-gate run since v1.9.1
    /// (2026-05-08 → 2026-05-12). Tests that mutate process-wide env
    /// (`std::env::set_var("RUST_EMBED_MODE", …)` /
    /// `RUST_CHAIN_REQUIRE_SIGNATURES` / `RUST_CHAIN_SIGNER_KEY_HEX`)
    /// raced against any other test reading those vars when cargo
    /// scheduled them in parallel. On the operator's box test
    /// ordering happened to interleave benignly; CI runners hit the
    /// failing interleave.
    ///
    /// Fix: every env-mutating test takes this lock at the top so they
    /// serialize against each other. Other tests are free to read env
    /// vars without locking — the only writers are gated here, and
    /// each writer cleans up after itself before releasing the lock.
    fn env_lock() -> MutexGuard<'static, ()> {
        static ENV_MUTEX: OnceLock<Mutex<()>> = OnceLock::new();
        ENV_MUTEX
            .get_or_init(|| Mutex::new(()))
            .lock()
            .unwrap_or_else(|poisoned| {
                // Poisoned means a prior test panicked while holding
                // the lock; the env-cleanup at the bottom of that test
                // didn't run. We can still proceed — the next test
                // will overwrite the leaked env value with its own
                // before reading anything.
                poisoned.into_inner()
            })
    }

    /// Serialize tests that mutate the process-wide embed pipeline. Cargo
    /// runs unit tests in parallel, but `EMBED_PIPELINE` and its shutdown
    /// barrier are intentionally process-wide runtime state.
    fn embed_lock() -> MutexGuard<'static, ()> {
        static EMBED_MUTEX: OnceLock<Mutex<()>> = OnceLock::new();
        EMBED_MUTEX
            .get_or_init(|| Mutex::new(()))
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    #[test]
    fn embed_persistence_defaults_enabled_with_explicit_opt_out() {
        let _guard = env_lock();
        std::env::remove_var("RUST_EMBED_PERSIST_ENABLED");
        assert!(embed_persistence_enabled_from_env());

        std::env::set_var("RUST_EMBED_PERSIST_ENABLED", "false");
        assert!(!embed_persistence_enabled_from_env());

        std::env::set_var("RUST_EMBED_PERSIST_ENABLED", "true");
        assert!(embed_persistence_enabled_from_env());
        std::env::remove_var("RUST_EMBED_PERSIST_ENABLED");
    }

    struct TestCaseIndexPath {
        dir: PathBuf,
        db_path: PathBuf,
    }

    impl TestCaseIndexPath {
        fn new(label: &str) -> Self {
            static NEXT_ID: AtomicU64 = AtomicU64::new(1);

            let unique_id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
            let timestamp = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("system time before unix epoch")
                .as_nanos();
            let dir =
                std::env::temp_dir().join(format!("memphis-napi-{label}-{timestamp}-{unique_id}"));
            std::fs::create_dir_all(&dir).expect("create case index temp dir");

            Self {
                db_path: dir.join("case-index.sqlite"),
                dir,
            }
        }

        fn db_path_string(&self) -> String {
            self.db_path.to_string_lossy().to_string()
        }
    }

    impl Drop for TestCaseIndexPath {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    #[test]
    fn validate_returns_json_response() {
        let mut block = Block {
            index: 0,
            timestamp: "2026-03-08T21:00:00Z".to_string(),
            chain: "journal".to_string(),
            data: BlockData {
                block_type: BlockType::Journal,
                content: "hello".to_string(),
                tags: vec!["x".to_string()],
            },
            prev_hash: "0".repeat(64),
            hash: String::new(),
            signer: None,
            signature: None,
        };
        block.hash = memphis_core::hash::compute_hash(&block);

        let payload = serde_json::to_string(&block).unwrap();
        let out = chain_validate(payload, None);
        assert!(out.contains("\"ok\":true"));
    }

    #[test]
    fn bridge_manifest_lists_required_case_embed_and_path_exports() {
        let out = bridge_manifest();
        let parsed: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert_eq!(parsed["ok"], true);
        let required = parsed["data"]["requiredExports"].as_array().unwrap();
        let names: Vec<&str> = required.iter().filter_map(|v| v.as_str()).collect();
        assert!(names.contains(&"bridge_manifest"));
        assert!(names.contains(&"case_rebuild"));
        assert!(names.contains(&"embed_shutdown"));
        assert!(names.contains(&"paths_resolve_database_path"));
    }

    #[test]
    fn the_manifest_lists_the_optional_exports_of_the_table() {
        // The manifest used to carry a hand-written list of TWO names
        // (`mv2_export`, `mv2_inspect`) — a leftover from June 2026, from
        // before the export table existed — while the table already knew
        // TEN optional exports, and nothing read the field. It is derived
        // from the table now, and this test is what keeps it derived.
        let out = bridge_manifest();
        let parsed: serde_json::Value = serde_json::from_str(&out).unwrap();
        let optional: Vec<&str> = parsed["data"]["optionalExports"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|value| value.as_str())
            .collect();
        assert_eq!(
            optional,
            bridge_exports::optional_names(),
            "the manifest's optional exports are not the optional exports of the table"
        );
    }

    #[test]
    fn embed_bridge_roundtrip_json() {
        let _env_guard = env_lock();
        let _embed_guard = embed_lock();
        // The NAPI pipeline is a process-wide singleton. Unit tests must not
        // initialize it against the operator's real ~/.memphis embed index.
        std::env::set_var("RUST_EMBED_PERSIST_ENABLED", "false");
        let _ = embed_reset();
        let a = embed_store(
            "doc-a".to_string(),
            "local deterministic embeddings".to_string(),
            None,
        );
        let b = embed_store(
            "doc-b".to_string(),
            "provider boundary in pipeline".to_string(),
            None,
        );
        assert!(a.contains("\"ok\":true"));
        assert!(b.contains("\"ok\":true"));

        let search = embed_search("deterministic".to_string(), Some(1), None);
        assert!(search.contains("\"ok\":true"));
        assert!(search.contains("\"hits\""));

        let tuned = embed_search_tuned("DETERMINISTIC?!".to_string(), Some(1), None);
        assert!(tuned.contains("\"ok\":true"));
        std::env::remove_var("RUST_EMBED_PERSIST_ENABLED");
    }

    #[test]
    fn embed_shutdown_is_idempotent_and_handles_uninitialized() {
        let _env_guard = env_lock();
        let _embed_guard = embed_lock();
        // Keep singleton initialization hermetic for the same reason as the
        // roundtrip test above. Shutdown then has no operator-owned file to
        // flush and cannot inherit a stale/unwritable persistence path.
        std::env::set_var("RUST_EMBED_PERSIST_ENABLED", "false");
        // After reset the pipeline IS initialized (get_or_init happens in
        // embed_reset path). Still valid to shutdown — should clear.
        let _ = embed_reset();
        let first = embed_shutdown();
        assert!(
            first.contains("\"ok\":true"),
            "unexpected shutdown response: {first}"
        );
        assert!(first.contains("\"shutdown\":true"));

        // Second call must also succeed (idempotency guarantee for
        // graceful-shutdown.ts which may be invoked twice under racing
        // SIGTERM+SIGINT).
        let second = embed_shutdown();
        assert!(
            second.contains("\"ok\":true"),
            "unexpected shutdown response: {second}"
        );
        assert!(second.contains("\"shutdown\":true"));
        std::env::remove_var("RUST_EMBED_PERSIST_ENABLED");
    }

    #[test]
    fn embed_mode_supports_additional_provider_aliases() {
        let _guard = env_lock();
        std::env::set_var("RUST_EMBED_MODE", "voyage");
        assert_eq!(
            current_embed_mode(),
            EmbedMode::Provider("voyage".to_string())
        );

        std::env::set_var("RUST_EMBED_MODE", "jina");
        assert_eq!(
            current_embed_mode(),
            EmbedMode::Provider("jina".to_string())
        );

        std::env::set_var("RUST_EMBED_MODE", "mistral");
        assert_eq!(
            current_embed_mode(),
            EmbedMode::Provider("mistral".to_string())
        );

        std::env::set_var("RUST_EMBED_MODE", "together");
        assert_eq!(
            current_embed_mode(),
            EmbedMode::Provider("together".to_string())
        );

        std::env::set_var("RUST_EMBED_MODE", "nvidia");
        assert_eq!(
            current_embed_mode(),
            EmbedMode::Provider("nvidia".to_string())
        );

        std::env::set_var("RUST_EMBED_MODE", "mixedbread");
        assert_eq!(
            current_embed_mode(),
            EmbedMode::Provider("mixedbread".to_string())
        );

        std::env::remove_var("RUST_EMBED_MODE");
    }

    #[test]
    fn chain_append_auto_signs_when_signer_key_is_configured() {
        let _guard = env_lock();
        std::env::set_var("RUST_CHAIN_REQUIRE_SIGNATURES", "true");
        std::env::set_var("RUST_CHAIN_SIGNER_KEY_HEX", "11".repeat(32));

        let mut block = Block {
            index: 1,
            timestamp: "2026-03-08T21:00:00Z".to_string(),
            chain: "journal".to_string(),
            data: BlockData {
                block_type: BlockType::Journal,
                content: "auto-sign me".to_string(),
                tags: vec!["security".to_string()],
            },
            prev_hash: "0".repeat(64),
            hash: String::new(),
            signer: None,
            signature: None,
        };
        block.hash = compute_hash(&block);

        let out = chain_append("[]".to_string(), serde_json::to_string(&block).unwrap());
        let parsed: serde_json::Value = serde_json::from_str(&out).unwrap();

        assert_eq!(parsed.get("ok").and_then(|v| v.as_bool()), Some(true));
        assert_eq!(
            parsed
                .get("data")
                .and_then(|v| v.get("appended"))
                .and_then(|v| v.as_bool()),
            Some(true)
        );

        let appended = parsed
            .get("data")
            .and_then(|v| v.get("chain"))
            .and_then(|v| v.as_array())
            .and_then(|arr| arr.first())
            .unwrap();
        assert!(appended.get("signer").and_then(|v| v.as_str()).is_some());
        assert!(appended.get("signature").and_then(|v| v.as_str()).is_some());

        std::env::remove_var("RUST_CHAIN_REQUIRE_SIGNATURES");
        std::env::remove_var("RUST_CHAIN_SIGNER_KEY_HEX");
    }

    #[test]
    fn soul_loop_step_applies_tool_call() {
        let state = serde_json::json!({
            "steps": 0, "tool_calls": 0, "wait_ms": 0,
            "errors": 0, "completed": false, "halt_reason": null
        });
        let action = serde_json::json!({ "type": "tool_call", "data": { "tool": "web_search" } });
        let out = soul_loop_step(state.to_string(), action.to_string(), None);
        let parsed: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert_eq!(parsed["ok"], true);
        assert_eq!(parsed["data"]["applied"], true);
        assert_eq!(parsed["data"]["state"]["steps"], 1);
        assert_eq!(parsed["data"]["state"]["tool_calls"], 1);
    }

    #[test]
    fn soul_loop_step_enforces_limits() {
        let state = serde_json::json!({
            "steps": 0, "tool_calls": 0, "wait_ms": 0,
            "errors": 0, "completed": false, "halt_reason": null
        });
        let action = serde_json::json!({ "type": "tool_call", "data": { "tool": "bash" } });
        let limits = serde_json::json!({
            "max_steps": 1, "max_tool_calls": 1, "max_wait_ms": 1000, "max_errors": 1
        });

        let out1 = soul_loop_step(
            state.to_string(),
            action.to_string(),
            Some(limits.to_string()),
        );
        let p1: serde_json::Value = serde_json::from_str(&out1).unwrap();
        assert_eq!(p1["data"]["applied"], true);

        let out2 = soul_loop_step(
            p1["data"]["state"].to_string(),
            action.to_string(),
            Some(limits.to_string()),
        );
        let p2: serde_json::Value = serde_json::from_str(&out2).unwrap();
        assert_eq!(p2["data"]["applied"], false);
        assert!(p2["data"]["reason"].as_str().unwrap().contains("exceeded"));
    }

    #[test]
    fn case_append_returns_valid_envelope() {
        let _guard = env_lock();
        let case_index = TestCaseIndexPath::new("case-append-valid");
        let entry = serde_json::json!({
            "case_type": "instrumental",
            "actor": "Agent",
            "instrument": "memphis_exec",
            "target": "providers"
        });
        let out = case_append(
            "[]".to_string(),
            entry.to_string(),
            case_index.db_path_string(),
            None,
        );
        let parsed: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert_eq!(parsed["ok"], true);
        assert_eq!(parsed["data"]["appended"], true);
        assert_eq!(parsed["data"]["indexed"], true);
        assert_eq!(parsed["data"]["length"], 1);
    }

    #[test]
    fn case_append_rejects_invalid_entry() {
        let _guard = env_lock();
        let case_index = TestCaseIndexPath::new("case-append-invalid");
        let entry = serde_json::json!({
            "case_type": "instrumental",
            "actor": "",
            "instrument": "tool",
            "target": "file"
        });
        let out = case_append(
            "[]".to_string(),
            entry.to_string(),
            case_index.db_path_string(),
            None,
        );
        let parsed: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert_eq!(parsed["ok"], false);
        assert!(parsed["error"]
            .as_str()
            .unwrap()
            .contains("validation_failed"));
    }

    #[test]
    fn case_query_returns_results() {
        let _guard = env_lock();
        let case_index = TestCaseIndexPath::new("case-query");
        let db_str = case_index.db_path_string();

        // Append two entries
        let entry1 = serde_json::json!({
            "case_type": "instrumental",
            "actor": "Agent",
            "instrument": "tool_a",
            "target": "file.rs"
        });
        let out1 = case_append("[]".to_string(), entry1.to_string(), db_str.clone(), None);
        let p1: serde_json::Value = serde_json::from_str(&out1).unwrap();
        let chain = p1["data"]["chain"].to_string();

        let entry2 = serde_json::json!({
            "case_type": "nominative",
            "entity": "Agent",
            "action": "started",
            "timestamp": "2026-03-22T10:00:00Z"
        });
        let _ = case_append(chain, entry2.to_string(), db_str.clone(), None);

        // Query instrumental
        let query = serde_json::json!({ "case_type": "instrumental" });
        let out = case_query(query.to_string(), db_str.clone(), None);
        let parsed: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert_eq!(parsed["ok"], true);
        assert_eq!(parsed["data"]["count"], 1);
    }

    #[test]
    fn case_rebuild_reindexes_blocks() {
        let _guard = env_lock();
        let case_index = TestCaseIndexPath::new("case-rebuild");
        let db_str = case_index.db_path_string();

        // Append entry to get a valid chain
        let entry = serde_json::json!({
            "case_type": "locative",
            "entity": "Agent",
            "location": "session"
        });
        let out = case_append("[]".to_string(), entry.to_string(), db_str.clone(), None);
        let p: serde_json::Value = serde_json::from_str(&out).unwrap();
        let chain = p["data"]["chain"].to_string();

        // Rebuild
        let rebuild_out = case_rebuild(chain, db_str.clone(), None);
        let parsed: serde_json::Value = serde_json::from_str(&rebuild_out).unwrap();
        assert_eq!(parsed["ok"], true);
        assert_eq!(parsed["data"]["indexed"], 1);
        assert_eq!(parsed["data"]["errors"], 0);
    }

    // ── The source, through the bridge ───────────────────────────────────
    //
    // The index's key carries the SOURCE — the chain directory the blocks
    // were read from. The blocks cannot be asked for it, so the CALLER
    // supplies it, and the bridge is where the caller's answer travels.
    //
    // The source is OPTIONAL, and that is the compatibility window: a
    // caller that does not pass one gets the legacy bucket and the legacy
    // behaviour, so an older caller against this bridge keeps working
    // exactly as it did.

    fn a_case_entry() -> serde_json::Value {
        serde_json::json!({
            "case_type": "instrumental",
            "actor": "Agent",
            "instrument": "memphis_exec",
            "target": "providers"
        })
    }

    #[test]
    fn case_index_status_says_it_is_source_aware() {
        let _guard = env_lock();
        let case_index = TestCaseIndexPath::new("case-status-aware");
        let out = case_index_status(case_index.db_path_string(), Some("cases".to_string()));
        let parsed: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert_eq!(parsed["ok"], true);
        assert_eq!(
            parsed["data"]["sourceAware"], true,
            "the handshake a caller reads to know the binary understands the source"
        );
        assert_eq!(parsed["data"]["source"], "cases");
        assert_eq!(parsed["data"]["indexed"], 0);
    }

    #[test]
    fn case_index_keeps_two_sources_apart() {
        let _guard = env_lock();
        let case_index = TestCaseIndexPath::new("case-two-sources");
        let db = case_index.db_path_string();
        let entry = a_case_entry();

        let appended = case_append(
            "[]".to_string(),
            entry.to_string(),
            db.clone(),
            Some("cases".to_string()),
        );
        let parsed: serde_json::Value = serde_json::from_str(&appended).unwrap();
        assert_eq!(parsed["ok"], true);
        assert_eq!(parsed["data"]["indexed"], true);

        // The same block index, indexed under a second source, does not
        // replace the first one.
        let appended_again = case_append(
            "[]".to_string(),
            entry.to_string(),
            db.clone(),
            Some("cases.backup-1700000000000".to_string()),
        );
        let parsed_again: serde_json::Value = serde_json::from_str(&appended_again).unwrap();
        assert_eq!(parsed_again["ok"], true);

        let live = case_index_status(db.clone(), Some("cases".to_string()));
        let live: serde_json::Value = serde_json::from_str(&live).unwrap();
        assert_eq!(live["data"]["indexed"], 1);

        let archive = case_index_status(
            db.clone(),
            Some("cases.backup-1700000000000".to_string()),
        );
        let archive: serde_json::Value = serde_json::from_str(&archive).unwrap();
        assert_eq!(archive["data"]["indexed"], 1);

        // A query without a source is the legacy query: it answers with
        // the legacy bucket, which is empty.
        let legacy = case_query("{}".to_string(), db, None);
        let legacy: serde_json::Value = serde_json::from_str(&legacy).unwrap();
        assert_eq!(legacy["data"]["count"], 0);
    }

    #[test]
    fn case_index_without_a_source_keeps_the_legacy_behaviour() {
        let _guard = env_lock();
        let case_index = TestCaseIndexPath::new("case-legacy-source");
        let db = case_index.db_path_string();

        let appended = case_append(
            "[]".to_string(),
            a_case_entry().to_string(),
            db.clone(),
            None,
        );
        let parsed: serde_json::Value = serde_json::from_str(&appended).unwrap();
        assert_eq!(parsed["ok"], true);

        // The legacy status (no source) counts the legacy bucket.
        let status = case_index_status(db.clone(), None);
        let status: serde_json::Value = serde_json::from_str(&status).unwrap();
        assert_eq!(status["data"]["indexed"], 1);

        // And the legacy query still finds it.
        let query = case_query("{}".to_string(), db.clone(), None);
        let query: serde_json::Value = serde_json::from_str(&query).unwrap();
        assert_eq!(query["data"]["count"], 1);

        // A named source is a different bucket, and it is empty.
        let named = case_index_status(db, Some("cases".to_string()));
        let named: serde_json::Value = serde_json::from_str(&named).unwrap();
        assert_eq!(named["data"]["indexed"], 0);
    }

    #[test]
    fn case_rebuild_is_scoped_to_its_source() {
        let _guard = env_lock();
        let case_index = TestCaseIndexPath::new("case-rebuild-scope");
        let db = case_index.db_path_string();

        let appended = case_append(
            "[]".to_string(),
            a_case_entry().to_string(),
            db.clone(),
            Some("other".to_string()),
        );
        let parsed: serde_json::Value = serde_json::from_str(&appended).unwrap();
        assert_eq!(parsed["ok"], true);
        let chain = parsed["data"]["chain"].to_string();

        // A rebuild of "cases" must not destroy "other"'s rows.
        let rebuilt = case_rebuild(chain, db.clone(), Some("cases".to_string()));
        let rebuilt: serde_json::Value = serde_json::from_str(&rebuilt).unwrap();
        assert_eq!(rebuilt["ok"], true);

        let other = case_index_status(db.clone(), Some("other".to_string()));
        let other: serde_json::Value = serde_json::from_str(&other).unwrap();
        assert_eq!(
            other["data"]["indexed"], 1,
            "a rebuild of one source destroyed another source's rows"
        );
    }

    #[test]
    fn soul_replay_accepts_valid_chain() {
        let mut b0 = Block {
            index: 0,
            timestamp: "2026-03-15T12:00:00Z".to_string(),
            chain: "system".to_string(),
            data: BlockData {
                block_type: BlockType::SystemEvent,
                content: "boot".to_string(),
                tags: vec!["replay".to_string()],
            },
            prev_hash: "0".repeat(64),
            hash: String::new(),
            signer: None,
            signature: None,
        };
        b0.hash = compute_hash(&b0);

        let blocks = serde_json::to_string(&vec![b0]).unwrap();
        let out = soul_replay("system".to_string(), blocks);
        let parsed: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert_eq!(parsed["ok"], true);
        assert_eq!(parsed["data"]["accepted"], 1);
        assert_eq!(parsed["data"]["rejected"], 0);
        assert_eq!(parsed["data"]["snapshot"]["blocks"], 1);
    }

    // ── memphis-paths NAPI bridge tests ──────────────────────────────────
    //
    // The crate-level tests in `memphis-paths/src/lib.rs` already cover
    // the resolver semantics exhaustively. These tests assert the NAPI
    // wrapper layer specifically: env_json deserialization + ApiResult
    // envelope shape + UTF-8 path stringification.

    fn paths_env(pairs: &[(&str, &str)]) -> String {
        let map: std::collections::HashMap<String, String> = pairs
            .iter()
            .map(|(k, v)| ((*k).to_string(), (*v).to_string()))
            .collect();
        serde_json::to_string(&map).expect("serialize env map")
    }

    #[test]
    fn paths_resolve_data_dir_returns_absolute_under_home() {
        let env = paths_env(&[("HOME", "/home/op")]);
        let out = paths_resolve_data_dir(env, "/cwd".to_string());
        let parsed: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert_eq!(parsed["ok"], true);
        assert_eq!(parsed["data"], "/home/op/.memphis");
    }

    #[test]
    fn paths_resolve_data_dir_honors_explicit_override() {
        let env = paths_env(&[("HOME", "/home/op"), ("MEMPHIS_DATA_DIR", "/var/m")]);
        let out = paths_resolve_data_dir(env, "/cwd".to_string());
        let parsed: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert_eq!(parsed["ok"], true);
        assert_eq!(parsed["data"], "/var/m");
    }

    #[test]
    fn paths_resolve_vault_state_pairs_with_data_dir() {
        let env = paths_env(&[("HOME", "/home/op"), ("MEMPHIS_DATA_DIR", "/var/m")]);
        let out = paths_resolve_vault_state(env, "/cwd".to_string());
        let parsed: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert_eq!(parsed["ok"], true);
        assert_eq!(parsed["data"], "/var/m/vault-state.json");
    }

    #[test]
    fn paths_resolve_vault_entries_can_split_from_state() {
        // Operator override only on entries — state stays under data_dir.
        let env = paths_env(&[
            ("HOME", "/home/op"),
            ("MEMPHIS_VAULT_ENTRIES_PATH", "/recovery/entries.json"),
        ]);
        let out = paths_resolve_vault_entries(env, "/cwd".to_string());
        let parsed: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert_eq!(parsed["ok"], true);
        assert_eq!(parsed["data"], "/recovery/entries.json");
    }

    #[test]
    fn paths_resolve_chains_dir_under_data_dir() {
        let env = paths_env(&[("HOME", "/home/op")]);
        let out = paths_resolve_chains_dir(env, "/cwd".to_string());
        let parsed: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert_eq!(parsed["ok"], true);
        assert_eq!(parsed["data"], "/home/op/.memphis/chains");
    }

    #[test]
    fn paths_resolve_chain_path_normalizes_aliases() {
        let env = paths_env(&[("HOME", "/home/op")]);
        let out = paths_resolve_chain_path(env, "/cwd".to_string(), "case".to_string());
        let parsed: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert_eq!(parsed["ok"], true);
        assert_eq!(parsed["data"], "/home/op/.memphis/chains/cases");
    }

    #[test]
    fn paths_normalize_chain_name_returns_canonical() {
        let out = paths_normalize_chain_name("decision".to_string());
        let parsed: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert_eq!(parsed["ok"], true);
        assert_eq!(parsed["data"], "decisions");
    }

    #[test]
    fn paths_invalid_env_json_yields_error_envelope() {
        let out = paths_resolve_data_dir("not-json".to_string(), "/cwd".to_string());
        let parsed: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert_eq!(parsed["ok"], false);
        assert!(
            parsed["error"]
                .as_str()
                .unwrap()
                .contains("env_json must deserialize"),
            "error message should explain the deserialization failure: {parsed:?}"
        );
    }
}
