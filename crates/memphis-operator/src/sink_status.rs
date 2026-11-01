//! Status file contract for the local span sinks (native arm).
//!
//! WHY THIS EXISTS
//! ---------------
//! A sink that is broken and a runtime that is idle look identical from
//! the outside — both produce no spans. This file is how the two are told
//! apart: a sink that failed says so, in a place the report reads.
//!
//! WHERE THE FILE LIVES
//! --------------------
//! In the DATA directory, not in `telemetry/`. The span file and the
//! status file fail for different reasons: a span write dies when the
//! telemetry directory is unwritable or the disk is full, and the status
//! file has to survive exactly that case.
//!
//! The TypeScript gateway and this arm write SEPARATE files
//! (`sink-status-ts.json`, `sink-status-rust.json`) because they are
//! separate processes writing into the same directory: one file would be
//! overwritten by the other and the operator would read whichever
//! process wrote last.
//!
//! The shape is a contract between two implementations in two languages.
//! `tests/fixtures/telemetry-sink-status-contract.json` holds the field
//! list; the TypeScript and Rust suites both check their writer against
//! it, so the arms cannot drift apart silently.

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// The surface name this arm writes its status file under.
pub const LOCAL_SINK_SURFACE: &str = "rust";

/// The state of a sink: `degraded` while writes fail, `ok` after recovery.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SinkState {
    Degraded,
    Ok,
}

/// One sink's status, as written to disk.
///
/// The field names are the contract with the TypeScript arm — they are
/// camelCase on both sides.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SinkStatusEntry {
    /// Which writer produced this file.
    pub surface: String,
    /// `degraded` while the sink cannot write, `ok` after it recovers.
    pub state: SinkState,
    /// How many consecutive write attempts failed. Reset to 0 on recovery.
    pub consecutive_failures: u32,
    /// The last write error, verbatim, or null when the sink is healthy.
    pub last_error: Option<String>,
    /// ISO timestamp of the last failed write, or null.
    pub last_failure_at: Option<String>,
    /// ISO timestamp of the last successful write, or null.
    pub last_success_at: Option<String>,
    /// ISO timestamp of the next write attempt, while degraded. Null when healthy.
    pub next_retry_at: Option<String>,
    /// ISO timestamp of the moment this file was written.
    pub updated_at: String,
}

/// The file name a given surface writes its status to.
pub fn sink_status_file_name(surface: &str) -> String {
    format!("sink-status-{surface}.json")
}

/// The path of a surface's status file inside a data directory.
///
/// The status file lives in the DATA directory, not in `telemetry/`:
/// a span write and a status write fail for different reasons, and the
/// status file has to survive the case where `telemetry/` is the thing
/// that is unwritable.
pub fn sink_status_path(dir: &Path, surface: &str) -> PathBuf {
    dir.join(sink_status_file_name(surface))
}

/// Write a sink status file.
///
/// The write goes to a temporary file and is then renamed, so a reader
/// never sees a half-written document. Best effort by design: the caller
/// is already handling a broken sink, and a status file that cannot be
/// written must not raise.
pub fn write_sink_status(dir: &Path, entry: &SinkStatusEntry) -> Result<(), String> {
    fs::create_dir_all(dir).map_err(|error| error.to_string())?;
    let target = dir.join(sink_status_file_name(&entry.surface));
    let tmp = target.with_extension(format!("json.tmp-{}", std::process::id()));
    let payload = format!(
        "{}\n",
        serde_json::to_string_pretty(entry).map_err(|e| e.to_string())?
    );
    fs::write(&tmp, payload.as_bytes()).map_err(|error| error.to_string())?;
    fs::rename(&tmp, &target).map_err(|error| {
        let _ = fs::remove_file(&tmp);
        error.to_string()
    })
}

/// Read every sink status file in a data directory.
///
/// A file that is unreadable or malformed is skipped rather than raising:
/// a broken status file must not break the report that reads it.
pub fn read_sink_status_entries(dir: &Path) -> Vec<SinkStatusEntry> {
    let names = match fs::read_dir(dir) {
        Ok(entries) => entries
            .filter_map(|entry| entry.ok())
            .map(|entry| entry.file_name().to_string_lossy().to_string())
            .collect::<Vec<String>>(),
        Err(_) => return Vec::new(),
    };
    let mut entries = Vec::new();
    for name in names {
        if !name.starts_with("sink-status-") || !name.ends_with(".json") {
            continue;
        }
        let path: PathBuf = dir.join(&name);
        let content = match fs::read_to_string(&path) {
            Ok(content) => content,
            Err(_) => continue,
        };
        match serde_json::from_str::<SinkStatusEntry>(&content) {
            Ok(entry) => entries.push(entry),
            Err(_) => continue,
        }
    }
    entries
}
