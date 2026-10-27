//! Memory writes for the native operator runtime: journal, soul, case
//! entries and chain blocks, plus the derived exact-search and embedding
//! indices those writes maintain.
//!
//! WHY THIS MODULE EXISTS
//! -----------------------
//! Writing to a chain is the operation with the most preconditions in the
//! whole runtime: the block must be canonical, the chain name must be
//! valid, the hash chain must link to the previous block, and the derived
//! indices must be updated or explicitly reported as not updated. That
//! logic sat in the middle of `chat.rs`, between the tool executor and
//! the system prompt, where nothing about the file signalled that it was
//! the durable-write path.
//!
//! It is here now so that "how does a tool write durable state" has one
//! answer in one file.
//!
//! Split out of `chat.rs` unchanged.

use chrono::Utc;
use std::collections::{BTreeMap, HashSet};
use std::fs;
use std::path::Path;

use memphis_case_index::CaseIndex;
use memphis_core::hash::to_canonical_hash_data;
use memphis_core::{
    block::{Block, BlockData, BlockType},
    case_entry::CaseEntry,
};
use memphis_embed::EmbedPipeline;
use rusqlite::{params, OptionalExtension};
use serde_json::{json, Value};

use crate::chat_guards::{
    emit_runtime_security_event, load_json_file, scan_memory_content, sha256_hex, write_json_file,
};
use crate::chat_session::open_sqlite_rw;
use crate::chat_tool_catalog::native_tool_definitions;
use crate::runtime::{MemoryQueryResult, OperatorRuntime, SearchMode};
use crate::text_truncation::truncate_with_ellipsis;
use crate::{JournalWriteResult, OperatorError};

/// Previous-hash value of the first block in a chain.
pub(crate) const GENESIS_PREV_HASH: &str =
    "0000000000000000000000000000000000000000000000000000000000000000";

pub(crate) fn run_native_journal(
    runtime: &OperatorRuntime,
    content: &str,
    tags: Vec<String>,
) -> Result<JournalWriteResult, OperatorError> {
    if let Err((pattern_id, reason)) = scan_memory_content(content) {
        emit_runtime_security_event(
            runtime,
            "content_scan.journal.blocked",
            "blocked",
            json!({
                "patternId": pattern_id,
                "reason": reason,
                "profile": "memory",
                "contentHash": sha256_hex(content.as_bytes()),
            }),
        )?;
        return Ok(JournalWriteResult {
            success: false,
            memory_id: String::new(),
            index: 0,
            hash: String::new(),
            indexed: false,
            error: Some(format!("Blocked journal content: {reason}")),
            pattern_id: Some(pattern_id),
        });
    }

    // Fix #legacy-migrateable-2026-09-01: every journal block must carry
    // `type: "journal"` so the firstRun validator at
    // src/onboarding/first-run.ts:236 does not flag this block as
    // legacy-shape. Without this, every native chat journal write
    // regresses the runtime to `legacy-migrateable` and
    // `memphis repair runtime --force` becomes a recurring chore
    // instead of a one-shot migration.
    let append = append_generic_block(
        &runtime.config.data_dir,
        "journal",
        json!({
            "type": "journal",
            "content": content,
            "tags": tags,
            "source": "memphis-rust",
        }),
    )?;
    let memory_id = format!("journal-{}", append.index);
    let exact_indexed = upsert_exact_search_entry(
        &runtime.config.database_path,
        ExactSearchEntry {
            source_key: format!("journal:{}", append.index),
            chain: "journal".to_string(),
            block_index: append.index,
            block_hash: append.hash.clone(),
            block_type: "journal".to_string(),
            content: content.to_string(),
            summary: summarize_content(content),
            tags: tags.clone(),
            metadata: json!({ "source": "memphis-rust" }),
        },
    )?;

    let embed_indexed = upsert_embed_memory(
        runtime,
        &memory_id,
        content,
        &embed_tags_for_chain("journal", &tags),
    )
    .is_ok();

    Ok(JournalWriteResult {
        success: true,
        memory_id,
        index: append.index,
        hash: append.hash,
        indexed: exact_indexed || embed_indexed,
        error: None,
        pattern_id: None,
    })
}

pub(crate) fn run_soul_read(
    runtime: &OperatorRuntime,
    section: Option<&str>,
) -> Result<Value, OperatorError> {
    let manifest = ensure_soul_manifest(runtime)?;
    let memory = load_json_file(
        &runtime
            .config
            .data_dir
            .join("config")
            .join("soul-memory.json"),
    );

    let manifest_summary = json!({
        "agent": manifest.pointer("/identity/agentName").and_then(Value::as_str).unwrap_or("Memphis Agent"),
        "owner": manifest.pointer("/identity/ownerName").and_then(Value::as_str).unwrap_or("local operator"),
        "mode": manifest.pointer("/mode").and_then(Value::as_str).unwrap_or("balanced"),
        "created": manifest.pointer("/identity/createdAt").and_then(Value::as_str).unwrap_or(""),
    });

    let memory_section = match (section.unwrap_or("all"), memory) {
        (_, None) => Value::Null,
        ("all", Some(memory)) => memory,
        ("user", Some(memory)) => memory.get("user").cloned().unwrap_or(Value::Null),
        ("self", Some(memory)) => memory.get("self").cloned().unwrap_or(Value::Null),
        ("context", Some(memory)) => memory.get("context").cloned().unwrap_or(Value::Null),
        (_, Some(memory)) => memory,
    };

    Ok(json!({
        "manifest": manifest_summary,
        "memory": memory_section
    }))
}

