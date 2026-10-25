//! Durable operation journal for the native operator runtime.
//!
//! WHY THIS EXISTS
//! ---------------
//! Before this module, a native turn kept every message in an in-memory
//! `pending` vector and wrote the whole thing to the transcript only when
//! the model answered without further tool calls. A tool that had already
//! changed durable state — a journal write, a case append, a chain block —
//! left no trace if the provider failed afterwards or the operator
//! cancelled the turn. The effect survived; the record of it did not.
//!
//! The next turn then re-ran the same instruction, because nothing in the
//! session said the work was already done.
//!
//! What this module records
//! -------------------------
//! Each tool call is written to `operator_tool_operations` BEFORE the tool
//! runs, with status `started`, and updated to `completed` or `failed`
//! after. A row that is still `started` when the process dies means the
//! outcome is UNKNOWN — the tool may have applied its effect before the
//! process went down. That is reported honestly as `unknown`, never as
//! `failed` and never as `completed`.
//!
//! The point is not to make every operation transactional. It is to make
//! the answer to "did this already run?" survive a crash, so the operator
//! and the model are not both told a false story.

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};

use crate::OperatorError;

/// Lifecycle of a single tool operation.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) enum OperationStatus {
    /// The tool was dispatched; the outcome is not yet known.
    Started,
    /// The tool returned successfully.
    Completed,
    /// The tool returned an error and changed nothing.
    Failed,
    /// The process ended while the tool was in flight. The effect may or
    /// may not have been applied.
    Unknown,
}

impl OperationStatus {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            OperationStatus::Started => "started",
            OperationStatus::Completed => "completed",
            OperationStatus::Failed => "failed",
            OperationStatus::Unknown => "unknown",
        }
    }

    fn parse(raw: &str) -> OperationStatus {
        match raw {
            "completed" => OperationStatus::Completed,
            "failed" => OperationStatus::Failed,
            "unknown" => OperationStatus::Unknown,
            _ => OperationStatus::Started,
        }
    }
}

/// One durable record of a tool operation.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct ToolOperationRecord {
    pub(crate) id: String,
    pub(crate) session_id: String,
    pub(crate) tool_call_id: String,
    pub(crate) tool_name: String,
    pub(crate) status: OperationStatus,
    pub(crate) arguments_json: String,
    pub(crate) result_summary: Option<String>,
    pub(crate) created_at: String,
    pub(crate) updated_at: String,
}

