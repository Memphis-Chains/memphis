//! Durable record of errors the TUI renders but does not otherwise keep.
//!
//! The TUI writes its stdout/stderr straight to the controlling terminal
//! (`/dev/pts/N`), so anything it prints leaves no trace once the screen
//! scrolls or the pane is closed. That made one class of failure
//! effectively undiagnosable from outside the process: on 2026-10-01 the
//! operator saw
//!
//! ```text
//! Native chat
//! Status: provider did not answer in time
//! ```
//!
//! while `journalctl -u memphis.service` and `~/.memphis/logs/memphis.log`
//! showed nothing at all — the error was produced and classified inside
//! the TUI process, and the classified form is what got rendered. The
//! raw text that `classify_runtime_error` matched on was never recorded,
//! so there was no way to tell a provider timeout from a dead socket from
//! a DNS failure without reproducing the turn by hand.
//!
//! This module appends the *raw* error text, one JSON object per line,
//! to `~/.memphis/logs/tui-errors.jsonl`. It is deliberately separate
//! from `memphis.log`: that file belongs to the Node runtime, its format
//! is pino's, and nothing in this crate should be writing to it.
//!
//! Failure to log is never itself an error. A read-only home directory,
//! a full disk, or a missing parent directory all degrade to "nothing
//! was recorded" — losing a diagnostic line must not take down a turn
//! that otherwise succeeded.

use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    sync::Mutex,
};

use serde_json::json;

/// Log file name, under `<data-dir>/logs/`.
const LOG_FILE_NAME: &str = "tui-errors.jsonl";

/// Cap on a single record's error text.
///
/// Provider errors can embed an entire response body — an HTML error
/// page from a proxy is not unusual. The classification only ever looks at
/// a short prefix, so storing megabytes of it would bloat the log
/// without adding diagnostic value.
const MAX_ERROR_CHARS: usize = 4096;

/// Serializes appends made from this process.
///
/// The file is opened with `O_APPEND`, so each `write` lands at the end of
/// the file — but `writeln!` on a `File` issues **one `write` syscall per
/// format fragment**, not one per line. Two writers therefore interleave
/// *inside* a record and produce a line that is not valid JSON.
///
/// That is not hypothetical: 80 of the 252 lines in this file on the
/// operator's host were unparseable, e.g.
///
/// ```text
/// {{""presentedpresented""::"fatal","raw":"unexpected renderer invariant violation"",…
/// ```
///
/// which is two records spliced together. The file that exists to
/// diagnose failures was destroying them.
///
/// Two defences, because there are two ways to lose the race:
///
/// - the mutex, for threads inside this process;
/// - the single `write_all` of a fully-built line, for other processes
///   appending to the same file.
static APPEND_LOCK: Mutex<()> = Mutex::new(());

/// Which TUI surface produced the error.
///
/// Kept as a free-form string rather than an enum because the call sites
/// grow with the TUI, and a new surface should be able to log before
/// someone remembers to widen this type.
fn resolve_log_path(explicit: Option<&Path>) -> Option<PathBuf> {
    if let Some(path) = explicit {
        return Some(path.to_path_buf());
    }
    // `MEMPHIS_DATA_DIR` when set, otherwise `$HOME/.memphis`. Mirrors
    // `memphis_paths::resolve_data_dir`, but spelled out here so this
    // crate does not have to take a dependency on the paths crate for
    // a single string.
    let base = match std::env::var("MEMPHIS_DATA_DIR") {
        Ok(v) if !v.trim().is_empty() => PathBuf::from(v),
        _ => {
            let home = std::env::var("HOME").ok()?;
            PathBuf::from(home).join(".memphis")
        }
    };
    Some(base.join("logs").join(LOG_FILE_NAME))
}

/// Appends one error record. Best-effort: any failure is swallowed.
///
/// `surface` identifies the TUI command that failed (`"native-chat"`,
/// `"telegram-send"`, …). `presented` carries the operator-facing
/// classification so a later reader can see both what actually happened
/// and what the operator was told — the two diverging is exactly the
/// signal worth having on disk.
pub fn record_error(surface: &str, raw_error: &str, presented: Option<&str>) {
    record_error_at(None, surface, raw_error, presented);
}