pub(crate) fn run_soul_write(
    runtime: &OperatorRuntime,
    updates: Value,
) -> Result<Value, OperatorError> {
    // Shape validation runs FIRST so a caller that sends only unknown keys
    // gets "unknown section `meta`" instead of the generic "must contain at
    // least one of user, self, context" — the specific error is the one that
    // tells the operator what to fix.
    validate_soul_update_shape(&updates)?;

    let has_supported_section = ["user", "self", "context"]
        .iter()
        .any(|key| updates.get(key).is_some());
    if !has_supported_section {
        return Err(OperatorError::Message(
            "memphis_soul_write updates must contain at least one of user, self, or context"
                .to_string(),
        ));
    }

    let raw =
        serde_json::to_string(&updates).map_err(|error| OperatorError::Json(error.to_string()))?;
    if let Err((pattern_id, reason)) = scan_memory_content(raw.as_str()) {
        emit_runtime_security_event(
            runtime,
            "content_scan.soul_write.blocked",
            "blocked",
            json!({
                "patternId": pattern_id,
                "reason": reason,
                "profile": "memory",
                "contentHash": sha256_hex(raw.as_bytes()),
            }),
        )?;
        return Ok(json!({
            "success": false,
            "updated": [],
            "timestamp": Utc::now().to_rfc3339(),
            "error": format!("Blocked soul write: {reason}"),
            "patternId": pattern_id,
        }));
    }

    let soul_path = runtime
        .config
        .data_dir
        .join("config")
        .join("soul-memory.json");
    // Distinguish "no file yet" (legitimate first run -> empty baseline) from
    // "file exists but is unreadable/corrupt" (must NOT be overwritten with
    // an empty baseline -- that is how decision #317 escalated one malformed
    // write into total loss of every section).
    let existing = match load_json_file(&soul_path) {
        Some(value) => value,
        None if !soul_path.exists() => json!({
            "schemaVersion": 1,
            "lastUpdated": Utc::now().to_rfc3339(),
            "user": { "languages": [], "preferences": [], "expertise": [], "integrations": [] },
            "self": { "strengths": [], "learnings": [], "evolvedCapabilities": [] },
            "context": { "recentDecisions": [] },
        }),
        None => {
            let preview = fs::read_to_string(&soul_path)
                .map(|raw| raw.chars().take(200).collect::<String>())
                .unwrap_or_else(|error| format!("<unreadable: {error}>"));
            return Err(OperatorError::Message(format!(
                "soul_write: {} exists but is not valid JSON; refusing to write over it \
                 (an empty baseline would erase every section). First 200 chars: {preview}. \
                 Repair or move the file aside, then retry.",
                soul_path.display()
            )));
        }
    };

    let mut merged = existing;
    // Shape conflicts are REFUSED, not merged. `merge_soul_value` validates
    // before mutating, so on Err the in-memory document is still the exact
    // bytes we loaded and we return before `write_json_file` — the operator's
    // existing soul memory is never touched by a malformed patch.
    merge_soul_value(&mut merged, &updates)
        .map_err(|reason| OperatorError::Message(format!("{reason}; no changes were written")))?;
    if let Some(object) = merged.as_object_mut() {
        object.insert(
            "lastUpdated".to_string(),
            Value::String(Utc::now().to_rfc3339()),
        );
    }
    write_json_file(&soul_path, &merged)?;

    let mut updated = Vec::new();
    for key in ["user", "self", "context"] {
        if updates.get(key).is_some() {
            updated.push(key.to_string());
        }
    }

    for section in &updated {
        let possessed = summarize_possessed(section, &updates);
        let object = summarize_change(section, &updates);
        let _ = append_case_entry(
            runtime,
            &CaseEntry::Genitive {
                owner: "soul".to_string(),
                possessed,
            },
        );
        let _ = append_case_entry(
            runtime,
            &CaseEntry::Accusative {
                subject: "agent".to_string(),
                verb: "learned".to_string(),
                object,
            },
        );
    }

    Ok(json!({
        "success": true,
        "updated": updated,
        "timestamp": merged.get("lastUpdated").and_then(Value::as_str).unwrap_or(""),
    }))
}

pub(crate) fn append_case_entry(
    runtime: &OperatorRuntime,
    entry: &CaseEntry,
) -> Result<GenericAppendResult, OperatorError> {
    entry.validate().map_err(OperatorError::Message)?;
    let content = entry
        .to_block_content()
        .map_err(|error| OperatorError::Json(error.to_string()))?;
    let tags = vec![entry.tag()];
    let append = append_generic_block(
        &runtime.config.data_dir,
        "cases",
        json!({
            "type": "case",
            "content": content,
            "tags": tags,
            "source": "memphis-rust",
        }),
    )?;
    let block = Block {
        index: append.index,
        timestamp: append.timestamp.clone(),
        chain: "cases".to_string(),
        data: BlockData {
            block_type: BlockType::Case,
            content,
            tags,
        },
        prev_hash: append.prev_hash.clone(),
        hash: append.hash.clone(),
        signer: None,
        signature: None,
    };
    let index = CaseIndex::open(&runtime.config.case_index_path)
        .map_err(|error| OperatorError::Message(error.to_string()))?;
    index
        .index_block(&block)
        .map_err(|error| OperatorError::Message(error.to_string()))?;
    Ok(append)
}

