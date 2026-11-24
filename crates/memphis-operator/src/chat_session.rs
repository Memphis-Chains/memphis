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
use serde::{Deserialize, Serialize};

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

#[derive(Debug, Clone, Serialize)]
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

/// Covers errors and panics before the normal turn-finalization path. A hard
/// process kill still leaves `running`, which requires operator inspection.
pub(crate) struct RunningCheckpointGuard<'a> {
    conn: &'a Connection,
    id: String,
}

impl<'a> RunningCheckpointGuard<'a> {
    pub(crate) fn new(conn: &'a Connection, id: &str) -> Self {
        Self {
            conn,
            id: id.to_string(),
        }
    }
}

impl Drop for RunningCheckpointGuard<'_> {
    fn drop(&mut self) {
        if self.conn.execute(
            "UPDATE operator_turn_checkpoints SET status='interrupted', updated_at=? WHERE id=? AND status='running'",
            params![utc_now(), self.id],
        ).is_err() {
            eprintln!("[recovery] could not mark the turn interrupted; inspect the running checkpoint");
        }
    }
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

        CREATE TABLE IF NOT EXISTS operator_turn_checkpoints (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          status TEXT NOT NULL,
          pending_json TEXT NOT NULL,
          partial_text TEXT NOT NULL DEFAULT '',
          partial_truncated INTEGER NOT NULL DEFAULT 0,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_operator_turn_checkpoints_session
          ON operator_turn_checkpoints(session_id, status, updated_at);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_operator_turn_one_running_per_session
          ON operator_turn_checkpoints(session_id) WHERE status='running';
    "#,
    )
    .map_err(|error| OperatorError::Sqlite(error.to_string()))?;
    // The lease columns carry the identity of the process that owns a
    // `running` checkpoint. Without them a killed process leaves a row
    // that refuses every later turn in the session forever — the wedge
    // documented in `chat_lease.rs`.
    for (name, declaration) in [
        ("partial_text", "TEXT NOT NULL DEFAULT ''"),
        ("partial_truncated", "INTEGER NOT NULL DEFAULT 0"),
        ("owner_pid", "INTEGER"),
        ("owner_boot_id", "TEXT"),
        ("owner_start_time", "INTEGER"),
    ] {
        let has_column = {
            let mut statement = conn
                .prepare("PRAGMA table_info(operator_turn_checkpoints)")
                .map_err(|error| OperatorError::Sqlite(error.to_string()))?;
            let columns = statement
                .query_map([], |row| row.get::<_, String>(1))
                .map_err(|error| OperatorError::Sqlite(error.to_string()))?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|error| OperatorError::Sqlite(error.to_string()))?;
            columns.iter().any(|column| column == name)
        };
        if !has_column {
            let sql =
                format!("ALTER TABLE operator_turn_checkpoints ADD COLUMN {name} {declaration}");
            if let Err(error) = conn.execute(&sql, []) {
                let present = conn
                    .prepare("PRAGMA table_info(operator_turn_checkpoints)")
                    .and_then(|mut statement| {
                        let columns = statement
                            .query_map([], |row| row.get::<_, String>(1))?
                            .collect::<Result<Vec<_>, _>>()?;
                        Ok(columns.iter().any(|column| column == name))
                    })
                    .unwrap_or(false);
                if !present {
                    return Err(OperatorError::Sqlite(error.to_string()));
                }
            }
        }
    }
    Ok(())
}

pub(crate) fn save_partial_turn_text(
    conn: &Connection,
    id: &str,
    text: &str,
    truncated: bool,
) -> Result<(), OperatorError> {
    conn.execute(
        "UPDATE operator_turn_checkpoints SET partial_text=?, partial_truncated=?, updated_at=? WHERE id=? AND status='running'",
        params![text, truncated, utc_now(), id],
    ).map_err(|error| OperatorError::Sqlite(error.to_string()))?;
    Ok(())
}

/// Stage an incomplete turn separately from the completed conversation.
/// The same database/access policy as the transcript applies. The cap is a
/// deliberate fail-closed boundary: silently dropping tool evidence would
/// make a later replay unsafe.
pub(crate) fn save_turn_checkpoint(
    conn: &Connection,
    id: &str,
    session_id: &str,
    status: &str,
    pending: &[MessageToPersist],
) -> Result<(), OperatorError> {
    let json =
        serde_json::to_string(pending).map_err(|error| OperatorError::Json(error.to_string()))?;
    if json.len() > 4 * 1024 * 1024 {
        return Err(OperatorError::Message(
            "turn checkpoint exceeds 4 MiB; operator review required".into(),
        ));
    }
    // A `running` checkpoint records the identity of its owner, so a
    // checkpoint left behind by a killed process can be told apart from
    // one that belongs to a live turn.
    let owner = crate::chat_lease::current_identity();
    conn.execute(
        "INSERT INTO operator_turn_checkpoints (id, session_id, status, pending_json, updated_at, owner_pid, owner_boot_id, owner_start_time) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8) \
         ON CONFLICT(id) DO UPDATE SET status=excluded.status, pending_json=excluded.pending_json, updated_at=excluded.updated_at, \
         owner_pid=excluded.owner_pid, owner_boot_id=excluded.owner_boot_id, owner_start_time=excluded.owner_start_time",
        params![
            id,
            session_id,
            status,
            json,
            utc_now(),
            owner.pid,
            owner.boot_id,
            owner.start_time as i64,
        ],
    ).map_err(|error| OperatorError::Sqlite(error.to_string()))?;
    Ok(())
}

