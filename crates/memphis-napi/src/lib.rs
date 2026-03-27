use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

use memphis_core::block::Block;
use memphis_core::harness;
use memphis_core::loop_engine::{LoopAction, LoopLimits, LoopState};
use memphis_core::signature::{sign_block, verify_block_signature_with_allowlist};
use memphis_core::soul::{validate_block, validate_block_strict};
use memphis_embed::{
    EmbedConfig, EmbedMode, EmbedPersistenceConfig, EmbedPersistenceLoadState, EmbedPipeline,
};
mod vault_bridge;

use memphis_vault::types::VaultInitRequest;
use memphis_vault::vault::init_vault;
use napi_derive::napi;
use serde::Serialize;

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

#[derive(Serialize)]
struct EmbedStoreOut {
    id: String,
    count: usize,
    dim: usize,
    provider: String,
    persistence_enabled: bool,
    persistence_load_state: String,
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

fn embed_mode_from_env() -> EmbedMode {
    let raw = std::env::var("RUST_EMBED_MODE").unwrap_or_else(|_| "local".to_string());
    let mode = raw.trim().to_ascii_lowercase();

    let provider = match mode.as_str() {
        "local" => None,
        "provider" | "openai-compatible" => Some("openai-compatible"),
        "ollama" => Some("ollama"),
        "cohere" => Some("cohere"),
        "voyage" => Some("voyage"),
        "jina" => Some("jina"),
        "mistral" => Some("mistral"),
        "together" => Some("together"),
        "nvidia" => Some("nvidia"),
        "mixedbread" => Some("mixedbread"),
        _ => None,
    };

    match provider {
        Some(name) => EmbedMode::Provider(name.to_string()),
        None => EmbedMode::LocalDeterministic,
    }
}

fn embed_config_from_env() -> EmbedConfig {
    EmbedConfig {
        mode: embed_mode_from_env(),
        dim: parse_usize_env("RUST_EMBED_DIM", 32),
        max_text_bytes: parse_usize_env("RUST_EMBED_MAX_TEXT_BYTES", 4096),
        provider_url: trim_opt_env("RUST_EMBED_PROVIDER_URL"),
        provider_api_key: trim_opt_env("RUST_EMBED_PROVIDER_API_KEY"),
        provider_model: trim_opt_env("RUST_EMBED_PROVIDER_MODEL"),
        provider_timeout_ms: parse_u64_env("RUST_EMBED_PROVIDER_TIMEOUT_MS", 8000),
    }
}

fn embed_persistence_path_from_env() -> PathBuf {
    if let Ok(path) = std::env::var("RUST_EMBED_PERSIST_PATH") {
        let trimmed = path.trim();
        if !trimmed.is_empty() {
            return PathBuf::from(trimmed);
        }
    }

    let home = std::env::var("HOME").unwrap_or_else(|_| ".".to_string());
    PathBuf::from(home)
        .join(".memphis")
        .join("embed")
        .join("index-v1.json")
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

fn get_embed_pipeline() -> Result<&'static Mutex<EmbedPipeline>, String> {
    if let Some(p) = EMBED_PIPELINE.get() {
        return Ok(p);
    }

    let persistence_enabled = parse_bool_env("RUST_EMBED_PERSIST_ENABLED", false);
    let persistence = EmbedPersistenceConfig {
        enabled: persistence_enabled,
        index_path: embed_persistence_path_from_env(),
    };

    let pipeline = EmbedPipeline::with_persistence(embed_config_from_env(), persistence)
        .map_err(|e| format!("embed_pipeline_init_failed: {e}"))?;

    Ok(EMBED_PIPELINE.get_or_init(|| Mutex::new(pipeline)))
}

#[napi(js_name = "chain_validate")]
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
                    Ok(true) => ok(serde_json::json!({ "valid": true })),
                    Ok(false) => ok(
                        serde_json::json!({ "valid": false, "errors": ["block unsigned but signer allowlist is configured"] }),
                    ),
                    Err(e) => ok(
                        serde_json::json!({ "valid": false, "errors": [format!("signer allowlist check failed: {e}")] }),
                    ),
                }
            } else {
                ok(serde_json::json!({ "valid": true }))
            }
        }
        Err(errors) => ok(serde_json::json!({ "valid": false, "errors": errors })),
    }
}