pub(crate) fn append_generic_block(
    data_dir: &Path,
    chain_name: &str,
    data: Value,
) -> Result<GenericAppendResult, OperatorError> {
    validate_chain_name(chain_name)?;
    let chain_dir = data_dir.join("chains").join(chain_name);
    fs::create_dir_all(&chain_dir).map_err(|error| OperatorError::Io(error.to_string()))?;
    let _writer = crate::chain_write_lock::ChainWriteLock::acquire(&chain_dir)?;
    let blocks = read_chain_blocks(&chain_dir)?;
    let previous = blocks.last();
    let index = previous.map(|block| block.index + 1).unwrap_or(1);
    let timestamp = Utc::now().to_rfc3339();
    let prev_hash = previous
        .map(|block| block.hash.clone())
        .unwrap_or_else(|| GENESIS_PREV_HASH.to_string());
    let canonical_data = to_canonical_hash_data(&data);
    let block_without_hash = json!({
        "index": index,
        "timestamp": timestamp,
        "chain": chain_name,
        "data": canonical_data,
        "prev_hash": prev_hash,
    });
    let hash = sha256_hex(stable_json(block_without_hash.clone())?.as_bytes());
    let block = json!({
        "index": index,
        "timestamp": timestamp,
        "chain": chain_name,
        "data": data,
        "prev_hash": prev_hash,
        "hash": hash,
    });
    let file_path = chain_dir.join(format!("{index:06}.json"));
    let tmp_path = chain_dir.join(format!("{index:06}.json.tmp-{}", std::process::id()));
    fs::write(
        &tmp_path,
        serde_json::to_vec_pretty(&block)
            .map_err(|error| OperatorError::Json(error.to_string()))?,
    )
    .map_err(|error| OperatorError::Io(error.to_string()))?;
    fs::File::open(&tmp_path)
        .and_then(|file| file.sync_all())
        .map_err(|error| OperatorError::Io(error.to_string()))?;
    fs::rename(&tmp_path, &file_path).map_err(|error| OperatorError::Io(error.to_string()))?;
    fs::File::open(&chain_dir)
        .and_then(|directory| directory.sync_all())
        .map_err(|error| OperatorError::Io(error.to_string()))?;
    Ok(GenericAppendResult {
        index,
        hash,
        timestamp,
        prev_hash,
    })
}

pub(crate) fn read_chain_blocks(chain_dir: &Path) -> Result<Vec<GenericChainBlock>, OperatorError> {
    if !chain_dir.exists() {
        return Ok(Vec::new());
    }
    let mut entries = fs::read_dir(chain_dir)
        .map_err(|error| OperatorError::Io(error.to_string()))?
        .filter_map(Result::ok)
        .filter(|entry| entry.path().extension().and_then(|value| value.to_str()) == Some("json"))
        .collect::<Vec<_>>();
    entries.sort_by_key(|entry| entry.file_name());

    let mut blocks = Vec::new();
    for entry in entries {
        let value = serde_json::from_slice::<Value>(
            &fs::read(entry.path()).map_err(|error| OperatorError::Io(error.to_string()))?,
        )
        .map_err(|error| OperatorError::Json(error.to_string()))?;
        let block = GenericChainBlock {
            index: value.get("index").and_then(Value::as_u64).unwrap_or(0),
            timestamp: value
                .get("timestamp")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            chain: value
                .get("chain")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            data: value.get("data").cloned().unwrap_or(Value::Null),
            prev_hash: value
                .get("prev_hash")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            hash: value
                .get("hash")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
        };
        validate_generic_block(&block, blocks.last())?;
        blocks.push(block);
    }
    Ok(blocks)
}

pub(crate) fn validate_generic_block(
    block: &GenericChainBlock,
    previous: Option<&GenericChainBlock>,
) -> Result<(), OperatorError> {
    // Use the canonical 3-field form of `data` (type/content/tags), matching
    // the TS-side chain-adapter writer. Without this, TS-written blocks with
    // extra fields (source, turn_id, conversation_id, session_id, consent,
    // ...) fail validation here with `chain integrity check failed for
    // {chain}:{index} hash mismatch` even though they are valid.
    let canonical_data = to_canonical_hash_data(&block.data);
    let block_without_hash = json!({
        "index": block.index,
        "timestamp": block.timestamp,
        "chain": block.chain,
        "data": canonical_data,
        "prev_hash": block.prev_hash,
    });
    let expected_hash = sha256_hex(stable_json(block_without_hash)?.as_bytes());
    if block.hash != expected_hash {
        return Err(OperatorError::Message(format!(
            "chain integrity check failed for {}:{} hash mismatch",
            block.chain, block.index
        )));
    }
    match previous {
        None => {
            if block.index != 0 && block.index != 1 {
                return Err(OperatorError::Message(format!(
                    "chain integrity check failed for {}:{} missing genesis block",
                    block.chain, block.index
                )));
            }
            if block.index == 0 && block.prev_hash != GENESIS_PREV_HASH {
                return Err(OperatorError::Message(format!(
                    "chain integrity check failed for {}:{} prev_hash mismatch",
                    block.chain, block.index
                )));
            }
        }
        Some(previous) => {
            if block.index != previous.index + 1 {
                return Err(OperatorError::Message(format!(
                    "chain integrity check failed for {}:{} non-sequential index",
                    block.chain, block.index
                )));
            }
            if block.prev_hash != previous.hash {
                return Err(OperatorError::Message(format!(
                    "chain integrity check failed for {}:{} prev_hash mismatch",
                    block.chain, block.index
                )));
            }
        }
    }
    Ok(())
}

