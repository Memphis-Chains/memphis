//! Session storage and durable transcript persistence for the native
//! operator runtime.
//!
//! WHY THIS MODULE EXISTS
//! -----------------------
//! `chat.rs` was a 6404-line file holding session storage, streaming
//! guards, the tool catalog, the tool executor and the system prompt in
//! one place. Every concern was reachable from every other, so a change to
//! transcript persistence could not be reviewed without reading tool
//! execution code, and vice versa.
//!
//! This module owns exactly one responsibility: the durable record of a
//! conversation. It reads and writes `operator_chat_messages` and
//! `sessions` in the runtime database and nothing else.
//!
//! The split is mechanical — the code moved here unchanged. The public
//! behaviour is asserted by the existing test suite in `chat.rs` and by
//! the new durability tests in this module.

use std::fs;
use std::path::Path;

use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension};
use serde::Deserialize;

use crate::provider::{ChatMessage, ChatToolCall};
use crate::{ChatTranscriptEntry, OperatorError};

/// Current time in RFC 3339, the format every timestamp in the runtime
/// database uses.
pub(crate) fn utc_now() -> String {
    Utc::now().to_rfc3339()
}

/// Default session used when the operator has not named one.
pub(crate) const DEFAULT_CHAT_SESSION_ID: &str = "primary::operator:local";

#[derive(Debug, Clone, Deserialize)]
pub(crate) struct StoredChatMessage {
    pub(crate) sequence: i64,
    pub(crate) role: String,
    pub(crate) content: String,
    pub(crate) display_content: String,
    pub(crate) tool_call_id: Option<String>,
    pub(crate) tool_name: Option<String>,
    pub(crate) tool_calls_json: Option<String>,
    pub(crate) created_at: String,
    pub(crate) provider: Option<String>,
    pub(crate) model: Option<String>,
}

#[derive(Debug, Clone)]
pub(crate) struct MessageToPersist {
    pub(crate) role: &'static str,
    pub(crate) content: String,
    pub(crate) display_content: String,
    pub(crate) tool_call_id: Option<String>,
    pub(crate) tool_name: Option<String>,
    pub(crate) tool_calls_json: Option<String>,
    pub(crate) provider: Option<String>,
    pub(crate) model: Option<String>,
}

pub(crate) fn normalize_session_id(session_id: Option<&str>) -> String {
    session_id
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(DEFAULT_CHAT_SESSION_ID)
        .to_string()
}

pub(crate) fn open_sqlite_rw(path: &Path) -> Result<Connection, OperatorError> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| OperatorError::Io(error.to_string()))?;
    }
    Connection::open(path).map_err(|error| OperatorError::Sqlite(error.to_string()))
}

pub(crate) fn ensure_chat_tables(conn: &Connection) -> Result<(), OperatorError> {
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS sessions (
          id TEXT PRIMARY KEY,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS operator_chat_messages (
          session_id TEXT NOT NULL,
          sequence INTEGER NOT NULL,
          role TEXT NOT NULL,
          content TEXT NOT NULL,
          display_content TEXT NOT NULL,
          tool_call_id TEXT,
          tool_name TEXT,
          tool_calls_json TEXT,
          provider TEXT,
          model TEXT,
          created_at TEXT NOT NULL,
          PRIMARY KEY(session_id, sequence)
        );

        CREATE INDEX IF NOT EXISTS idx_operator_chat_messages_session_sequence
          ON operator_chat_messages(session_id, sequence DESC);
    "#,
    )
    .map_err(|error| OperatorError::Sqlite(error.to_string()))
}

pub(crate) fn load_chat_rows(
    conn: &Connection,
    session_id: &str,
    limit: usize,
) -> Result<Vec<StoredChatMessage>, OperatorError> {
    let mut stmt = conn
        .prepare(
            r#"
            SELECT sequence, role, content, display_content, tool_call_id, tool_name, tool_calls_json, created_at, provider, model
            FROM operator_chat_messages
            WHERE session_id = ?
            ORDER BY sequence DESC
            LIMIT ?
            "#,
        )
        .map_err(|error| OperatorError::Sqlite(error.to_string()))?;
    let rows = stmt
        .query_map(params![session_id, limit as i64], |row| {
            Ok(StoredChatMessage {
                sequence: row.get(0)?,
                role: row.get(1)?,
                content: row.get(2)?,
                display_content: row.get(3)?,
                tool_call_id: row.get(4)?,
                tool_name: row.get(5)?,
                tool_calls_json: row.get(6)?,
                created_at: row.get(7)?,
                provider: row.get(8)?,
                model: row.get(9)?,
            })
        })
        .map_err(|error| OperatorError::Sqlite(error.to_string()))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| OperatorError::Sqlite(error.to_string()))?;
    let mut rows = rows;
    rows.sort_by_key(|row| row.sequence);
    Ok(drop_orphaned_tool_rows(rows))
}