/// Reclaim checkpoints whose owning process is gone.
///
/// A `running` checkpoint is only evidence of a live turn while its owner
/// is alive. When the owner died — a `SIGKILL`, an OOM kill, a reboot —
/// the row is a leftover, and it used to refuse every later turn in the
/// session forever. The operator's own remedy (killing the process) was
/// what created the next leftover.
///
/// Reclaiming is safe: the row is marked `abandoned`, not deleted, so the
/// audit trail of what happened survives. Whether the abandoned turn had
/// side effects is decided separately, by the unsettled-operations query
/// — which is the only signal that actually matters.
pub(crate) fn reclaim_abandoned_turns(
    conn: &Connection,
    session_id: &str,
) -> Result<usize, OperatorError> {
    let mut statement = conn
        .prepare(
            "SELECT id, owner_pid, owner_boot_id, owner_start_time FROM operator_turn_checkpoints \
         WHERE session_id=? AND status='running'",
        )
        .map_err(|error| OperatorError::Sqlite(error.to_string()))?;
    let rows = statement
        .query_map(params![session_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, Option<i64>>(1)?,
                row.get::<_, Option<String>>(2)?,
                row.get::<_, Option<i64>>(3)?,
            ))
        })
        .map_err(|error| OperatorError::Sqlite(error.to_string()))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| OperatorError::Sqlite(error.to_string()))?;
    drop(statement);

    let mut reclaimed = 0usize;
    for (id, pid, boot_id, start_time) in rows {
        // A checkpoint with no recorded owner predates the lease. It cannot
        // be proven live, and it cannot be proven dead either. Treat it as
        // abandoned: the alternative is the permanent wedge this function
        // exists to remove.
        let owner_alive = match (pid, boot_id, start_time) {
            (Some(pid), Some(boot_id), Some(start_time)) => {
                crate::chat_lease::identity_is_alive(&crate::chat_lease::ProcessIdentity {
                    pid: pid as i32,
                    boot_id,
                    start_time: start_time as u64,
                })
            }
            _ => false,
        };
        if owner_alive {
            continue;
        }
        let updated = conn.execute(
            "UPDATE operator_turn_checkpoints SET status='abandoned', updated_at=? WHERE id=? AND status='running'",
            params![utc_now(), id],
        ).map_err(|error| OperatorError::Sqlite(error.to_string()))?;
        reclaimed += updated;
    }
    Ok(reclaimed)
}

/// One turn that may have left work behind.
#[derive(Debug, Clone)]
pub struct RecoveryTurnSummary {
    pub id: String,
    pub status: String,
    pub updated_at: String,
    pub operations: Vec<RecoveryOperationSummary>,
}

/// One tool operation inside a recovery turn.
#[derive(Debug, Clone)]
pub struct RecoveryOperationSummary {
    pub tool_name: String,
    pub status: String,
}

