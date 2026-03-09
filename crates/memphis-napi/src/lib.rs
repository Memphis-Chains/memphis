use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

use memphis_core::block::Block;
use memphis_core::soul::validate_block;
use memphis_embed::{EmbedConfig, EmbedPersistenceConfig, EmbedPersistenceLoadState, EmbedPipeline};
use memphis_vault::types::{VaultEntry, VaultInitRequest};
use memphis_vault::vault::{decrypt_entry, encrypt_entry, init_vault};
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

    let pipeline = EmbedPipeline::with_persistence(EmbedConfig::default(), persistence)
        .map_err(|e| format!("embed_pipeline_init_failed: {e}"))?;

    Ok(EMBED_PIPELINE.get_or_init(|| Mutex::new(pipeline)))
}

#[napi]
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

    match validate_block(&block, prev.as_ref()) {
        Ok(()) => ok(serde_json::json!({ "valid": true })),
        Err(errors) => ok(serde_json::json!({ "valid": false, "errors": errors })),
    }
}

#[napi]
pub fn chain_append(chain_json: String, block_json: String) -> String {
    let mut blocks: Vec<Block> = match serde_json::from_str(&chain_json) {
        Ok(v) => v,
        Err(e) => return err(format!("invalid_chain_json: {e}")),
    };

    let block: Block = match serde_json::from_str(&block_json) {
        Ok(v) => v,
        Err(e) => return err(format!("invalid_block_json: {e}")),
    };

    let prev = blocks.last();
    if let Err(errors) = validate_block(&block, prev) {
        return ok(serde_json::json!({ "appended": false, "errors": errors }));
    }

    blocks.push(block);
    ok(serde_json::json!({ "appended": true, "length": blocks.len(), "chain": blocks }))
}

#[napi]
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

#[napi]
pub fn vault_init(request_json: String) -> String {
    let req: VaultInitRequest = match serde_json::from_str(&request_json) {
        Ok(v) => v,
        Err(e) => return err(format!("invalid_vault_init_json: {e}")),
    };

    match init_vault(req) {
        Ok(v) => ok(v),
        Err(e) => err(format!("vault_init_failed: {e}")),
    }
}

#[napi]
pub fn vault_encrypt(key: String, plaintext: String) -> String {
    match encrypt_entry(&key, &plaintext) {
        Ok(v) => ok(v),
        Err(e) => err(format!("vault_encrypt_failed: {e}")),
    }
}

#[napi]
pub fn vault_decrypt(entry_json: String) -> String {
    let entry: VaultEntry = match serde_json::from_str(&entry_json) {
        Ok(v) => v,
        Err(e) => return err(format!("invalid_vault_entry_json: {e}")),
    };

    match decrypt_entry(&entry) {
        Ok(v) => ok(serde_json::json!({ "plaintext": v })),
        Err(e) => err(format!("vault_decrypt_failed: {e}")),
    }
}

#[napi]
pub fn embed_store(id: String, text: String) -> String {
    let pipeline = match get_embed_pipeline() {
        Ok(p) => p,
        Err(e) => return err(e),
    };

    let mut pipeline = match pipeline.lock() {
        Ok(v) => v,
        Err(_) => return err("embed_pipeline_lock_failed"),
    };

    match pipeline.upsert(id.clone(), text) {
        Ok(count) => ok(EmbedStoreOut {
            id,
            count,
            dim: pipeline.dim(),
            provider: pipeline.provider_name().to_string(),
            persistence_enabled: pipeline.persistence_enabled(),
            persistence_load_state: load_state_to_str(pipeline.persistence_load_state()).to_string(),
        }),
        Err(e) => err(format!("embed_store_failed: {e}")),
    }
}

#[napi]
pub fn embed_search(query: String, top_k: Option<u32>) -> String {
    let pipeline = match get_embed_pipeline() {
        Ok(p) => p,
        Err(e) => return err(e),
    };

    let pipeline = match pipeline.lock() {
        Ok(v) => v,
        Err(_) => return err("embed_pipeline_lock_failed"),
    };

    let limit = top_k.unwrap_or(5) as usize;
    match pipeline.search(&query, limit) {
        Ok(hits) => ok(EmbedSearchOut {
            query,
            count: hits.len(),
            hits: hits
                .into_iter()
                .map(|h| EmbedSearchHitOut {
                    id: h.id,
                    score: h.score,
                    text_preview: h.text_preview,
                })
                .collect(),
        }),
        Err(e) => err(format!("embed_search_failed: {e}")),
    }
}

#[napi]
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

#[cfg(test)]
mod tests {
    use super::{chain_validate, embed_reset, embed_search, embed_store, vault_decrypt, vault_encrypt, vault_init};
    use memphis_core::block::{Block, BlockData, BlockType};

    #[test]
    fn validate_returns_json_response() {
        let block = Block {
            index: 0,
            timestamp: "2026-03-08T21:00:00Z".to_string(),
            chain: "journal".to_string(),
            data: BlockData {
                block_type: BlockType::Journal,
                content: "hello".to_string(),
                tags: vec!["x".to_string()],
            },
            prev_hash: "0".repeat(64),
            hash: "h0".to_string(),
        };

        let payload = serde_json::to_string(&block).unwrap();
        let out = chain_validate(payload, None);
        assert!(out.contains("\"ok\":true"));
    }

    #[test]
    fn vault_bridge_scaffold_roundtrip_json() {
        let init_payload = serde_json::json!({
            "passphrase": "VeryStrongPassphrase!123",
            "recovery_question": "pet?",
            "recovery_answer": "nori"
        })
        .to_string();

        let init_out = vault_init(init_payload);
        assert!(init_out.contains("\"ok\":true"));

        let enc_out = vault_encrypt("openai_api_key".to_string(), "secret".to_string());
        assert!(enc_out.contains("\"ok\":true"));

        let envelope: serde_json::Value = serde_json::from_str(&enc_out).unwrap();
        let entry = envelope.get("data").unwrap().to_string();
        let dec_out = vault_decrypt(entry);
        assert!(dec_out.contains("\"plaintext\":\"secret\""));
    }

    #[test]
    fn embed_bridge_roundtrip_json() {
        let _ = embed_reset();
        let a = embed_store("doc-a".to_string(), "local deterministic embeddings".to_string());
        let b = embed_store("doc-b".to_string(), "provider boundary in pipeline".to_string());
        assert!(a.contains("\"ok\":true"));
        assert!(b.contains("\"ok\":true"));

        let search = embed_search("deterministic".to_string(), Some(1));
        assert!(search.contains("\"ok\":true"));
        assert!(search.contains("\"hits\""));
    }
}