#[napi(js_name = "chain_append")]
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
        return ok(serde_json::json!({ "appended": false, "errors": errors }));
    }

    let allowlist = signer_allowlist_from_env();
    if !allowlist.is_empty() {
        match verify_block_signature_with_allowlist(&block, &allowlist) {
            Ok(true) => {}
            Ok(false) => {
                return ok(
                    serde_json::json!({ "appended": false, "errors": ["block unsigned but signer allowlist is configured"] }),
                );
            }
            Err(e) => {
                return ok(
                    serde_json::json!({ "appended": false, "errors": [format!("signer allowlist check failed: {e}")] }),
                );
            }
        }
    }

    blocks.push(block);
    ok(serde_json::json!({ "appended": true, "length": blocks.len(), "chain": blocks }))
}

#[napi(js_name = "chain_query")]
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

    ok(serde_json::json!({ "count": result.len(), "blocks": result }))
}

#[napi(js_name = "vault_init_json")]
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

#[napi(js_name = "embed_store")]
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
            provider: pipeline.provider_name().to_string(),
            persistence_enabled: pipeline.persistence_enabled(),
            persistence_load_state: load_state_to_str(pipeline.persistence_load_state())
                .to_string(),
        }),
        Err(e) => err(format!("embed_store_failed: {e}")),
    }
}