/// The turns in a session that hold an operation with no settled outcome.
///
/// This is the ONE definition of "unfinished work". The recovery guard
/// reads it, the console's `/recovery` command reads it, and the
/// acknowledgement path reads it. Three readers, one query.
///
/// A turn that failed without dispatching a tool is not unfinished work:
/// there is nothing that could have been half-applied. A turn whose
/// operation has a settled outcome is not unfinished work either. Only a
/// dispatched-and-unanswered operation qualifies.
pub fn list_recovery_turns(
    conn: &Connection,
    session_id: &str,
) -> Result<Vec<RecoveryTurnSummary>, OperatorError> {
    let mut statement = conn.prepare(
        "SELECT cp.id, cp.status, cp.updated_at FROM operator_turn_checkpoints cp \
         WHERE cp.session_id=? \
           AND cp.status IN ('running','interrupted','blocked','abandoned') \
           AND EXISTS (SELECT 1 FROM operator_tool_operations op \
                        WHERE op.turn_id=cp.id AND op.status IN ('started','unknown') AND op.reviewed_at IS NULL) \
         ORDER BY cp.updated_at DESC LIMIT 20",
    ).map_err(|error| OperatorError::Sqlite(error.to_string()))?;
    let turns = statement
        .query_map(params![session_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })
        .map_err(|error| OperatorError::Sqlite(error.to_string()))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| OperatorError::Sqlite(error.to_string()))?;
    drop(statement);

    let mut summaries = Vec::with_capacity(turns.len());
    for (id, status, updated_at) in turns {
        let mut operations_statement = conn.prepare(
            "SELECT tool_name, status FROM operator_tool_operations \
             WHERE session_id=? AND turn_id=? AND status IN ('started','unknown') AND reviewed_at IS NULL \
             ORDER BY created_at ASC LIMIT 20",
        ).map_err(|error| OperatorError::Sqlite(error.to_string()))?;
        let operations = operations_statement
            .query_map(params![session_id, id], |row| {
                Ok(RecoveryOperationSummary {
                    tool_name: row.get(0)?,
                    status: row.get(1)?,
                })
            })
            .map_err(|error| OperatorError::Sqlite(error.to_string()))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| OperatorError::Sqlite(error.to_string()))?;
        summaries.push(RecoveryTurnSummary {
            id,
            status,
            updated_at,
            operations,
        });
    }
    Ok(summaries)
}

