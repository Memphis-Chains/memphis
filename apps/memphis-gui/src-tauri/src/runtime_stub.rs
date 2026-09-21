//! Stub snapshot builder for Phase G-minimal MVP.
//!
//! Returns a fixed-shape snapshot so the Tauri ↔ frontend wiring can
//! be validated end-to-end. Phase G-mid replaces this with a real
//! `memphis_operator::OperatorRuntime::snapshot()` call (the runtime
//! reads from the host memphis data dir).

use crate::{ChainSummary, MemphisSnapshot};

pub fn build_snapshot() -> MemphisSnapshot {
    MemphisSnapshot {
        renderer: "tauri-webview",
        phase: "g-minimal-mvp",
        heartbeat_at: "1970-01-01T00:00:00Z".to_string(),
        screens: vec![
            "Chat",
            "Memory",
            "Sessions",
            "Vault",
            "Cases",
            "System",
            "Status",
        ],
        provider_statuses: vec!["phase-g-stub"],
        chain_summary: ChainSummary {
            chains_scanned: 7,
            blocks_ok: 0,
            blocks_failed: 0,
        },
    }
}