/// Remove `role='tool'` rows whose `tool_call_id` has no matching assistant
/// `tool_calls_json` entry *in the same window*.
///
/// When the `LIMIT 40` truncation in `load_chat_rows` severs an assistant-
/// with-tool_calls row from its paired tool-result row (the assistant is
/// older than the cutoff, the tool-result is newer), the tool row becomes an
/// orphan. Sending that orphan to an OpenAI-compatible provider (MiniMax,
/// DeepSeek, GLM) produces a 400 with `tool result's tool id(...) not found`
/// — the API refuses a tool role without a preceding assistant that declared
/// that call id. Drop orphans before they reach the provider serializer.
pub(crate) fn drop_orphaned_tool_rows(rows: Vec<StoredChatMessage>) -> Vec<StoredChatMessage> {
    use std::collections::HashSet;

    let mut known_call_ids: HashSet<String> = HashSet::new();
    for row in &rows {
        if row.role != "assistant" {
            continue;
        }
        let Some(json) = row.tool_calls_json.as_deref() else {
            continue;
        };
        let Ok(calls) = serde_json::from_str::<Vec<ChatToolCall>>(json) else {
            continue;
        };
        for call in calls {
            known_call_ids.insert(call.id);
        }
    }

    rows.into_iter()
        .filter(|row| {
            if row.role != "tool" {
                return true;
            }
            match row.tool_call_id.as_deref() {
                Some(id) => known_call_ids.contains(id),
                None => false,
            }
        })
        .collect()
}

pub(crate) fn persist_chat_messages(
    conn: &Connection,
    session_id: &str,
    messages: &[MessageToPersist],
) -> Result<(), OperatorError> {
    if messages.is_empty() {
        return Ok(());
    }
    let tx = conn
        .unchecked_transaction()
        .map_err(|error| OperatorError::Sqlite(error.to_string()))?;
    let now = Utc::now().to_rfc3339();
    let created_at = tx
        .query_row(
            "SELECT created_at FROM sessions WHERE id = ?",
            params![session_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| OperatorError::Sqlite(error.to_string()))?;
    match created_at {
        Some(existing) => {
            tx.execute(
                "UPDATE sessions SET updated_at = ? WHERE id = ?",
                params![now, session_id],
            )
            .map_err(|error| OperatorError::Sqlite(error.to_string()))?;
            let _ = existing;
        }
        None => {
            tx.execute(
                "INSERT INTO sessions (id, created_at, updated_at) VALUES (?, ?, ?)",
                params![session_id, now, now],
            )
            .map_err(|error| OperatorError::Sqlite(error.to_string()))?;
        }
    }

    let mut sequence = tx
        .query_row(
            "SELECT COALESCE(MAX(sequence), 0) FROM operator_chat_messages WHERE session_id = ?",
            params![session_id],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|error| OperatorError::Sqlite(error.to_string()))?;

    for message in messages {
        sequence += 1;
        tx.execute(
            r#"
            INSERT INTO operator_chat_messages (
              session_id, sequence, role, content, display_content, tool_call_id, tool_name, tool_calls_json, provider, model, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            "#,
            params![
                session_id,
                sequence,
                message.role,
                message.content,
                message.display_content,
                message.tool_call_id,
                message.tool_name,
                message.tool_calls_json,
                message.provider,
                message.model,
                Utc::now().to_rfc3339(),
            ],
        )
        .map_err(|error| OperatorError::Sqlite(error.to_string()))?;
    }

    tx.commit()
        .map_err(|error| OperatorError::Sqlite(error.to_string()))
}

pub(crate) fn transcript_from_row(row: StoredChatMessage) -> ChatTranscriptEntry {
    ChatTranscriptEntry {
        role: row.role,
        content: row.display_content,
        created_at: row.created_at,
        tool_name: row.tool_name,
        provider: row.provider,
        model: row.model,
    }
}

pub(crate) fn row_to_chat_message(row: &StoredChatMessage) -> Option<ChatMessage> {
    match row.role.as_str() {
        "user" => Some(ChatMessage::User {
            content: row.content.clone(),
        }),
        "assistant" => Some(ChatMessage::Assistant {
            content: row.content.clone(),
            tool_calls: row
                .tool_calls_json
                .as_deref()
                .and_then(|raw| serde_json::from_str::<Vec<ChatToolCall>>(raw).ok())
                .unwrap_or_default(),
            // Hidden provider reasoning is intentionally not persisted.
            reasoning_content: None,
        }),
        "tool" => Some(ChatMessage::Tool {
            tool_call_id: row
                .tool_call_id
                .clone()
                .unwrap_or_else(|| "tool-call".to_string()),
            content: row.content.clone(),
        }),
        _ => None,
    }
}