/// Summarise earlier turns that may have left work behind.
///
/// ## What this used to say, and why it was wrong
///
/// The original query was:
///
/// ```sql
/// SELECT id, status FROM operator_turn_checkpoints
///  WHERE session_id=? AND id<>? AND status IN ('running','interrupted')
/// ```
///
/// That treats *the existence of a failed turn* as evidence that a side
/// effect may be outstanding. It is not evidence of anything. A turn that
/// failed because the provider timed out, because the prompt exceeded the
/// context window, or because the model asked for a tool that does not
/// exist, dispatched **no** tool at all — there is nothing that could have
/// been half-applied.
///
/// The consequence was that one ordinary failure permanently disabled every
/// side-effecting tool in the session. Measured on the operator's host:
/// 25 of the 46 wedged checkpoints had **zero** operations. They blocked
/// the agent because they had failed, not because anything had been
/// written.
///
/// ## What it says now
///
/// The unfinished turns are the ones [`list_recovery_turns`] finds, and
/// that is the same list the console shows the operator. One definition,
/// three readers.
pub(crate) fn incomplete_turn_summary(
    conn: &Connection,
    session_id: &str,
    current_turn_id: &str,
) -> Result<String, OperatorError> {
    let summaries = list_recovery_turns(conn, session_id)?;
    let relevant: Vec<&RecoveryTurnSummary> = summaries
        .iter()
        .filter(|summary| summary.id != current_turn_id)
        .collect();
    if relevant.is_empty() {
        return Ok(String::new());
    }
    let mut entries = Vec::new();
    for summary in relevant {
        entries.push(format!(
            "- {} [{}] at {}",
            summary.id, summary.status, summary.updated_at
        ));
        for operation in &summary.operations {
            let safe_name: String = operation
                .tool_name
                .chars()
                .filter(|ch| ch.is_ascii_alphanumeric() || *ch == '_')
                .take(80)
                .collect();
            entries.push(format!("  - {safe_name} [{}]", operation.status));
        }
    }
    let entries = entries.join("\n");
    Ok(format!("Earlier turns have staged, incomplete progress (running may mean active or interrupted). Inspect their operations before repeating side effects.\n{entries}"))
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

pub(crate) fn persist_chat_messages_and_complete(
    conn: &Connection,
    session_id: &str,
    messages: &[MessageToPersist],
    checkpoint_id: Option<&str>,
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

    if let Some(id) = checkpoint_id {
        tx.execute("UPDATE operator_turn_checkpoints SET status='completed', pending_json='[]', partial_text='', partial_truncated=0, updated_at=? WHERE id=? AND session_id=?",
            params![Utc::now().to_rfc3339(), id, session_id])
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

#[cfg(test)]
mod checkpoint_tests {
    use super::*;
    use crate::chat_operations::{ensure_operation_tables, record_operation_started};

    fn in_memory() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        ensure_chat_tables(&conn).unwrap();
        ensure_operation_tables(&conn).unwrap();
        conn
    }

    #[test]
    fn guard_marks_early_failure_interrupted() {
        let conn = in_memory();
        save_turn_checkpoint(&conn, "first", "session", "running", &[]).unwrap();
        {
            let _guard = RunningCheckpointGuard::new(&conn, "first");
            assert!(incomplete_turn_summary(&conn, "session", "first")
                .unwrap()
                .is_empty());
            assert!(save_turn_checkpoint(&conn, "second", "session", "running", &[]).is_err());
        }
        save_turn_checkpoint(&conn, "second", "session", "running", &[]).unwrap();
        save_turn_checkpoint(&conn, "second", "session", "completed", &[]).unwrap();
        {
            let _guard = RunningCheckpointGuard::new(&conn, "second");
        }
        let status: String = conn
            .query_row(
                "SELECT status FROM operator_turn_checkpoints WHERE id='second'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(status, "completed");
    }

    /// The wedge fix.
    ///
    /// A turn that failed before dispatching any tool has no side effect
    /// that could be outstanding. It must therefore NOT appear in the
    /// incomplete-turn summary, and it must NOT arm the recovery guard.
    ///
    /// Before the fix this was the other way round: the mere existence of
    /// an interrupted turn disabled every side-effecting tool in the
    /// session. Measured on the operator's host, 25 of the 46 wedged
    /// checkpoints had zero operations — they blocked the agent because
    /// they had failed, not because anything had been written.
    #[test]
    fn a_failed_turn_without_operations_does_not_arm_the_guard() {
        let conn = in_memory();
        save_turn_checkpoint(&conn, "first", "session", "running", &[]).unwrap();
        {
            let _guard = RunningCheckpointGuard::new(&conn, "first");
        }
        let status: String = conn
            .query_row(
                "SELECT status FROM operator_turn_checkpoints WHERE id='first'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(status, "interrupted");

        let summary = incomplete_turn_summary(&conn, "session", "current").unwrap();
        assert!(
            summary.is_empty(),
            "a turn with no operations must not be listed as incomplete: {summary}"
        );
    }

    /// The other half of the wedge fix: a turn that DID dispatch a tool
    /// and never got an answer for it is genuine unfinished business, and
    /// it must still be reported.
    #[test]
    fn a_failed_turn_with_an_unsettled_operation_is_reported() {
        let conn = in_memory();
        save_turn_checkpoint(&conn, "first", "session", "running", &[]).unwrap();
        {
            let _guard = RunningCheckpointGuard::new(&conn, "first");
        }
        record_operation_started(&conn, "session", "call-1", "memphis_journal", "{}").unwrap();
        conn.execute(
            "UPDATE operator_tool_operations SET turn_id='first' WHERE session_id='session'",
            [],
        )
        .unwrap();

        let summary = incomplete_turn_summary(&conn, "session", "current").unwrap();
        assert!(
            summary.contains("first [interrupted]"),
            "a turn with an unsettled operation must be listed: {summary}"
        );
    }

    /// The lease fix: a `running` checkpoint left behind by a process that
    /// no longer exists must be reclaimed automatically. Otherwise one
    /// `kill -9` refuses every later turn in the session forever — and the
    /// operator's remedy, killing the process, creates the next one.
    #[test]
    fn a_running_checkpoint_whose_owner_is_gone_is_reclaimed() {
        let conn = in_memory();
        // PID 4194304 is above the default pid_max, so it cannot exist.
        conn.execute(
            "INSERT INTO operator_turn_checkpoints (id, session_id, status, pending_json, updated_at, owner_pid, owner_boot_id, owner_start_time) \
             VALUES ('stale', 'session', 'running', '[]', '2026-01-01T00:00:00Z', 4194304, 'boot', 1)",
            [],
        )
        .unwrap();

        let reclaimed = reclaim_abandoned_turns(&conn, "session").unwrap();
        assert_eq!(reclaimed, 1);
        let status: String = conn
            .query_row(
                "SELECT status FROM operator_turn_checkpoints WHERE id='stale'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(status, "abandoned");
    }

    /// The counterpart: a turn that belongs to a live process must not be
    /// reclaimed, or two turns would run at once.
    #[test]
    fn a_running_checkpoint_owned_by_a_live_process_is_kept() {
        let conn = in_memory();
        save_turn_checkpoint(&conn, "live", "session", "running", &[]).unwrap();

        let reclaimed = reclaim_abandoned_turns(&conn, "session").unwrap();
        assert_eq!(reclaimed, 0);
        let status: String = conn
            .query_row(
                "SELECT status FROM operator_turn_checkpoints WHERE id='live'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(status, "running");
    }

    /// A checkpoint written before the lease existed carries no owner. It
    /// cannot be proven live, and leaving it would reproduce the wedge, so
    /// it is reclaimed.
    #[test]
    fn a_running_checkpoint_without_an_owner_is_reclaimed() {
        let conn = in_memory();
        conn.execute(
            "INSERT INTO operator_turn_checkpoints (id, session_id, status, pending_json, updated_at) \
             VALUES ('legacy', 'session', 'running', '[]', '2026-01-01T00:00:00Z')",
            [],
        )
        .unwrap();

        let reclaimed = reclaim_abandoned_turns(&conn, "session").unwrap();
        assert_eq!(reclaimed, 1);
    }
}
