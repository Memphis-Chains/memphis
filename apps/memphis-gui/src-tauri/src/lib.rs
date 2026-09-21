//! Memphis Desktop (Tauri shell) — Phase G-minimal MVP.
//!
//! One Tauri command so far: `memphis_get_snapshot` returning an
//! `OperatorSnapshot` for the embedded stub runtime. Real runtime
//! swap (the memphis-operator's `OperatorRuntime::snapshot` wired
//! into a `tauri::State<Runtime>`) is the next step in Phase G-minimal;
//! deliberately out of scope of this scaffold so the wiring surface
//! (Cargo.toml + path deps + tauri.conf.json + lib.rs + main.rs +
//! minimal frontend) can be validated end-to-end without spinning
//! up the full memphis stack.
//!
//! Capability surface (allowlisted by `tauri.conf.json`):
//!   - memphis_get_snapshot  (returns OperatorSnapshot as JSON)
//!
//! All other capabilities are intentionally absent. Phase G-mid
//! extends this with chat, status bar, settings dialog.

use serde::Serialize;
use tauri::Manager;

mod runtime_stub;

/// JSON shape returned from `memphis_get_snapshot`. Same wire-format
/// as `memphis_operator::OperatorSnapshot` (re-typed here to keep the
/// Phase G-minimal MVP independent of the operator crate's exact
/// field ordering — Phase G-mid will switch the return type to
/// `memphis_operator::OperatorSnapshot` directly).
#[derive(Debug, Clone, Serialize)]
pub struct MemphisSnapshot {
    pub renderer: &'static str,
    pub phase: &'static str,
    pub heartbeat_at: String,
    pub screens: Vec<&'static str>,
    pub provider_statuses: Vec<&'static str>,
    pub chain_summary: ChainSummary,
}

#[derive(Debug, Clone, Serialize)]
pub struct ChainSummary {
    pub chains_scanned: usize,
    pub blocks_ok: usize,
    pub blocks_failed: usize,
}

/// First Tauri command. Returns the current Memphis snapshot.
///
/// Phase G-minimal contract: this returns a STUB snapshot so the
/// Tauri ↔ frontend wiring surface can be validated without booting
/// the full runtime. Phase G-mid will swap the body to:
/// `state.runtime.snapshot()` against an `OperatorRuntime::new()`
/// seeded from the operator's local state dir.
#[tauri::command]
fn memphis_get_snapshot() -> MemphisSnapshot {
    runtime_stub::build_snapshot()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    env_logger::init();

    tauri::Builder::default()
        .setup(|app| {
            // Touch the app handle so the surface doesn't get optimised
            // away; future phases inject `OperatorRuntime` here.
            let _ = app.handle();
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![memphis_get_snapshot])
        .run(tauri::generate_context!())
        .expect("error while running memphis-gui (Tauri shell)");
}
