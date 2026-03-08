use memphis_core::block::Block;
use memphis_core::soul::validate_block;
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

#[cfg(test)]
mod tests {
    use super::{chain_validate, vault_decrypt, vault_encrypt, vault_init};
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
}