pub(crate) fn validate_chain_name(chain_name: &str) -> Result<(), OperatorError> {
    if chain_name.is_empty()
        || chain_name.contains("..")
        || chain_name.contains('/')
        || chain_name.contains('\\')
        || !chain_name
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '_' || ch == '-')
    {
        return Err(OperatorError::Message("invalid chain name".to_string()));
    }
    Ok(())
}

pub(crate) fn stable_json(value: Value) -> Result<String, OperatorError> {
    serde_json::to_string(&canonicalize(value))
        .map_err(|error| OperatorError::Json(error.to_string()))
}

pub(crate) fn canonicalize(value: Value) -> Value {
    match value {
        Value::Array(items) => Value::Array(items.into_iter().map(canonicalize).collect()),
        Value::Object(map) => {
            let mut next = serde_json::Map::new();
            let mut sorted = BTreeMap::new();
            for (key, value) in map {
                sorted.insert(key, value);
            }
            for (key, value) in sorted {
                next.insert(key, canonicalize(value));
            }
            Value::Object(next)
        }
        other => other,
    }
}

#[derive(Debug, Clone)]
pub(crate) struct ExactSearchEntry {
    source_key: String,
    pub(crate) chain: String,
    block_index: u64,
    block_hash: String,
    block_type: String,
    content: String,
    summary: String,
    tags: Vec<String>,
    metadata: Value,
}

