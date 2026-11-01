//! The native arm of the local span sink, checked against the contract
//! it shares with the TypeScript arm.
//!
//! `tests/fixtures/telemetry-sink-status-contract.json` holds the
//! contract; the TypeScript runner is
//! `tests/unit/observability-sink-contract.test.ts`.
//!
//! WHY THE CONTRACT EXISTS
//! -----------------------
//! The two arms used to disable their sink permanently after the first
//! write failure, and they did it independently — the TypeScript side
//! with a `writeFailedOnce` flag, this side with a `WRITE_FAILED_ONCE`
//! atomic. Both were silent apart from one line on stderr, and a broken
//! sink looked exactly like an idle runtime: no spans either way.

use std::fs;
use std::path::PathBuf;

use memphis_operator::sink_retry::sink_retry_delay_ms;
use memphis_operator::sink_status::{
    read_sink_status_entries, sink_status_file_name, write_sink_status, SinkState, SinkStatusEntry,
    LOCAL_SINK_SURFACE,
};
use serde_json::Value;

const FIXTURE: &str = include_str!("../../../tests/fixtures/telemetry-sink-status-contract.json");

fn fixture() -> Value {
    serde_json::from_str(FIXTURE).expect("the contract fixture must be valid JSON")
}

fn temp_dir(prefix: &str) -> PathBuf {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("unix time")
        .as_nanos();
    let dir = std::env::temp_dir().join(format!("{prefix}-{}-{nanos}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).expect("create the temporary directory");
    dir
}

#[test]
fn the_retry_schedule_matches_the_contract() {
    let contract = fixture();
    let schedule = contract["retry"]["schedule"]
        .as_array()
        .expect("the fixture must carry a schedule");
    assert!(!schedule.is_empty(), "the schedule must not be empty");
    for entry in schedule {
        let failures = entry["consecutiveFailures"]
            .as_u64()
            .expect("failure count");
        let expected = entry["delayMs"].as_i64().expect("delay");
        assert_eq!(
            sink_retry_delay_ms(failures as u32),
            expected,
            "the native arm must produce the same delay as the TypeScript arm"
        );
    }
}

#[test]
fn the_base_delay_and_the_cap_come_from_the_contract() {
    let contract = fixture();
    let base = contract["retry"]["baseMs"].as_i64().expect("base delay");
    let max = contract["retry"]["maxMs"].as_i64().expect("max delay");
    assert_eq!(sink_retry_delay_ms(1), base);
    assert_eq!(sink_retry_delay_ms(50), max);
}

#[test]
fn the_status_file_carries_every_field_of_the_contract() {
    let contract = fixture();
    let dir = temp_dir("memphis-sink-contract-rust");
    let entry = SinkStatusEntry {
        surface: LOCAL_SINK_SURFACE.to_string(),
        state: SinkState::Degraded,
        consecutive_failures: 2,
        last_error: Some("EACCES".to_string()),
        last_failure_at: Some("2026-11-01T10:00:00.000Z".to_string()),
        last_success_at: Some("2026-11-01T09:00:00.000Z".to_string()),
        next_retry_at: Some("2026-11-01T10:00:02.000Z".to_string()),
        updated_at: "2026-11-01T10:00:00.000Z".to_string(),
    };
    write_sink_status(&dir, &entry).expect("the status file must be written");

    let file = dir.join(sink_status_file_name(LOCAL_SINK_SURFACE));
    assert!(file.exists(), "the status file must exist");
    let parsed: Value =
        serde_json::from_str(&fs::read_to_string(&file).expect("read the status file"))
            .expect("the status file must be JSON");

    let mut written: Vec<String> = parsed
        .as_object()
        .expect("the status file must be an object")
        .keys()
        .cloned()
        .collect();
    written.sort();
    let mut expected: Vec<String> = contract["statusFile"]["fields"]
        .as_array()
        .expect("the fixture must carry the field list")
        .iter()
        .map(|value| value.as_str().expect("a field name").to_string())
        .collect();
    expected.sort();
    assert_eq!(
        written, expected,
        "the native arm must write the fields the contract names"
    );

    let states = contract["statusFile"]["states"]
        .as_array()
        .expect("the fixture must carry the states");
    assert!(states.iter().any(|value| value == "degraded"));

    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn a_status_file_is_read_back_and_a_broken_one_is_skipped() {
    let dir = temp_dir("memphis-sink-contract-read");
    let entry = SinkStatusEntry {
        surface: LOCAL_SINK_SURFACE.to_string(),
        state: SinkState::Degraded,
        consecutive_failures: 1,
        last_error: Some("boom".to_string()),
        last_failure_at: Some("2026-11-01T10:00:00.000Z".to_string()),
        last_success_at: None,
        next_retry_at: Some("2026-11-01T10:00:01.000Z".to_string()),
        updated_at: "2026-11-01T10:00:00.000Z".to_string(),
    };
    write_sink_status(&dir, &entry).expect("the status file must be written");
    fs::write(dir.join("sink-status-broken.json"), "{not json").expect("write the broken fixture");

    let entries = read_sink_status_entries(&dir);
    assert_eq!(
        entries.len(),
        1,
        "a broken status file is skipped, not fatal"
    );
    assert_eq!(entries[0].surface, LOCAL_SINK_SURFACE);
    assert_eq!(entries[0].state, SinkState::Degraded);
    assert_eq!(entries[0].last_error.as_deref(), Some("boom"));

    let _ = fs::remove_dir_all(&dir);
}
