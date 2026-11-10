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
//! FAILURE HANDLING
//! ----------------
//! A failed write does NOT disable the sink. The first version set
//! `WRITE_FAILED_ONCE` and stopped emitting for the rest of the process
//! lifetime after a single error — silently, apart from one line on
//! stderr. A broken sink then looked exactly like an idle runtime: both
//! produce no spans.
//!
//! The sink now mirrors the TypeScript arm:
//!   - it retries with the same exponential backoff schedule
//!     (`sink_retry::sink_retry_delay_ms`, checked against
//!     `tests/fixtures/telemetry-sink-status-contract.json`);
//!   - it records its own state in `<dataDir>/sink-status-rust.json`,
//!     so the report can say "the sink is degraded" instead of "there is
//!     no telemetry";
//!   - it writes to a status file one level ABOVE the telemetry
//!     directory, because a span write and a status write fail for
//!     different reasons and the status file has to survive the case
//!     where `telemetry/` is the thing that is unwritable.
//!
//! Telemetry must never break the tool path: every failure path here is
//! best-effort and swallows its own errors.

use std::collections::HashMap;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::sync::{LazyLock, Mutex};

use chrono::{DateTime, SecondsFormat, TimeZone, Utc};
use serde_json::{Map, Value};

use crate::sink_retry::sink_retry_delay_ms;
use crate::sink_status::{write_sink_status, SinkState, SinkStatusEntry, LOCAL_SINK_SURFACE};
use crate::OperatorConfig;

/// The retry state of one local sink.
#[derive(Debug, Clone, Default)]
struct SinkRetryState {
    consecutive_failures: u32,
    next_attempt_at_ms: Option<i64>,
    last_error: Option<String>,
    last_failure_at_ms: Option<i64>,
    last_success_at_ms: Option<i64>,
    /// Whether this outage was already reported, so the operator hears
    /// about it once, not once per retry.
    outage_reported: bool,
}

impl SinkRetryState {
    fn may_attempt(&self, now_ms: i64) -> bool {
        match self.next_attempt_at_ms {
            None => true,
            Some(next) => now_ms >= next,
        }
    }

    fn record_failure(&mut self, now_ms: i64, error: &str) {
        self.consecutive_failures = self.consecutive_failures.saturating_add(1);
        self.next_attempt_at_ms =
            Some(now_ms.saturating_add(sink_retry_delay_ms(self.consecutive_failures)));
        self.last_error = Some(error.to_string());
        self.last_failure_at_ms = Some(now_ms);
    }

    fn record_success(&mut self, now_ms: i64) {
        self.consecutive_failures = 0;
        self.next_attempt_at_ms = None;
        self.last_error = None;
        self.last_success_at_ms = Some(now_ms);
        self.outage_reported = false;
    }
}

/// The retry state of every local sink, keyed by its data directory.
///
/// The state belongs to the SINK, and a sink is identified by the data
/// directory it writes to. A single process-wide state would be wrong in
/// two ways: two runtimes with different data directories would share
/// one failure counter, and one runtime's failure would silence the
/// other's telemetry.
static SINK_RETRY_STATES: LazyLock<Mutex<HashMap<PathBuf, SinkRetryState>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

fn with_sink_state<R>(data_dir: &std::path::Path, f: impl FnOnce(&mut SinkRetryState) -> R) -> R {
    let mut states = SINK_RETRY_STATES
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let state = states.entry(data_dir.to_path_buf()).or_default();
    f(state)
}

/// Directory holding the span files — the same one the TypeScript sink
/// writes to, resolved from the same data dir.
pub(crate) fn spans_dir(config: &OperatorConfig) -> PathBuf {
    config.data_dir.join("telemetry")
}

/// Path of the span file for a given instant (UTC day, like the TS sink).
pub(crate) fn spans_file_path(config: &OperatorConfig, now: DateTime<Utc>) -> PathBuf {
    spans_dir(config).join(format!("spans-{}.jsonl", now.format("%Y-%m-%d")))
}

/// The sink's current status entry, for the surfaces that report it.
pub(crate) fn sink_status_entry(config: &OperatorConfig) -> SinkStatusEntry {
    let state = with_sink_state(&config.data_dir, |state| state.clone());
    SinkStatusEntry {
        surface: LOCAL_SINK_SURFACE.to_string(),
        state: if state.consecutive_failures > 0 {
            SinkState::Degraded
        } else {
            SinkState::Ok
        },
        consecutive_failures: state.consecutive_failures,
        last_error: state.last_error.clone(),
        last_failure_at: state.last_failure_at_ms.map(iso_from_ms),
        last_success_at: state.last_success_at_ms.map(iso_from_ms),
        next_retry_at: state.next_attempt_at_ms.map(iso_from_ms),
        updated_at: iso_from_ms(Utc::now().timestamp_millis()),
    }
}