pub(crate) fn upsert_exact_search_entry(
    path: &Path,
    entry: ExactSearchEntry,
) -> Result<bool, OperatorError> {
    let conn = open_sqlite_rw(path)?;
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS memory_search_entries (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          source_key TEXT NOT NULL UNIQUE,
          chain_name TEXT NOT NULL,
          block_index INTEGER NOT NULL,
          block_hash TEXT NOT NULL,
          block_type TEXT NOT NULL,
          content TEXT NOT NULL,
          summary TEXT NOT NULL,
          tags_json TEXT NOT NULL DEFAULT '[]',
          tags_text TEXT NOT NULL DEFAULT '',
          metadata_json TEXT NOT NULL DEFAULT '{}',
          indexed_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_memory_search_entries_chain_block
          ON memory_search_entries(chain_name, block_index DESC);
        CREATE VIRTUAL TABLE IF NOT EXISTS memory_search_fts USING fts5(
          content,
          tags_text,
          summary,
          content='memory_search_entries',
          content_rowid='id',
          tokenize='unicode61'
        );
        CREATE TRIGGER IF NOT EXISTS memory_search_entries_ai AFTER INSERT ON memory_search_entries BEGIN
          INSERT INTO memory_search_fts(rowid, content, tags_text, summary)
          VALUES (new.id, new.content, new.tags_text, new.summary);
        END;
        CREATE TRIGGER IF NOT EXISTS memory_search_entries_ad AFTER DELETE ON memory_search_entries BEGIN
          INSERT INTO memory_search_fts(memory_search_fts, rowid, content, tags_text, summary)
          VALUES('delete', old.id, old.content, old.tags_text, old.summary);
        END;
        CREATE TRIGGER IF NOT EXISTS memory_search_entries_au AFTER UPDATE ON memory_search_entries BEGIN
          INSERT INTO memory_search_fts(memory_search_fts, rowid, content, tags_text, summary)
          VALUES('delete', old.id, old.content, old.tags_text, old.summary);
          INSERT INTO memory_search_fts(rowid, content, tags_text, summary)
          VALUES (new.id, new.content, new.tags_text, new.summary);
        END;
    "#,
    )
    .map_err(|error| OperatorError::Sqlite(error.to_string()))?;
    let tags = entry
        .tags
        .into_iter()
        .filter(|tag| !tag.trim().is_empty())
        .collect::<HashSet<_>>()
        .into_iter()
        .collect::<Vec<_>>();
    let tags_json =
        serde_json::to_string(&tags).map_err(|error| OperatorError::Json(error.to_string()))?;
    let metadata_json = serde_json::to_string(&entry.metadata)
        .map_err(|error| OperatorError::Json(error.to_string()))?;
    let indexed_at = Utc::now().to_rfc3339();
    let existing = conn
        .query_row(
            "SELECT id FROM memory_search_entries WHERE source_key = ?",
            params![entry.source_key],
            |row| row.get::<_, i64>(0),
        )
        .optional()
        .map_err(|error| OperatorError::Sqlite(error.to_string()))?;
    match existing {
        Some(id) => {
            conn.execute(
                r#"
                UPDATE memory_search_entries
                SET chain_name = ?, block_index = ?, block_hash = ?, block_type = ?, content = ?,
                    summary = ?, tags_json = ?, tags_text = ?, metadata_json = ?, indexed_at = ?
                WHERE id = ?
                "#,
                params![
                    entry.chain,
                    entry.block_index as i64,
                    entry.block_hash,
                    entry.block_type,
                    entry.content,
                    entry.summary,
                    tags_json,
                    tags.join(" "),
                    metadata_json,
                    indexed_at,
                    id,
                ],
            )
            .map_err(|error| OperatorError::Sqlite(error.to_string()))?;
        }
        None => {
            conn.execute(
                r#"
                INSERT INTO memory_search_entries (
                  source_key, chain_name, block_index, block_hash, block_type, content, summary, tags_json, tags_text, metadata_json, indexed_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                "#,
                params![
                    entry.source_key,
                    entry.chain,
                    entry.block_index as i64,
                    entry.block_hash,
                    entry.block_type,
                    entry.content,
                    entry.summary,
                    tags_json,
                    tags.join(" "),
                    metadata_json,
                    indexed_at,
                ],
            )
            .map_err(|error| OperatorError::Sqlite(error.to_string()))?;
        }
    }
    Ok(true)
}

pub(crate) fn upsert_embed_memory(
    runtime: &OperatorRuntime,
    id: &str,
    content: &str,
    tags: &[String],
) -> Result<(), OperatorError> {
    let mut pipeline = EmbedPipeline::with_persistence(
        runtime.config.embed_config.clone(),
        runtime.config.embed_persistence(),
    )
    .map_err(|error| OperatorError::Embed(error.to_string()))?;
    pipeline
        .upsert_with_tags(id.to_string(), content.to_string(), tags.to_vec())
        .map_err(|error| OperatorError::Embed(error.to_string()))?;
    Ok(())
}

pub(crate) fn summarize_content(content: &str) -> String {
    let collapsed = content.split_whitespace().collect::<Vec<_>>().join(" ");
    if collapsed.len() <= 160 {
        collapsed
    } else {
        // The cut must land on a character boundary. A fixed byte
        // offset panicked on Polish text: the 2026-10-27 incident was
        // a journal block whose low-9 quote (`„`) sat at byte 156,
        // and `&collapsed[..157]` split it. The block landed in the
        // chain and never reached the index.
        truncate_with_ellipsis(&collapsed, 157)
    }
}

pub(crate) fn value_string_array(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(ToString::to_string)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default()
}

pub(crate) fn embed_tags_for_chain(chain: &str, tags: &[String]) -> Vec<String> {
    let chain_tag = format!("chain:{chain}");
    let mut merged = tags.to_vec();
    if !merged.iter().any(|tag| tag == &chain_tag) {
        merged.push(chain_tag);
    }
    merged
}

pub(crate) fn value_usize(value: Option<&Value>) -> Option<usize> {
    value
        .and_then(Value::as_u64)
        .map(|value| value as usize)
        .or_else(|| {
            value
                .and_then(Value::as_i64)
                .map(|value| value.max(0) as usize)
        })
}

pub(crate) fn resolved_manifest_identity(runtime: &OperatorRuntime) -> (String, String, String) {
    let profile = load_json_file(
        &runtime
            .config
            .data_dir
            .join("config")
            .join("agent-profile.json"),
    );

    let agent_name = profile
        .as_ref()
        .and_then(|profile| profile.get("agentName"))
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .or_else(|| runtime.config.env("MEMPHIS_AGENT_NAME"))
        .unwrap_or("Memphis Agent")
        .to_string();
    let owner_name = profile
        .as_ref()
        .and_then(|profile| profile.get("ownerName"))
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .or_else(|| runtime.config.env("MEMPHIS_OWNER_NAME"))
        .unwrap_or("local operator")
        .to_string();
    let runtime_mode = profile
        .as_ref()
        .and_then(|profile| profile.get("runtimeMode"))
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .or_else(|| runtime.config.env("MEMPHIS_RUNTIME_MODE"))
        .unwrap_or("solo-local")
        .to_string();

    (agent_name, owner_name, runtime_mode)
}

pub(crate) fn build_fresh_soul_manifest(runtime: &OperatorRuntime) -> Value {
    let tools = native_tool_definitions()
        .into_iter()
        .map(|tool| Value::String(tool.name))
        .collect::<Vec<_>>();
    let providers = runtime
        .provider_statuses()
        .into_iter()
        .map(|provider| Value::String(provider.name))
        .collect::<Vec<_>>();
    let (agent_name, owner_name, runtime_mode) = resolved_manifest_identity(runtime);
    let mut channels = vec![
        Value::String("cli".to_string()),
        Value::String("mcp".to_string()),
        Value::String("http".to_string()),
    ];
    if runtime.config.telegram_enabled {
        channels.push(Value::String("telegram".to_string()));
    }

    json!({
        "schemaVersion": 1,
        "generatedAt": Utc::now().to_rfc3339(),
        "identity": {
            "agentName": agent_name,
            "ownerName": owner_name,
            "runtimeMode": runtime_mode,
            "createdAt": Utc::now().to_rfc3339(),
        },
        "capabilities": {
            "tools": tools,
            "chains": ["journal", "decisions", "system", "reflections", "cases", "collective", "patterns"],
            "channels": channels,
            "providers": providers,
            "rustBridge": runtime.config.rust_chain_enabled,
        },
        "boundaries": {
            "tier0": { "auth": "none", "scope": "soul memory, journal, recall, health, case entries" },
            "tier1": { "auth": "api_token", "scope": "config, channels, providers, vault secrets" },
            "tier2": {
                "auth": "vault_passphrase",
                "scope": "source code, tools, handlers - requires snapshot + branch + tests"
            }
        },
        "evolution": {
            "autoApproveReflections": true,
            "requirePassphraseForTier2": true,
            "snapshotBeforeEvolution": true
        },
        "mode": runtime.config.env("MEMPHIS_AUTONOMY_MODE").unwrap_or("balanced"),
        "trustRules": [
            { "tool": "memphis_exec", "autoApprove": true, "addedAt": Utc::now().to_rfc3339() },
            { "tool": "memphis_self_modify", "autoApprove": true, "addedAt": Utc::now().to_rfc3339() }
        ]
    })
}

pub(crate) fn ensure_soul_manifest(runtime: &OperatorRuntime) -> Result<Value, OperatorError> {
    let path = runtime
        .config
        .data_dir
        .join("config")
        .join("soul-manifest.json");
    let existing = load_json_file(&path);
    let mut manifest = build_fresh_soul_manifest(runtime);

    if let Some(created_at) = existing
        .as_ref()
        .and_then(|value| value.pointer("/identity/createdAt"))
        .cloned()
    {
        manifest["identity"]["createdAt"] = created_at;
    }
    if let Some(did) = existing
        .as_ref()
        .and_then(|value| value.pointer("/identity/did"))
        .cloned()
    {
        manifest["identity"]["did"] = did;
    }
    if let Some(mode) = existing
        .as_ref()
        .and_then(|value| value.get("mode"))
        .cloned()
    {
        manifest["mode"] = mode;
    }
    if let Some(cognitive_mode) = existing
        .as_ref()
        .and_then(|value| value.get("cognitiveMode"))
        .cloned()
    {
        manifest["cognitiveMode"] = cognitive_mode;
    }
    if runtime.config.env("MEMPHIS_AUTONOMY_MODE").is_some() {
        manifest["mode"] = Value::String(
            runtime
                .config
                .env("MEMPHIS_AUTONOMY_MODE")
                .unwrap_or("balanced")
                .to_string(),
        );
    }
    if let Some(existing_evolution) = existing
        .as_ref()
        .and_then(|value| value.get("evolution"))
        .and_then(Value::as_object)
    {
        if let Some(target) = manifest.get_mut("evolution").and_then(Value::as_object_mut) {
            for (key, value) in existing_evolution {
                target.insert(key.clone(), value.clone());
            }
        }
    }
    if let Some(existing_trust_rules) = existing
        .as_ref()
        .and_then(|value| value.get("trustRules"))
        .and_then(Value::as_array)
        .filter(|rules| !rules.is_empty())
        .cloned()
    {
        manifest["trustRules"] = Value::Array(existing_trust_rules);
    }

    write_json_file(&path, &manifest)?;
    Ok(manifest)
}

pub(crate) fn is_soul_list_value(value: &Value) -> bool {
    match value {
        Value::Array(items) => items.iter().all(Value::is_string),
        // Single string in a list position: one-item list, matches TS.
        Value::String(_) => true,
        _ => false,
    }
}

pub(crate) fn soul_value_kind(value: &Value) -> &'static str {
    match value {
        Value::Null => "null",
        Value::Bool(_) => "bool",
        Value::Number(_) => "number",
        Value::String(_) => "string",
        Value::Array(_) => "array",
        Value::Object(_) => "object",
    }
}

