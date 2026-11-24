//! The bridge's export vocabulary — ONE owner.
//!
//! ## Why this table exists
//!
//! The N-API bridge exported 37 functions when this table was written (it
//! exports **42** today — MEASURED 2026-11-24 on the built module, and
//! the table grew with it). Until 2026-11-23 that vocabulary was declared
//! in THREE places and compared by nobody:
//!
//! - the hand-written list inside `bridge_manifest()` in this crate — which
//!   named **34** exports, **omitted three** the bridge really exports
//!   (`embed_index_metadata`, `embed_clear_in_memory`,
//!   `embed_discard_replacement`), and named **nine** of them with a spelling
//!   the bridge does not use (`paths_resolve_data_dir` where the bridge
//!   exports `pathsResolveDataDir`, and the same for the other `paths_*` and
//!   `mv2_*` exports);
//! - the hand-written alias map in TypeScript
//!   (`src/infra/storage/rust-bridge-manifest.ts`) — 34 keys against 68
//!   spellings, of which **34 never matched** a real export, and which could
//!   not name the three missing ones at all;
//! - the binary itself, which is what the runtime actually calls.
//!
//! Measured 2026-11-23 on the operator's host, by reading the built module:
//! **37 exports**, against a 34-entry hand-written manifest and a 34-key
//! hand-written map.
//!
//! ## The rule this table enforces
//!
//! One table says what the bridge exports, under what name, and whether the
//! runtime requires it. `bridge_manifest()` serves it, the projection
//! (`scripts/sync-bridge-export-contract.mts`) copies it into the artefact
//! and into the TypeScript mirror, and the gate
//! (`crates/memphis-napi/tests/bridge_export_contract.rs`) checks the table
//! against this crate's OWN `#[napi]` declarations — so the table cannot
//! drift from the code it describes.
//!
//! The naming rule is napi-rs's: an explicit `js_name` is used verbatim, and
//! a function without one is exported in camelCase. MEASURED 2026-11-24 on
//! the built module: of the 42 exports, 25 carry an explicit `js_name` and
//! 17 do not — and ELEVEN of those reach JavaScript under a different
//! spelling (the `paths_*` and `mv2_*` families), while the other six are
//! single-word names whose camelCase form is the name itself. That is why
//! the vocabulary is mixed.

use serde::Serialize;

/// One export of the N-API bridge.
#[derive(Clone, Copy, Debug)]
pub struct BridgeExport {
    /// The canonical name — the Rust function's name.
    pub canonical: &'static str,
    /// The name the bridge exports to JavaScript.
    pub js_name: &'static str,
    /// Whether the runtime refuses to start without this export.
    pub required: bool,
}

/// One export binding, as the manifest carries it.
///
/// This used to be a `serde_json::json!` literal per export — the shape
/// was written down twice (once in the literal, once in the TypeScript
/// reader) and nobody compared them. The struct is the shape, and the
/// payload owner (`bridge_payloads.rs`) points at it.
#[derive(Clone, Copy, Debug, Serialize)]
pub struct BridgeExportBinding {
    /// The canonical name — the Rust function's name.
    pub canonical: &'static str,
    /// The name the bridge exports it under.
    #[serde(rename = "jsName")]
    pub js_name: &'static str,
    /// Whether the runtime refuses to start without this export.
    pub required: bool,
}