/// Same as [`record_error`] but with an explicit destination. Exists so
/// the tests can assert on real file contents without mutating the
/// operator's actual log.
fn record_error_at(
    explicit_path: Option<&Path>,
    surface: &str,
    raw_error: &str,
    presented: Option<&str>,
) {
    let Some(path) = resolve_log_path(explicit_path) else {
        return;
    };

    if let Some(parent) = path.parent() {
        if fs::create_dir_all(parent).is_err() {
            return;
        }
    }

    let truncated = raw_error.chars().count() > MAX_ERROR_CHARS;
    let body: String = if truncated {
        let head: String = raw_error.chars().take(MAX_ERROR_CHARS).collect();
        format!("{head}…[truncated at {MAX_ERROR_CHARS} chars]")
    } else {
        raw_error.to_string()
    };

    let record = json!({
        "ts": chrono::Utc::now().to_rfc3339(),
        "surface": surface,
        "raw": body,
        "truncated": truncated,
        "presented": presented,
    });

    // Build the whole line first, then write it with ONE syscall.
    //
    // `writeln!(file, "{record}")` would emit the line in several `write`
    // calls, and another writer could land between them. A single
    // `write_all` of a complete line is one atomic append.
    let mut line = match serde_json::to_string(&record) {
        Ok(encoded) => encoded,
        Err(_) => return,
    };
    line.push('\n');

    let _guard = APPEND_LOCK.lock();
    let Ok(mut file) = OpenOptions::new().create(true).append(true).open(&path) else {
        return;
    };
    let _ = file.write_all(line.as_bytes());
    let _ = file.flush();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn record_error_creates_the_file_and_the_parent_directory() {
        let dir = std::env::temp_dir().join(format!("memphis-tui-errlog-{}", std::process::id()));
        let path = dir.join("nested").join(LOG_FILE_NAME);
        let _ = fs::remove_dir_all(&dir);

        record_error_at(
            Some(&path),
            "native-chat",
            "connection refused",
            Some("provider did not answer in time"),
        );

        let contents = fs::read_to_string(&path).expect("log file should exist");
        let parsed: serde_json::Value =
            serde_json::from_str(contents.trim()).expect("valid JSON line");
        assert_eq!(parsed["surface"], "native-chat");
        assert_eq!(parsed["raw"], "connection refused");
        assert_eq!(parsed["presented"], "provider did not answer in time");
        assert_eq!(parsed["truncated"], false);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn record_error_appends_rather_than_overwrites() {
        let dir =
            std::env::temp_dir().join(format!("memphis-tui-errlog-append-{}", std::process::id()));
        let path = dir.join(LOG_FILE_NAME);
        let _ = fs::remove_dir_all(&dir);

        record_error_at(Some(&path), "native-chat", "first", None);
        record_error_at(Some(&path), "native-chat", "second", None);

        let contents = fs::read_to_string(&path).expect("log file should exist");
        assert_eq!(contents.lines().count(), 2, "both records should survive");
        assert!(contents.contains("first"));
        assert!(contents.contains("second"));

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn record_error_truncates_an_oversized_body_and_says_so() {
        let dir =
            std::env::temp_dir().join(format!("memphis-tui-errlog-trunc-{}", std::process::id()));
        let path = dir.join(LOG_FILE_NAME);
        let _ = fs::remove_dir_all(&dir);

        let huge = "x".repeat(MAX_ERROR_CHARS + 500);
        record_error_at(Some(&path), "native-chat", &huge, None);

        let contents = fs::read_to_string(&path).expect("log file should exist");
        let parsed: serde_json::Value =
            serde_json::from_str(contents.trim()).expect("valid JSON line");
        assert_eq!(parsed["truncated"], true);
        let raw = parsed["raw"].as_str().unwrap();
        assert!(raw.contains("truncated at"));
        assert!(
            raw.len() < huge.len(),
            "truncated body must be shorter than the input"
        );

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn record_error_survives_an_unwritable_path() {
        // A path whose parent is a regular file cannot be created. The
        // call must return rather than panic — a lost diagnostic must
        // never take down the turn it was diagnosing.
        let dir =
            std::env::temp_dir().join(format!("memphis-tui-errlog-bad-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let blocker = dir.join("blocker");
        fs::write(&blocker, b"not a directory").unwrap();
        let impossible = blocker.join("deeper").join(LOG_FILE_NAME);

        record_error_at(Some(&impossible), "native-chat", "boom", None);

        let _ = fs::remove_dir_all(&dir);
    }

    /// The corruption bug, as a test.
    ///
    /// Before the fix, `writeln!` emitted each line in several `write`
    /// syscalls and concurrent appends spliced records into each other:
    /// 80 of 252 lines in the operator's live log were unparseable. Every
    /// line must survive concurrent writers intact.
    #[test]
    fn concurrent_appends_produce_parseable_lines() {
        let dir = std::env::temp_dir().join(format!("memphis-tui-errlog-race-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join(LOG_FILE_NAME);

        const WRITERS: usize = 8;
        const PER_WRITER: usize = 25;

        let mut handles = Vec::new();
        for writer in 0..WRITERS {
            let path = path.clone();
            handles.push(std::thread::spawn(move || {
                for index in 0..PER_WRITER {
                    // A payload long enough to span several `write` calls,
                    // which is what made the old implementation corrupt.
                    let body = format!("writer-{writer} record-{index} {}", "x".repeat(512));
                    record_error_at(
                        Some(&path),
                        "native-chat",
                        &body,
                        Some("fatal"),
                    );
                }
            }));
        }
        for handle in handles {
            handle.join().expect("writer thread");
        }

        let contents = fs::read_to_string(&path).expect("log file should exist");
        let lines: Vec<&str> = contents.lines().collect();
        assert_eq!(
            lines.len(),
            WRITERS * PER_WRITER,
            "every append must survive as its own line"
        );
        for (index, line) in lines.iter().enumerate() {
            serde_json::from_str::<serde_json::Value>(line)
                .unwrap_or_else(|error| panic!("line {index} is not valid JSON: {error}\n{line}"));
        }

        let _ = fs::remove_dir_all(&dir);
    }
}