/// Classify a shape conflict between an existing value and an incoming patch.
///
/// Returns `None` when the pair is a legitimate merge (object/object,
/// list/list, or scalar replacement) so the caller can proceed.
/// Returns `Some(message)` when one side is a list and the other an object —
/// that is always corruption, never a merge.
///
/// `legacy` is the raw JSON text when the caller wants to distinguish "the
/// existing file is corrupt" from "the patch is corrupt", so the error can
/// name the repair path instead of silently refusing forever.
pub(crate) fn soul_shape_conflict(target: &Value, patch: &Value) -> Option<String> {
    match (target, patch) {
        (Value::Object(_), patch_value) if is_soul_list_value(patch_value) => {
            let keys = patch_value
                .as_object()
                .map(|map| map.keys().cloned().collect::<Vec<_>>().join(", "))
                .unwrap_or_default();
            Some(format!(
                "soul_write: refusing to merge list into object field (patch has object keys [{keys}]); \
                 list fields must stay arrays"
            ))
        }
        (target_value, Value::Object(_)) if is_soul_list_value(target_value) => Some(format!(
            "soul_write: refusing to merge object into list field (existing value is {}); \
             list fields must stay arrays",
            soul_value_kind(target_value)
        )),
        _ => None,
    }
}

/// Field shape tables for `validate_soul_update_shape`, mirroring
/// `soulMemoryUpdateSchema` in `src/soul/types.ts` (zod, `.strict()`).
/// Scalars are optional strings; list fields are arrays of strings.
pub(crate) const SOUL_SCALAR_FIELDS: &[(&str, &[&str])] = &[
    ("user", &["name"]),
    ("self", &["personality"]),
    ("context", &["activeWork"]),
];

pub(crate) const SOUL_LIST_FIELDS: &[(&str, &[&str])] = &[
    (
        "user",
        &["languages", "preferences", "expertise", "integrations"],
    ),
    ("self", &["strengths", "learnings", "evolvedCapabilities"]),
    ("context", &["recentDecisions"]),
];

pub(crate) const SOUL_SECTIONS: &[&str] = &["user", "self", "context"];

fn soul_field_kind(value: &Value) -> &'static str {
    match value {
        Value::Null => "null (delete the key instead — this schema has no null)",
        Value::Bool(_) => "bool",
        Value::Number(_) => "number",
        Value::String(_) => "string",
        Value::Array(items) => {
            if items.iter().all(Value::is_string) {
                "array of strings"
            } else {
                "array containing non-string entries"
            }
        }
        Value::Object(map) if map.len() == 1 && map.contains_key("item") => {
            r#"object {\"item\": [...]} — a transport envelope leaked into the payload; \
               send the bare array instead"#
        }
        Value::Object(_) => "object",
    }
}

