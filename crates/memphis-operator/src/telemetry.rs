//! Local JSONL span sink for the native (Rust) operator surface.
//!
//! The TypeScript gateway writes the same file format — see
//! `src/infra/observability/console-exporter.ts`:
//! `<dataDir>/telemetry/spans-YYYY-MM-DD.jsonl`, one JSON object per line,
//! keys `ts`, `name`, `attrs`, `durationMs`, `status`.
//!
//! WHY THIS EXISTS
//! ---------------
//! Measured on this host (2026-10-29): `tool.call` spans stopped on
//! 2026-10-26 — the day the operator moved from the Telegram gateway to
//! the Rust TUI. The Rust TUI is the authoritative surface and it
//! executes native tools itself, so every native tool call was invisible
//! to the SLO evaluator. The `tool_error_rate` SLO kept reporting the
//! rate measured by the TypeScript gateway three days earlier, and the
//! report had no way to say "there is no current tool telemetry".
//!
//! Failure handling is fire-and-forget: telemetry must never break the
//! tool path. The first write failure disables the sink for the rest of
//! the process and reports once on stderr.

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};

use chrono::{DateTime, SecondsFormat, Utc};
use serde_json::{Map, Value};

use crate::OperatorConfig;

static WRITE_FAILED_ONCE: AtomicBool = AtomicBool::new(false);

/// Directory holding the span files — the same one the TypeScript sink
/// writes to, resolved from the same data dir.
pub(crate) fn spans_dir(config: &OperatorConfig) -> PathBuf {
    config.data_dir.join("telemetry")
}

/// Path of the span file for a given instant (UTC day, like the TS sink).
pub(crate) fn spans_file_path(config: &OperatorConfig, now: DateTime<Utc>) -> PathBuf {
    spans_dir(config).join(format!("spans-{}.jsonl", now.format("%Y-%m-%d")))
}

/// `MEMPHIS_TELEMETRY_LOCAL_SINK=false` turns the local sink off, exactly
/// as it does for the TypeScript side.
fn sink_enabled(config: &OperatorConfig) -> bool {
    match config.env("MEMPHIS_TELEMETRY_LOCAL_SINK") {
        None => true,
        Some(flag) => !matches!(
            flag.trim().to_ascii_lowercase().as_str(),
            "0" | "false" | "no" | "off"
        ),
    }
}

/// Append one span record. Never returns an error: a telemetry problem
/// must not surface as a tool failure.
pub(crate) fn record_span(
    config: &OperatorConfig,
    name: &str,
    attrs: Vec<(&str, Value)>,
    duration_ms: u64,
    status: &str,
    error_message: Option<&str>,
) {
    if !sink_enabled(config) {
        return;
    }
    if WRITE_FAILED_ONCE.load(Ordering::Relaxed) {
        return;
    }
    let now = Utc::now();
    let mut attr_map = Map::new();
    for (key, value) in attrs {
        attr_map.insert(key.to_string(), value);
    }
    let mut record = Map::new();
    record.insert(
        "ts".to_string(),
        Value::String(now.to_rfc3339_opts(SecondsFormat::Millis, true)),
    );
    record.insert("name".to_string(), Value::String(name.to_string()));
    record.insert("attrs".to_string(), Value::Object(attr_map));
    record.insert("durationMs".to_string(), Value::from(duration_ms));
    record.insert("status".to_string(), Value::String(status.to_string()));
    if let Some(message) = error_message {
        record.insert(
            "errorMessage".to_string(),
            Value::String(message.to_string()),
        );
    }
    let line = format!("{}\n", Value::Object(record));
    if let Err(error) = append_line(&spans_file_path(config, now), &line) {
        WRITE_FAILED_ONCE.store(true, Ordering::Relaxed);
        eprintln!("[memphis-telemetry] native span sink disabled after first failure: {error}");
    }
}