#[napi(js_name = "embed_search")]
pub fn embed_search(query: String, top_k: Option<u32>, tags_json: Option<String>) -> String {
    let pipeline = match get_embed_pipeline() {
        Ok(p) => p,
        Err(e) => return err(e),
    };

    let pipeline = match pipeline.lock() {
        Ok(v) => v,
        Err(_) => return err("embed_pipeline_lock_failed"),
    };

    let filter_tags: Option<Vec<String>> = tags_json.and_then(|s| serde_json::from_str(&s).ok());
    let limit = top_k.unwrap_or(5) as usize;
    match pipeline.search_with_tags(&query, limit, filter_tags.as_deref()) {
        Ok(hits) => ok(EmbedSearchOut {
            query,
            count: hits.len(),
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

#[napi(js_name = "embed_search_tuned")]
pub fn embed_search_tuned(query: String, top_k: Option<u32>, tags_json: Option<String>) -> String {
    let pipeline = match get_embed_pipeline() {
        Ok(p) => p,
        Err(e) => return err(e),
    };

    let pipeline = match pipeline.lock() {
        Ok(v) => v,
        Err(_) => return err("embed_pipeline_lock_failed"),
    };

    let filter_tags: Option<Vec<String>> = tags_json.and_then(|s| serde_json::from_str(&s).ok());
    let limit = top_k.unwrap_or(5) as usize;
    match pipeline.search_tuned_with_tags(&query, limit, filter_tags.as_deref()) {
        Ok(hits) => ok(EmbedSearchOut {
            query,
            count: hits.len(),
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

#[napi(js_name = "embed_reset")]
pub fn embed_reset() -> String {
    let pipeline = match get_embed_pipeline() {
        Ok(p) => p,
        Err(e) => return err(e),
    };

    let mut pipeline = match pipeline.lock() {
        Ok(v) => v,
        Err(_) => return err("embed_pipeline_lock_failed"),
    };
    pipeline.clear();
    ok(serde_json::json!({ "cleared": true }))
}

#[napi(js_name = "soul_loop_step")]
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
        Ok(()) => ok(serde_json::json!({
            "applied": true,
            "state": state,
        })),
        Err(reason) => ok(serde_json::json!({
            "applied": false,
            "reason": reason,
            "state": state,
        })),
    }
}

#[napi(js_name = "soul_replay")]
pub fn soul_replay(chain_name: String, blocks_json: String) -> String {
    let blocks: Vec<Block> = match serde_json::from_str(&blocks_json) {
        Ok(v) => v,
        Err(e) => return err(format!("invalid_blocks_json: {e}")),
    };

    let report = harness::replay(chain_name, &blocks);
    ok(report)
}

// ── Case-based chain functions ────────────────────────────────────────

#[napi(js_name = "case_append")]
pub fn case_append(chain_json: String, entry_json: String, index_db_path: String) -> String {
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
        return ok(serde_json::json!({ "appended": false, "errors": errors }));
    }

    // Index into SQLite
    let index_result = CaseIndex::open(std::path::Path::new(&index_db_path))
        .and_then(|idx| idx.index_block(&block).map(|_| ()));
    let indexed = index_result.is_ok();
    if let Err(e) = index_result {
        eprintln!("case_index warning: {e}");
    }

    blocks.push(block);
    ok(serde_json::json!({
        "appended": true,
        "indexed": indexed,
        "length": blocks.len(),
        "chain": blocks,
    }))
}

#[napi(js_name = "case_query")]
pub fn case_query(query_json: String, index_db_path: String) -> String {
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

    match idx.query(&query) {
        Ok(rows) => ok(serde_json::json!({
            "count": rows.len(),
            "entries": rows,
        })),
        Err(e) => err(format!("case_query_failed: {e}")),
    }
}

#[napi(js_name = "case_rebuild")]
pub fn case_rebuild(blocks_json: String, index_db_path: String) -> String {
    use memphis_case_index::CaseIndex;

    let blocks: Vec<Block> = match serde_json::from_str(&blocks_json) {
        Ok(v) => v,
        Err(e) => return err(format!("invalid_blocks_json: {e}")),
    };

    let idx = match CaseIndex::open(std::path::Path::new(&index_db_path)) {
        Ok(v) => v,
        Err(e) => return err(format!("case_index_open_failed: {e}")),
    };

    match idx.rebuild(&blocks) {
        Ok(report) => ok(report),
        Err(e) => err(format!("case_rebuild_failed: {e}")),
    }
}

#[cfg(test)]
mod tests {
    use super::{
        case_append, case_query, case_rebuild, chain_append, chain_validate, embed_mode_from_env,
        embed_reset, embed_search, embed_search_tuned, embed_store, soul_loop_step, soul_replay,
    };
    use memphis_core::block::{Block, BlockData, BlockType};
    use memphis_core::hash::compute_hash;
    use memphis_embed::EmbedMode;

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
    fn embed_bridge_roundtrip_json() {
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
    }

    #[test]
    fn embed_mode_supports_additional_provider_aliases() {
        std::env::set_var("RUST_EMBED_MODE", "voyage");
        assert_eq!(
            embed_mode_from_env(),
            EmbedMode::Provider("voyage".to_string())
        );

        std::env::set_var("RUST_EMBED_MODE", "jina");
        assert_eq!(
            embed_mode_from_env(),
            EmbedMode::Provider("jina".to_string())
        );

        std::env::set_var("RUST_EMBED_MODE", "mistral");
        assert_eq!(
            embed_mode_from_env(),
            EmbedMode::Provider("mistral".to_string())
        );

        std::env::set_var("RUST_EMBED_MODE", "together");
        assert_eq!(
            embed_mode_from_env(),
            EmbedMode::Provider("together".to_string())
        );

        std::env::set_var("RUST_EMBED_MODE", "nvidia");
        assert_eq!(
            embed_mode_from_env(),
            EmbedMode::Provider("nvidia".to_string())
        );

        std::env::set_var("RUST_EMBED_MODE", "mixedbread");
        assert_eq!(
            embed_mode_from_env(),
            EmbedMode::Provider("mixedbread".to_string())
        );

        std::env::remove_var("RUST_EMBED_MODE");
    }

    #[test]
    fn chain_append_auto_signs_when_signer_key_is_configured() {
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
        let db_path = std::env::temp_dir()
            .join(format!("memphis-napi-case-test-{}", std::process::id()))
            .join("case-index.sqlite");
        let entry = serde_json::json!({
            "case_type": "instrumental",
            "actor": "Agent",
            "instrument": "memphis_exec",
            "target": "providers"
        });
        let out = case_append(
            "[]".to_string(),
            entry.to_string(),
            db_path.to_string_lossy().to_string(),
        );
        let parsed: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert_eq!(parsed["ok"], true);
        assert_eq!(parsed["data"]["appended"], true);
        assert_eq!(parsed["data"]["indexed"], true);
        assert_eq!(parsed["data"]["length"], 1);
        let _ = std::fs::remove_dir_all(db_path.parent().unwrap());
    }

    #[test]
    fn case_append_rejects_invalid_entry() {
        let db_path = std::env::temp_dir()
            .join(format!("memphis-napi-case-invalid-{}", std::process::id()))
            .join("case-index.sqlite");
        let entry = serde_json::json!({
            "case_type": "instrumental",
            "actor": "",
            "instrument": "tool",
            "target": "file"
        });
        let out = case_append(
            "[]".to_string(),
            entry.to_string(),
            db_path.to_string_lossy().to_string(),
        );
        let parsed: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert_eq!(parsed["ok"], false);
        assert!(parsed["error"]
            .as_str()
            .unwrap()
            .contains("validation_failed"));
        let _ = std::fs::remove_dir_all(db_path.parent().unwrap());
    }

    #[test]
    fn case_query_returns_results() {
        let db_path = std::env::temp_dir()
            .join(format!("memphis-napi-case-query-{}", std::process::id()))
            .join("case-index.sqlite");
        let db_str = db_path.to_string_lossy().to_string();

        // Append two entries
        let entry1 = serde_json::json!({
            "case_type": "instrumental",
            "actor": "Agent",
            "instrument": "tool_a",
            "target": "file.rs"
        });
        let out1 = case_append("[]".to_string(), entry1.to_string(), db_str.clone());
        let p1: serde_json::Value = serde_json::from_str(&out1).unwrap();
        let chain = p1["data"]["chain"].to_string();

        let entry2 = serde_json::json!({
            "case_type": "nominative",
            "entity": "Agent",
            "action": "started",
            "timestamp": "2026-03-22T10:00:00Z"
        });
        let _ = case_append(chain, entry2.to_string(), db_str.clone());

        // Query instrumental
        let query = serde_json::json!({ "case_type": "instrumental" });
        let out = case_query(query.to_string(), db_str.clone());
        let parsed: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert_eq!(parsed["ok"], true);
        assert_eq!(parsed["data"]["count"], 1);

        let _ = std::fs::remove_dir_all(db_path.parent().unwrap());
    }

    #[test]
    fn case_rebuild_reindexes_blocks() {
        let db_path = std::env::temp_dir()
            .join(format!("memphis-napi-case-rebuild-{}", std::process::id()))
            .join("case-index.sqlite");
        let db_str = db_path.to_string_lossy().to_string();

        // Append entry to get a valid chain
        let entry = serde_json::json!({
            "case_type": "locative",
            "entity": "Agent",
            "location": "session"
        });
        let out = case_append("[]".to_string(), entry.to_string(), db_str.clone());
        let p: serde_json::Value = serde_json::from_str(&out).unwrap();
        let chain = p["data"]["chain"].to_string();

        // Rebuild
        let rebuild_out = case_rebuild(chain, db_str.clone());
        let parsed: serde_json::Value = serde_json::from_str(&rebuild_out).unwrap();
        assert_eq!(parsed["ok"], true);
        assert_eq!(parsed["data"]["indexed"], 1);
        assert_eq!(parsed["data"]["errors"], 0);

        let _ = std::fs::remove_dir_all(db_path.parent().unwrap());
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
}