/// Reject a soul-write patch whose shape the schema does not allow.
///
/// Mirrors `soulMemoryUpdateSchema` so the Rust and JS entry points for
/// `memphis_soul_write` accept the same documents. Runs before any merge, so
/// a rejection leaves the on-disk file untouched — the operator's existing
/// soul memory can never be damaged by a malformed patch.
pub(crate) fn validate_soul_update_shape(updates: &Value) -> Result<(), OperatorError> {
    let object = match updates.as_object() {
        Some(map) => map,
        None => {
            return Err(OperatorError::Message(format!(
                "soul_write: updates must be an object with at least one of {}, got {}",
                SOUL_SECTIONS.join(", "),
                soul_value_kind(updates)
            )))
        }
    };

    for (key, value) in object {
        if !SOUL_SECTIONS.contains(&key.as_str()) {
            return Err(OperatorError::Message(format!(
                "soul_write: unknown section `{key}`; only {} are writable",
                SOUL_SECTIONS.join(", ")
            )));
        }
        let section = match value.as_object() {
            Some(map) => map,
            None => {
                return Err(OperatorError::Message(format!(
                    "soul_write: `{key}` must be an object of fields, got {}",
                    soul_value_kind(value)
                )))
            }
        };

        for (field, field_value) in section {
            let path = format!("{key}.{field}");
            if SOUL_SCALAR_FIELDS
                .iter()
                .find(|(section_key, _)| *section_key == key)
                .is_some_and(|(_, fields)| fields.contains(&field.as_str()))
            {
                if !field_value.is_string() {
                    return Err(OperatorError::Message(format!(
                        "soul_write: `{path}` must be a string, got {}",
                        soul_field_kind(field_value)
                    )));
                }
                continue;
            }
            if SOUL_LIST_FIELDS
                .iter()
                .find(|(section_key, _)| *section_key == key)
                .is_some_and(|(_, fields)| fields.contains(&field.as_str()))
            {
                let items = match field_value {
                    Value::Array(items) => items,
                    // A bare string in a list position is a one-item list.
                    // The TS merge guard (`is_soul_list_value`) has always
                    // accepted this, so accepting it here keeps the two
                    // surfaces in agreement instead of tightening the Rust
                    // one in the wrong direction. `merge_soul_value` is what
                    // actually normalises it to a one-element array.
                    Value::String(_) => continue,
                    _ => {
                        return Err(OperatorError::Message(format!(
                            "soul_write: `{path}` must be an array of strings, got {}",
                            soul_field_kind(field_value)
                        )))
                    }
                };
                if let Some(bad) = items.iter().find(|item| !item.is_string()) {
                    return Err(OperatorError::Message(format!(
                        "soul_write: `{path}` must contain only strings, found {} at position {}",
                        soul_value_kind(bad),
                        items
                            .iter()
                            .position(|item| std::ptr::eq(item, bad))
                            .unwrap_or(0)
                    )));
                }
                continue;
            }
            return Err(OperatorError::Message(format!(
                "soul_write: unknown field `{path}`; this section is strict — \
                 check the field list in the tool description"
            )));
        }
    }
    Ok(())
}

/// Deep-merge a soul-memory patch into `target`, rejecting shape conflicts.
///
/// Merges objects recursively, appends to string lists with dedupe, and
/// allows scalar replacement (`context.activeWork` legitimately overwrites).
/// A list-vs-object mismatch returns `Err` INSTEAD of clobbering, and the
/// validation runs before any mutation so the target is left untouched.
pub(crate) fn merge_soul_value(target: &mut Value, patch: &Value) -> Result<(), String> {
    if let Some(conflict) = soul_shape_conflict(target, patch) {
        return Err(conflict);
    }
    match (target, patch) {
        (Value::Object(target_map), Value::Object(patch_map)) => {
            for (key, patch_value) in patch_map {
                match target_map.get_mut(key) {
                    Some(existing) => merge_soul_value(existing, patch_value)?,
                    None => {
                        target_map.insert(key.clone(), patch_value.clone());
                    }
                }
            }
            Ok(())
        }
        (Value::Array(target_items), Value::Array(patch_items)) => {
            let mut seen = target_items
                .iter()
                .filter_map(Value::as_str)
                .map(ToString::to_string)
                .collect::<HashSet<_>>();
            for item in patch_items {
                if let Some(text) = item.as_str() {
                    if seen.insert(text.to_string()) {
                        target_items.push(Value::String(text.to_string()));
                    }
                }
            }
            Ok(())
        }
        // A bare string in a list position is a one-item list — `is_soul_list_value`
        // has always classified it that way. The merge arm was NOT consistent
        // with that classification: it fell through to scalar replacement and
        // wrote `"solo"` where the schema declares an array, which
        // `loadSoulMemory` then rejected on the next load (same failure class
        // as decision #317). Normalise here so the file is always schema-valid.
        (Value::Array(target_items), Value::String(text)) => {
            let text = text.clone();
            let already_present = target_items.iter().any(|item| item.as_str() == Some(&text));
            if !already_present {
                target_items.push(Value::String(text));
            }
            Ok(())
        }
        (target_value, patch_value) => {
            *target_value = patch_value.clone();
            Ok(())
        }
    }
}