fn iso_from_ms(ms: i64) -> String {
    Utc.timestamp_millis_opt(ms)
        .single()
        .map(|value| value.to_rfc3339_opts(SecondsFormat::Millis, true))
        .unwrap_or_else(|| String::from("1970-01-01T00:00:00.000Z"))
}

/// Write this arm's sink status file. Best effort: the caller is already
/// handling a broken sink, so a failure here must not raise.
fn publish_sink_status(config: &OperatorConfig) {
    let _ = write_sink_status(&config.data_dir, &sink_status_entry(config));
}

/// Test-only: clear the retry state of one data directory.
pub(crate) fn __reset_sink_state_for_tests(data_dir: &std::path::Path) {
    let mut states = SINK_RETRY_STATES
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    states.remove(data_dir);
}

/// Test-only: let the next write attempt through immediately.
///
/// The backoff window is real time, and a test must not sleep through it.
pub(crate) fn __expire_sink_backoff_for_tests(data_dir: &std::path::Path) {
    with_sink_state(data_dir, |state| {
        state.next_attempt_at_ms = None;
    });
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
    let now = Utc::now();
    let now_ms = now.timestamp_millis();
    if !with_sink_state(&config.data_dir, |state| state.may_attempt(now_ms)) {
        return;
    }
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
        let (was_healthy, failures) = with_sink_state(&config.data_dir, |state| {
            let was_healthy = state.consecutive_failures == 0;
            state.record_failure(now_ms, &error);
            (was_healthy, state.consecutive_failures)
        });
        publish_sink_status(config);
        eprintln!("[memphis-telemetry] native span sink write failed ({failures}x): {error}");
        if was_healthy {
            let already_reported = with_sink_state(&config.data_dir, |state| {
                let reported = state.outage_reported;
                state.outage_reported = true;
                reported
            });
            if !already_reported {
                eprintln!("[memphis-telemetry] native span sink degraded: {error}");
            }
        }
        return;
    }
    let recovered = with_sink_state(&config.data_dir, |state| {
        let recovered = state.consecutive_failures > 0;
        state.record_success(now_ms);
        state.outage_reported = false;
        recovered
    });
    if recovered {
        publish_sink_status(config);
        eprintln!("[memphis-telemetry] native span sink recovered");
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
    record_tool_call_for_turn(config, tool_name, tool_id, duration_ms, failed, error_message, None, None);
}

pub(crate) fn record_tool_call_for_turn(
    config: &OperatorConfig,
    tool_name: &str,
    tool_id: &str,
    duration_ms: u64,
    failed: bool,
    error_message: Option<&str>,
    turn_id: Option<&str>,
    output_shape: Option<&str>,
) {
    let status = if failed { "error" } else { "ok" };
    let shape = output_shape.unwrap_or(if failed { "error" } else { "success" });
    let mut attrs = vec![
        ("tool.name", Value::String(tool_name.to_string())),
        ("tool.id", Value::String(tool_id.to_string())),
        ("tool.output.shape", Value::String(shape.to_string())),
        ("surface", Value::String("rust-tui".to_string())),
        ("audit.surface", Value::String("rust-tui".to_string())),
    ];
    if let Some(id) = turn_id { attrs.push(("turn.id", Value::String(id.to_string()))); }
    record_span(
        config,
        "tool.call",
        attrs,
        duration_ms,
        status,
        error_message,
    );
}

/// Record the turn itself, in the same shape the TypeScript gateway
/// emits, so one evaluator can read both surfaces.
///
/// The SLO evaluator reads two of its signals from this span:
/// `p99_turn_duration_ms` takes its duration, and
/// `confabulation_rate` divides the number of `confabulation.event`
/// spans by the number of turns. Without it, the cockpit — the
/// authoritative surface — is invisible to both.
///
/// `p99_turn_latency_ms` no longer reads this span: measured
/// 2026-11-10, a whole turn covers every tool call the operator asked
/// for, so its p99 measured the length of the work rather than the
/// wait for the model. That metric reads `provider.completion` now.
///
/// Measured on this host (2026-11-01): the report said "no turn.dispatch
/// spans in window — last turn.dispatch span 3d ago" while the operator
/// was talking to the cockpit every day. The TypeScript gateway emits
/// the span; the native arm did not.
pub(crate) fn record_turn_dispatch(
    config: &OperatorConfig,
    session_id: &str,
    provider: &str,
    model: &str,
    duration_ms: u64,
    failed: bool,
    error_message: Option<&str>,
) {
    record_turn_dispatch_for_turn(config, session_id, provider, model, duration_ms, failed, error_message, None);
}