/// Create the operation journal table if it does not exist yet.
pub(crate) fn ensure_operation_tables(conn: &Connection) -> Result<(), OperatorError> {
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS operator_tool_operations (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          tool_call_id TEXT NOT NULL,
          tool_name TEXT NOT NULL,
          status TEXT NOT NULL,
          arguments_json TEXT NOT NULL,
          result_summary TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_operator_tool_operations_session
          ON operator_tool_operations(session_id, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_operator_tool_operations_call
          ON operator_tool_operations(tool_call_id);
    "#,
    )
    .map_err(|error| OperatorError::Sqlite(error.to_string()))
}

/// Record that a tool is about to run. Written before dispatch so a crash
/// during the tool leaves a `started` row rather than no row at all.
pub(crate) fn record_operation_started(
    conn: &Connection,
    session_id: &str,
    tool_call_id: &str,
    tool_name: &str,
    arguments_json: &str,
) -> Result<String, OperatorError> {
    let id = format!("{session_id}:{tool_call_id}");
    let now = crate::chat_session::utc_now();
    conn.execute(
        r#"
        INSERT INTO operator_tool_operations (
          id, session_id, tool_call_id, tool_name, status, arguments_json, result_summary, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          status = excluded.status,
          arguments_json = excluded.arguments_json,
          result_summary = NULL,
          updated_at = excluded.updated_at
        "#,
        params![
            id,
            session_id,
            tool_call_id,
            tool_name,
            OperationStatus::Started.as_str(),
            arguments_json,
            now,
            now,
        ],
    )
    .map_err(|error| OperatorError::Sqlite(error.to_string()))?;
    Ok(id)
}

/// Record the outcome of a tool that ran to completion.
pub(crate) fn record_operation_completed(
    conn: &Connection,
    id: &str,
    result_summary: &str,
) -> Result<(), OperatorError> {
    update_operation(conn, id, OperationStatus::Completed, Some(result_summary))
}

/// Record a tool that failed without changing anything.
pub(crate) fn record_operation_failed(
    conn: &Connection,
    id: &str,
    error_summary: &str,
) -> Result<(), OperatorError> {
    update_operation(conn, id, OperationStatus::Failed, Some(error_summary))
}

/// Mark an in-flight operation as unknown. Used when the turn ends without
/// a definite answer — provider error, cancellation, loop limit. The
/// effect may or may not have been applied; the record says so rather than
/// guessing.
pub(crate) fn record_operation_unknown(
    conn: &Connection,
    id: &str,
    reason: &str,
) -> Result<(), OperatorError> {
    update_operation(conn, id, OperationStatus::Unknown, Some(reason))
}

fn update_operation(
    conn: &Connection,
    id: &str,
    status: OperationStatus,
    summary: Option<&str>,
) -> Result<(), OperatorError> {
    let now = crate::chat_session::utc_now();
    conn.execute(
        "UPDATE operator_tool_operations SET status = ?, result_summary = ?, updated_at = ? WHERE id = ?",
        params![status.as_str(), summary, now, id],
    )
    .map_err(|error| OperatorError::Sqlite(error.to_string()))?;
    Ok(())
}

/// Operations of one session, newest first.
pub(crate) fn load_session_operations(
    conn: &Connection,
    session_id: &str,
    limit: usize,
) -> Result<Vec<ToolOperationRecord>, OperatorError> {
    let mut stmt = conn
        .prepare(
            r#"
            SELECT id, session_id, tool_call_id, tool_name, status, arguments_json, result_summary, created_at, updated_at
            FROM operator_tool_operations
            WHERE session_id = ?
            ORDER BY created_at DESC, id DESC
            LIMIT ?
            "#,
        )
        .map_err(|error| OperatorError::Sqlite(error.to_string()))?;
    let rows = stmt
        .query_map(params![session_id, limit as i64], |row| {
            Ok(ToolOperationRecord {
                id: row.get(0)?,
                session_id: row.get(1)?,
                tool_call_id: row.get(2)?,
                tool_name: row.get(3)?,
                status: OperationStatus::parse(&row.get::<_, String>(4)?),
                arguments_json: row.get(5)?,
                result_summary: row.get(6)?,
                created_at: row.get(7)?,
                updated_at: row.get(8)?,
            })
        })
        .map_err(|error| OperatorError::Sqlite(error.to_string()))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| OperatorError::Sqlite(error.to_string()))?;
    Ok(rows)
}

/// Operations of one session whose outcome is not settled — started or
/// explicitly unknown. These are the ones an operator must look at before
/// repeating the instruction.
pub(crate) fn load_unsettled_operations(
    conn: &Connection,
    session_id: &str,
) -> Result<Vec<ToolOperationRecord>, OperatorError> {
    let mut stmt = conn
        .prepare(
            r#"
            SELECT id, session_id, tool_call_id, tool_name, status, arguments_json, result_summary, created_at, updated_at
            FROM operator_tool_operations
            WHERE session_id = ? AND status IN ('started', 'unknown')
            ORDER BY created_at ASC, id ASC
            "#,
        )
        .map_err(|error| OperatorError::Sqlite(error.to_string()))?;
    let rows = stmt
        .query_map(params![session_id], |row| {
            Ok(ToolOperationRecord {
                id: row.get(0)?,
                session_id: row.get(1)?,
                tool_call_id: row.get(2)?,
                tool_name: row.get(3)?,
                status: OperationStatus::parse(&row.get::<_, String>(4)?),
                arguments_json: row.get(5)?,
                result_summary: row.get(6)?,
                created_at: row.get(7)?,
                updated_at: row.get(8)?,
            })
        })
        .map_err(|error| OperatorError::Sqlite(error.to_string()))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| OperatorError::Sqlite(error.to_string()))?;
    Ok(rows)
}