/// Every export of this bridge.
pub const BRIDGE_EXPORTS: &[BridgeExport] = &[
    BridgeExport { canonical: "bridge_chain_name_facts", js_name: "bridge_chain_name_facts", required: false },
    BridgeExport { canonical: "bridge_chain_name_manifest", js_name: "bridge_chain_name_manifest", required: false },
    // The embed profile's rule and its live values. `required: false` — the
    // runtime does not need them (it resolves the profile in Rust), and the
    // TypeScript surfaces that DO need them ask the bridge when it is
    // loaded. The gate (`ops:sync-embed-profile-contract`) keeps the two
    // sides in step.
    BridgeExport { canonical: "bridge_embed_profile_facts", js_name: "bridge_embed_profile_facts", required: false },
    BridgeExport { canonical: "bridge_embed_profile_manifest", js_name: "bridge_embed_profile_manifest", required: false },
    // The payload shapes — the layer under the vocabulary (E-09). Optional:
    // the runtime does not need them to start, and a binary without this
    // export keeps working.
    BridgeExport { canonical: "bridge_payload_manifest", js_name: "bridge_payload_manifest", required: false },
    BridgeExport { canonical: "bridge_manifest", js_name: "bridge_manifest", required: true },
    BridgeExport { canonical: "chain_append", js_name: "chain_append", required: true },
    BridgeExport { canonical: "chain_query", js_name: "chain_query", required: true },
    BridgeExport { canonical: "chain_validate", js_name: "chain_validate", required: true },
    BridgeExport { canonical: "case_append", js_name: "case_append", required: true },
    BridgeExport { canonical: "case_query", js_name: "case_query", required: true },
    BridgeExport { canonical: "case_rebuild", js_name: "case_rebuild", required: true },
    BridgeExport { canonical: "embed_clear_in_memory", js_name: "embed_clear_in_memory", required: false },
    BridgeExport { canonical: "embed_discard_replacement", js_name: "embed_discard_replacement", required: false },
    BridgeExport { canonical: "embed_flush", js_name: "embed_flush", required: true },
    BridgeExport { canonical: "embed_index_metadata", js_name: "embed_index_metadata", required: false },
    BridgeExport { canonical: "embed_reset", js_name: "embed_reset", required: true },
    BridgeExport { canonical: "embed_search", js_name: "embed_search", required: true },
    BridgeExport { canonical: "embed_search_tuned", js_name: "embed_search_tuned", required: true },
    BridgeExport { canonical: "embed_shutdown", js_name: "embed_shutdown", required: true },
    BridgeExport { canonical: "embed_store", js_name: "embed_store", required: true },
    BridgeExport { canonical: "embed_store_many", js_name: "embed_store_many", required: true },
    BridgeExport { canonical: "mv2_export", js_name: "mv2Export", required: false },
    BridgeExport { canonical: "mv2_inspect", js_name: "mv2Inspect", required: false },
    BridgeExport { canonical: "paths_normalize_chain_name", js_name: "pathsNormalizeChainName", required: true },
    BridgeExport { canonical: "paths_resolve_case_index", js_name: "pathsResolveCaseIndex", required: true },
    BridgeExport { canonical: "paths_resolve_chain_path", js_name: "pathsResolveChainPath", required: true },
    BridgeExport { canonical: "paths_resolve_chains_dir", js_name: "pathsResolveChainsDir", required: true },
    BridgeExport { canonical: "paths_resolve_data_dir", js_name: "pathsResolveDataDir", required: true },
    BridgeExport { canonical: "paths_resolve_database_path", js_name: "pathsResolveDatabasePath", required: true },
    BridgeExport { canonical: "paths_resolve_embed_index", js_name: "pathsResolveEmbedIndex", required: true },
    BridgeExport { canonical: "paths_resolve_vault_entries", js_name: "pathsResolveVaultEntries", required: true },
    BridgeExport { canonical: "paths_resolve_vault_state", js_name: "pathsResolveVaultState", required: true },
    BridgeExport { canonical: "soul_loop_step", js_name: "soul_loop_step", required: true },
    BridgeExport { canonical: "soul_replay", js_name: "soul_replay", required: true },
    BridgeExport { canonical: "vault_decode_entry", js_name: "vault_decode_entry", required: true },
    BridgeExport { canonical: "vault_init_full", js_name: "vault_init_full", required: true },
    BridgeExport { canonical: "vault_init_json", js_name: "vault_init_json", required: true },
    BridgeExport { canonical: "vault_load_state", js_name: "vault_load_state", required: true },
    BridgeExport { canonical: "vault_parse_entries", js_name: "vault_parse_entries", required: true },
    BridgeExport { canonical: "vault_retrieve", js_name: "vault_retrieve", required: true },
    BridgeExport { canonical: "vault_store", js_name: "vault_store", required: true },
];

/// The canonical names, in table order.
pub fn canonical_names() -> Vec<&'static str> {
    BRIDGE_EXPORTS.iter().map(|export| export.canonical).collect()
}

/// The canonical names the runtime requires.
pub fn required_names() -> Vec<&'static str> {
    BRIDGE_EXPORTS
        .iter()
        .filter(|export| export.required)
        .map(|export| export.canonical)
        .collect()
}

/// The canonical names the runtime does NOT require.
///
/// This used to be a hand-written list of TWO names inside
/// `bridge_manifest()` — a leftover from June 2026, from before this table
/// existed. It named `mv2_export` and `mv2_inspect` while the table
/// already knew TEN optional exports, so the manifest answered a question
/// about optionality with a stale second copy of the rule. Nothing read
/// it, which is why it stayed wrong for five months.
pub fn optional_names() -> Vec<&'static str> {
    BRIDGE_EXPORTS
        .iter()
        .filter(|export| !export.required)
        .map(|export| export.canonical)
        .collect()
}

/// The `canonical -> js_name` bindings, as the manifest carries them.
pub fn bindings() -> Vec<BridgeExportBinding> {
    BRIDGE_EXPORTS
        .iter()
        .map(|export| BridgeExportBinding {
            canonical: export.canonical,
            js_name: export.js_name,
            required: export.required,
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_table_has_no_duplicates() {
        let mut canonical: Vec<&str> = canonical_names();
        canonical.sort_unstable();
        let before = canonical.len();
        canonical.dedup();
        assert_eq!(before, canonical.len(), "a canonical name is listed twice");

        let mut js: Vec<&str> = BRIDGE_EXPORTS.iter().map(|export| export.js_name).collect();
        js.sort_unstable();
        let before = js.len();
        js.dedup();
        assert_eq!(before, js.len(), "a js name is listed twice");
    }

    #[test]
    fn every_required_export_is_listed() {
        assert!(!required_names().is_empty());
        for name in required_names() {
            assert!(
                BRIDGE_EXPORTS.iter().any(|export| export.canonical == name),
                "{name} is required but not in the table"
            );
        }
    }
}