pub(crate) fn summarize_possessed(section: &str, updates: &Value) -> String {
    updates
        .get(section)
        .and_then(Value::as_object)
        .map(|value| {
            value
                .keys()
                .map(|key| format!("{section}.{key}"))
                .collect::<Vec<_>>()
                .join(", ")
        })
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| section.to_string())
}

pub(crate) fn summarize_change(section: &str, updates: &Value) -> String {
    match section {
        "user" => updates
            .pointer("/user/name")
            .and_then(Value::as_str)
            .map(|name| format!("user name is {name}"))
            .or_else(|| {
                updates
                    .pointer("/user/preferences")
                    .and_then(Value::as_array)
                    .map(|items| {
                        let values = items.iter().filter_map(Value::as_str).collect::<Vec<_>>();
                        format!("user prefers: {}", values.join(", "))
                    })
            })
            .unwrap_or_else(|| "updated user profile".to_string()),
        "self" => updates
            .pointer("/self/learnings")
            .and_then(Value::as_array)
            .map(|items| {
                let values = items.iter().filter_map(Value::as_str).collect::<Vec<_>>();
                format!("learned: {}", values.join(", "))
            })
            .unwrap_or_else(|| "updated self-knowledge".to_string()),
        "context" => updates
            .pointer("/context/activeWork")
            .and_then(Value::as_str)
            .map(|value| format!("working on: {value}"))
            .unwrap_or_else(|| "updated context".to_string()),
        _ => format!("updated {section}"),
    }
}

#[derive(Debug, Clone)]
pub(crate) struct GenericChainBlock {
    pub(crate) index: u64,
    pub(crate) timestamp: String,
    pub(crate) chain: String,
    pub(crate) data: Value,
    pub(crate) prev_hash: String,
    pub(crate) hash: String,
}

#[derive(Debug, Clone)]
pub(crate) struct GenericAppendResult {
    pub(crate) index: u64,
    pub(crate) hash: String,
    pub(crate) timestamp: String,
    pub(crate) prev_hash: String,
}

pub(crate) fn search_result_to_json(result: &MemoryQueryResult) -> Value {
    match result.mode {
        SearchMode::Semantic => json!({
            "query": result.query,
            "count": result.count,
            "results": result.semantic_hits.iter().map(|hit| json!({
                "id": hit.id,
                "score": hit.score,
                "preview": hit.preview,
                "tags": hit.tags,
            })).collect::<Vec<_>>(),
        }),
        SearchMode::Exact => json!({
            "query": result.query,
            "count": result.count,
            "results": result.exact_hits.iter().map(|hit| json!({
                "sourceKey": hit.source_key,
                "chain": hit.chain,
                "blockIndex": hit.block_index,
                "blockType": hit.block_type,
                "score": hit.score,
                "snippet": hit.snippet,
                "summary": hit.summary,
            })).collect::<Vec<_>>(),
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::summarize_content;

    /// The incident of 2026-10-27, verbatim.
    ///
    /// A journal block carrying a Polish low-9 quote panicked the chat
    /// worker with "end byte index 157 is not a char boundary; it is
    /// inside '„' (bytes 156..159 of string)". The block was appended
    /// to the chain first and indexed second, so the panic left it in
    /// the chain and out of the search index — silently unsearchable.
    ///
    /// The content is the real one, trimmed to the part that carries
    /// the quote at byte 156.
    const INCIDENT: &str = "2026-10-27 15:50-16:20 UTC — druga tura sesji. Operator doprecyzował objaw: „jak pracujesz to się stroboskop w okół liter zrobił\" oraz poprosił o „współczesne interaktywne TUI dla użytkownika, w którym informacje o tool use są jakoś dyskretnie poinormowane, zobacz na nasze tools\"";

    #[test]
    fn the_incident_of_2026_10_27_does_not_panic() {
        let summary = summarize_content(INCIDENT);
        assert!(
            summary.ends_with("..."),
            "a long content must be marked as truncated, got: {summary}"
        );
        assert!(
            summary.len() <= 160,
            "the summary must stay within its budget, got {} bytes",
            summary.len()
        );
    }

    /// The quote that panicked has to straddle byte 157 for this test
    /// to be the incident and not an approximation of it.
    #[test]
    fn the_incident_content_really_has_a_quote_at_byte_156() {
        let collapsed = INCIDENT.split_whitespace().collect::<Vec<_>>().join(" ");
        let bytes = collapsed.as_bytes();
        let quote = "„".as_bytes();
        let mut straddling = None;
        let mut index = 0usize;
        while index + quote.len() <= bytes.len() {
            if &bytes[index..index + quote.len()] == quote
                && index < 157
                && index + quote.len() > 157
            {
                straddling = Some(index);
                break;
            }
            index += 1;
        }
        let position = straddling.expect("the incident text must have a quote at byte 156");
        assert!(
            position < 157 && position + quote.len() > 157,
            "the incident's quote must straddle byte 157, the one that panicked; it sits at {position}"
        );
    }

    /// Every alignment, not just the one that broke. A truncation that
    /// only works for ASCII panics on the first non-ASCII prose it
    /// meets — and prose in Polish is not ASCII.
    #[test]
    fn no_alignment_of_a_multibyte_character_panics() {
        for offset in 0..400usize {
            let mut content = "x".repeat(offset);
            content.push('„');
            content.push_str(&"y".repeat(400));
            let summary = summarize_content(&content);
            assert!(
                summary.len() <= 160,
                "offset {offset}: summary is {} bytes, over the budget",
                summary.len()
            );
        }
    }
}