pub(crate) fn record_turn_dispatch_for_turn(
    config: &OperatorConfig,
    session_id: &str,
    provider: &str,
    model: &str,
    duration_ms: u64,
    failed: bool,
    error_message: Option<&str>,
    turn_id: Option<&str>,
) {
    let status = if failed { "error" } else { "ok" };
    let mut attrs = vec![
        ("surface", Value::String("rust-tui".to_string())),
        ("audit.surface", Value::String("rust-tui".to_string())),
        ("conversation.id", Value::String(session_id.to_string())),
        ("actor.id", Value::String("local".to_string())),
        ("provider", Value::String(provider.to_string())),
        ("model", Value::String(model.to_string())),
        ("turn.timing_ms", Value::from(duration_ms)),
    ];
    if let Some(id) = turn_id { attrs.push(("turn.id", Value::String(id.to_string()))); }
    record_span(
        config,
        "turn.dispatch",
        attrs,
        duration_ms,
        status,
        error_message,
    );
}

/// Record one provider completion, in the same shape the TypeScript
/// gateway emits.
///
/// `provider_error_rate` is the ratio of `provider.completion` spans
/// with status=error, so without this span the cockpit's provider
/// failures are invisible: the report would keep quoting the gateway's
/// last measurement, or say "no provider.completion spans in window".
pub(crate) fn record_provider_completion(
    config: &OperatorConfig,
    provider: &str,
    model: &str,
    tools_count: usize,
    messages_count: usize,
    duration_ms: u64,
    failed: bool,
    error_message: Option<&str>,
) {
    record_provider_completion_for_turn(config, provider, model, tools_count, messages_count, duration_ms, failed, error_message, None, None);
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn record_provider_completion_for_turn(
    config: &OperatorConfig,
    provider: &str,
    model: &str,
    tools_count: usize,
    messages_count: usize,
    duration_ms: u64,
    failed: bool,
    error_message: Option<&str>,
    turn_id: Option<&str>,
    stream: Option<&crate::provider::StreamReadStats>,
) {
    let status = if failed { "error" } else { "ok" };
    let mut attrs = vec![
        ("provider.name", Value::String(provider.to_string())),
        ("provider.model", Value::String(model.to_string())),
        ("provider.tools.count", Value::from(tools_count)),
        ("provider.messages.count", Value::from(messages_count)),
    ];
    if let Some(id) = turn_id { attrs.push(("turn.id", Value::String(id.to_string()))); }
    if let Some(stream) = stream {
        attrs.push(("stream.bytes", Value::from(stream.bytes)));
        attrs.push(("stream.max_interread_gap_ms", Value::from(stream.max_interread_gap_ms)));
        if let Some(value) = stream.first_byte_after_headers_ms { attrs.push(("stream.first_byte_after_headers_ms", Value::from(value))); }
        if let Some(value) = stream.last_byte_after_headers_ms { attrs.push(("stream.last_byte_after_headers_ms", Value::from(value))); }
        if let Some(value) = stream.idle_before_error_ms { attrs.push(("stream.idle_before_error_ms", Value::from(value))); }
    }
    record_span(
        config,
        "provider.completion",
        attrs,
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
    use crate::sink_status::read_sink_status_entries;
    use crate::OperatorConfig;
    use std::collections::HashMap;
    use std::fs::read_to_string;

    fn config_with_data_dir(data_dir: &str) -> OperatorConfig {
        let mut vars: HashMap<String, String> = HashMap::new();
        vars.insert("HOME".to_string(), "/tmp/home".to_string());
        vars.insert("MEMPHIS_DATA_DIR".to_string(), data_dir.to_string());
        OperatorConfig::from_iter(vars)
    }

    /// A config writing to a directory of its own, so two tests never
    /// read each other's spans.
    fn test_config() -> OperatorConfig {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("unix time")
            .as_nanos();
        let dir = std::env::temp_dir().join(format!(
            "memphis-native-telemetry-{}-{nanos}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        config_with_data_dir(dir.to_str().unwrap())
    }

    /// A temporary directory of its own, so two tests never read each
    /// other's spans.
    fn temp_dir_for_tests(prefix: &str) -> PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("unix time")
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("{prefix}-{}-{nanos}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("create the temporary directory");
        dir
    }

    /// The last span written for this config, parsed.
    fn read_last_span(config: &OperatorConfig) -> Value {
        let path = spans_file_path(config, Utc::now());
        let content = read_to_string(&path).expect("the span file must exist");
        let line = content
            .trim()
            .lines()
            .next_back()
            .expect("at least one span line");
        serde_json::from_str(line).expect("span line must be JSON")
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

    /// The cockpit is the authoritative surface, and it has to be
    /// measurable: `p99_turn_duration_ms` and `confabulation_rate` both
    /// read the `turn.dispatch` span, `provider_error_rate` and
    /// `p99_turn_latency_ms` read the `provider.completion` one.
    ///
    /// Measured on this host (2026-11-01) the report said "no
    /// turn.dispatch spans in window — last turn.dispatch span 3d ago"
    /// while the operator was talking to the cockpit every day: the
    /// TypeScript gateway emits the span, the native arm did not.
    #[test]
    fn a_turn_is_recorded_in_the_shape_the_evaluator_reads() {
        let config = test_config();
        record_turn_dispatch(
            &config,
            "session-7",
            "minimax",
            "MiniMax-M3.1-Flash",
            1234,
            false,
            None,
        );

        let parsed = read_last_span(&config);
        assert_eq!(parsed["name"], "turn.dispatch");
        assert_eq!(parsed["status"], "ok");
        assert_eq!(parsed["durationMs"], 1234);
        assert_eq!(parsed["attrs"]["surface"], "rust-tui");
        assert_eq!(parsed["attrs"]["conversation.id"], "session-7");
        assert_eq!(parsed["attrs"]["provider"], "minimax");
        assert_eq!(parsed["attrs"]["turn.timing_ms"], 1234);
    }

    #[test]
    fn a_failed_turn_is_recorded_as_an_error() {
        let config = test_config();
        record_turn_dispatch(
            &config,
            "session-7",
            "minimax",
            "model",
            10,
            true,
            Some("boom"),
        );

        let parsed = read_last_span(&config);
        assert_eq!(parsed["name"], "turn.dispatch");
        assert_eq!(parsed["status"], "error");
        assert_eq!(parsed["errorMessage"], "boom");
    }

    #[test]
    fn a_provider_completion_is_recorded_with_its_shape() {
        let config = test_config();
        record_provider_completion(&config, "minimax", "model-x", 24, 3, 500, false, None);

        let parsed = read_last_span(&config);
        assert_eq!(parsed["name"], "provider.completion");
        assert_eq!(parsed["status"], "ok");
        assert_eq!(parsed["durationMs"], 500);
        assert_eq!(parsed["attrs"]["provider.name"], "minimax");
        assert_eq!(parsed["attrs"]["provider.tools.count"], 24);
        assert_eq!(parsed["attrs"]["provider.messages.count"], 3);
    }

    #[test]
    fn a_failed_provider_completion_is_recorded_as_an_error() {
        let config = test_config();
        record_provider_completion(&config, "minimax", "model-x", 24, 3, 500, true, Some("502"));

        let parsed = read_last_span(&config);
        assert_eq!(parsed["name"], "provider.completion");
        assert_eq!(parsed["status"], "error");
        assert_eq!(parsed["errorMessage"], "502");
    }

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

    /// The bug this arm had: a failed write disabled the sink for the
    /// rest of the process lifetime, silently. A broken sink then looked
    /// exactly like an idle runtime — both produce no spans.
    ///
    /// The native arm is the authoritative surface, so this is the arm
    /// where the silence cost the most.
    #[test]
    fn a_failed_write_does_not_disable_the_sink_and_the_sink_recovers() {
        let dir = temp_dir_for_tests("memphis-native-telemetry-recovery");
        __reset_sink_state_for_tests(&dir);
        let config = config_with_data_dir(dir.to_str().unwrap());

        // The telemetry directory is a FILE, so the span write cannot
        // create it — a genuine write failure.
        fs::write(dir.join("telemetry"), b"not a directory").expect("write the obstruction");

        record_tool_call(&config, "memphis_journal", "call-fail", 5, false, None);

        let degraded = sink_status_entry(&config);
        assert_eq!(degraded.state, SinkState::Degraded);
        assert_eq!(degraded.consecutive_failures, 1);
        assert!(
            degraded.last_error.is_some(),
            "the failure must be recorded"
        );

        // The status file is what lets the report tell a broken sink
        // apart from an idle runtime.
        let status_path =
            crate::sink_status::sink_status_path(&config.data_dir, LOCAL_SINK_SURFACE);
        assert!(
            status_path.exists(),
            "the sink status file must exist at {}",
            status_path.display()
        );
        let entries = read_sink_status_entries(&config.data_dir);
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].state, SinkState::Degraded);

        // Remove the obstruction: the sink comes back on its own.
        fs::remove_file(dir.join("telemetry")).expect("remove the obstruction");
        __expire_sink_backoff_for_tests(&dir);
        record_tool_call(&config, "memphis_journal", "call-ok", 5, false, None);

        let recovered = sink_status_entry(&config);
        assert_eq!(recovered.state, SinkState::Ok);
        assert_eq!(recovered.consecutive_failures, 0);
        assert!(
            spans_file_path(&config, Utc::now()).exists(),
            "the sink must write spans again after the cause is gone"
        );
        let entries = read_sink_status_entries(&config.data_dir);
        assert_eq!(entries[0].state, SinkState::Ok);

        __reset_sink_state_for_tests(&dir);
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