/// Record a native tool call in the same shape the TypeScript agent loop
/// emits, so one evaluator can read both surfaces.
pub(crate) fn record_tool_call(
    config: &OperatorConfig,
    tool_name: &str,
    tool_id: &str,
    duration_ms: u64,
    failed: bool,
    error_message: Option<&str>,
) {
    let status = if failed { "error" } else { "ok" };
    let shape = if failed { "error" } else { "success" };
    record_span(
        config,
        "tool.call",
        vec![
            ("tool.name", Value::String(tool_name.to_string())),
            ("tool.id", Value::String(tool_id.to_string())),
            ("tool.output.shape", Value::String(shape.to_string())),
            ("surface", Value::String("rust-tui".to_string())),
            ("audit.surface", Value::String("rust-tui".to_string())),
        ],
        duration_ms,
        status,
        error_message,
    );
}

fn append_line(path: &PathBuf, line: &str) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|error| error.to_string())?;
    file.write_all(line.as_bytes())
        .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::OperatorConfig;
    use std::collections::HashMap;
    use std::fs::read_to_string;

    fn config_with_data_dir(data_dir: &str) -> OperatorConfig {
        let mut vars: HashMap<String, String> = HashMap::new();
        vars.insert("HOME".to_string(), "/tmp/home".to_string());
        vars.insert("MEMPHIS_DATA_DIR".to_string(), data_dir.to_string());
        OperatorConfig::from_iter(vars)
    }

    #[test]
    fn writes_a_span_line_the_typescript_evaluator_can_read() {
        let dir =
            std::env::temp_dir().join(format!("memphis-native-telemetry-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let config = config_with_data_dir(dir.to_str().unwrap());

        record_tool_call(&config, "memphis_journal", "call-1", 42, false, None);

        let path = spans_file_path(&config, Utc::now());
        assert!(path.exists(), "span file must exist at {}", path.display());
        let content = read_to_string(&path).unwrap();
        let line = content.trim();
        let parsed: Value = serde_json::from_str(line).expect("span line must be JSON");
        assert_eq!(parsed["name"], "tool.call");
        assert_eq!(parsed["status"], "ok");
        assert_eq!(parsed["durationMs"], 42);
        assert_eq!(parsed["attrs"]["tool.name"], "memphis_journal");
        assert_eq!(parsed["attrs"]["tool.id"], "call-1");
        assert_eq!(parsed["attrs"]["tool.output.shape"], "success");
        assert_eq!(parsed["attrs"]["surface"], "rust-tui");
        assert!(
            parsed["ts"].as_str().unwrap().ends_with('Z'),
            "timestamp must be UTC"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn failed_tool_calls_are_recorded_as_errors() {
        let dir = std::env::temp_dir().join(format!(
            "memphis-native-telemetry-err-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        let config = config_with_data_dir(dir.to_str().unwrap());

        record_tool_call(
            &config,
            "memphis_code_read",
            "call-2",
            7,
            true,
            Some("boom"),
        );

        let content = read_to_string(spans_file_path(&config, Utc::now())).unwrap();
        let parsed: Value = serde_json::from_str(content.trim()).unwrap();
        assert_eq!(parsed["status"], "error");
        assert_eq!(parsed["attrs"]["tool.output.shape"], "error");
        assert_eq!(parsed["errorMessage"], "boom");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_local_sink_can_be_disabled() {
        let dir = std::env::temp_dir().join(format!(
            "memphis-native-telemetry-off-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        let mut vars: HashMap<String, String> = HashMap::new();
        vars.insert("HOME".to_string(), "/tmp/home".to_string());
        vars.insert(
            "MEMPHIS_DATA_DIR".to_string(),
            dir.to_str().unwrap().to_string(),
        );
        vars.insert(
            "MEMPHIS_TELEMETRY_LOCAL_SINK".to_string(),
            "false".to_string(),
        );
        let config = OperatorConfig::from_iter(vars);

        record_tool_call(&config, "memphis_journal", "call-3", 5, false, None);

        assert!(
            !spans_file_path(&config, Utc::now()).exists(),
            "disabled sink must not create span files"
        );
        let _ = fs::remove_dir_all(&dir);
    }
}