/// A short, human-readable description of unsettled work, for injection
/// into the next turn's context. Empty when nothing is outstanding.
pub(crate) fn unsettled_operations_summary(
    conn: &Connection,
    session_id: &str,
) -> Result<String, OperatorError> {
    let records = load_unsettled_operations(conn, session_id)?;
    if records.is_empty() {
        return Ok(String::new());
    }
    let lines = records
        .iter()
        .map(|record| {
            let status = record.status.as_str();
            match record.result_summary.as_deref() {
                Some(summary) if !summary.is_empty() => {
                    format!("- {} [{}]: {}", record.tool_name, status, summary)
                }
                _ => format!("- {} [{}]", record.tool_name, status),
            }
        })
        .collect::<Vec<_>>()
        .join("\n");
    Ok(format!(
        "The following tool operations from earlier in this session have no settled outcome. \
Check their state before repeating the instruction that triggered them.\n{lines}"
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chat_session::{ensure_chat_tables, open_sqlite_rw};
    use std::path::{Path, PathBuf};
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_root(name: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("unix time")
            .as_nanos();
        let root = std::env::temp_dir().join(format!("memphis-ops-{name}-{nanos}"));
        std::fs::create_dir_all(root.join("chains")).expect("create chain dir");
        root
    }

    fn conn_for(root: &Path) -> Connection {
        let conn = open_sqlite_rw(&root.join("memphis.db")).expect("open db");
        ensure_chat_tables(&conn).expect("chat tables");
        ensure_operation_tables(&conn).expect("operation tables");
        conn
    }

    #[test]
    fn started_operation_is_visible_before_the_tool_runs() {
        let root = temp_root("started");
        let conn = conn_for(&root);

        let id = record_operation_started(
            &conn,
            "s1",
            "call-1",
            "memphis_journal",
            r#"{"content":"x"}"#,
        )
        .expect("record started");

        let unsettled = load_unsettled_operations(&conn, "s1").expect("load unsettled");
        assert_eq!(unsettled.len(), 1);
        assert_eq!(unsettled[0].id, id);
        assert_eq!(unsettled[0].status, OperationStatus::Started);
        assert_eq!(unsettled[0].tool_name, "memphis_journal");
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn completed_operation_is_not_reported_as_unsettled() {
        let root = temp_root("completed");
        let conn = conn_for(&root);

        let id = record_operation_started(&conn, "s1", "call-1", "memphis_journal", "{}")
            .expect("record started");
        record_operation_completed(&conn, &id, "journal memoryId=1").expect("record completed");

        assert!(load_unsettled_operations(&conn, "s1")
            .expect("load unsettled")
            .is_empty());
        let all = load_session_operations(&conn, "s1", 10).expect("load all");
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].status, OperationStatus::Completed);
        assert_eq!(all[0].result_summary.as_deref(), Some("journal memoryId=1"));
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn failed_operation_keeps_the_error_and_is_settled() {
        let root = temp_root("failed");
        let conn = conn_for(&root);

        let id = record_operation_started(&conn, "s1", "call-1", "memphis_exec", "{}")
            .expect("record started");
        record_operation_failed(&conn, &id, "exit status 1").expect("record failed");

        assert!(load_unsettled_operations(&conn, "s1")
            .expect("load unsettled")
            .is_empty());
        let all = load_session_operations(&conn, "s1", 10).expect("load all");
        assert_eq!(all[0].status, OperationStatus::Failed);
        assert_eq!(all[0].result_summary.as_deref(), Some("exit status 1"));
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn unknown_operation_survives_a_reopen_and_is_still_reported() {
        let root = temp_root("unknown");
        {
            let conn = conn_for(&root);
            let id = record_operation_started(&conn, "s1", "call-1", "memphis_journal", "{}")
                .expect("record started");
            record_operation_unknown(
                &conn,
                &id,
                "turn ended before the operation reported an outcome",
            )
            .expect("record unknown");
        }

        // A fresh connection, as after a process restart.
        let conn = conn_for(&root);
        let unsettled = load_unsettled_operations(&conn, "s1").expect("load unsettled");
        assert_eq!(unsettled.len(), 1);
        assert_eq!(unsettled[0].status, OperationStatus::Unknown);
        let summary = unsettled_operations_summary(&conn, "s1").expect("summary");
        assert!(summary.contains("memphis_journal"), "summary: {summary}");
        assert!(summary.contains("unknown"), "summary: {summary}");
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn a_started_row_left_by_a_crash_is_reported_as_unsettled() {
        let root = temp_root("crash");
        {
            // The process "dies" here: the row was written, the tool never
            // reported an outcome.
            let conn = conn_for(&root);
            record_operation_started(&conn, "s1", "call-1", "memphis_journal", "{}")
                .expect("record started");
        }

        let conn = conn_for(&root);
        let unsettled = load_unsettled_operations(&conn, "s1").expect("load unsettled");
        assert_eq!(unsettled.len(), 1);
        assert_eq!(unsettled[0].status, OperationStatus::Started);
        // The summary must not claim the work did NOT happen — it says the
        // outcome is not settled.
        let summary = unsettled_operations_summary(&conn, "s1").expect("summary");
        assert!(summary.contains("memphis_journal"), "summary: {summary}");
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn summary_is_empty_when_nothing_is_outstanding() {
        let root = temp_root("clean");
        let conn = conn_for(&root);
        let id = record_operation_started(&conn, "s1", "call-1", "memphis_journal", "{}")
            .expect("record started");
        record_operation_completed(&conn, &id, "ok").expect("record completed");

        assert!(unsettled_operations_summary(&conn, "s1")
            .expect("summary")
            .is_empty());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn operations_are_scoped_to_their_session() {
        let root = temp_root("scoped");
        let conn = conn_for(&root);
        record_operation_started(&conn, "s1", "call-1", "memphis_journal", "{}")
            .expect("record started");

        assert!(load_unsettled_operations(&conn, "other")
            .expect("load unsettled")
            .is_empty());
        assert_eq!(
            load_unsettled_operations(&conn, "s1")
                .expect("load unsettled")
                .len(),
            1
        );
        let _ = std::fs::remove_dir_all(root);
    }
}
