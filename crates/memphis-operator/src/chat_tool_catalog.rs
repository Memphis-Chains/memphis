//! The catalog of tools the native operator surface advertises to a model,
//! and the tier policy that gates them.
//!
//! WHY THIS MODULE EXISTS
//! -----------------------
//! Two independent sources of truth used to answer "how much
//! authorization does this tool need": the TypeScript `TOOL_REGISTRY` and a
//! hand-written `tool_tier` match in `chat.rs`. Nothing compared them, so
//! they drifted. Measured 2026-10-07, five tools were one tier lower
//! natively than in the registry — `memphis_code_read`, `memphis_grep`,
//! `memphis_glob`, `memphis_git` and `memphis_web_fetch`. On a surface
//! pinned to tier 1 the gateway refused `memphis_code_read` while the
//! native operator served the file body.
//!
//! The registry is the authority. `scripts/sync-native-tiers.mts` projects
//! it into the `tool_tier` table below and `--check` fails the build on
//! drift. This module keeps the generated table and the advertised catalog
//! in one place, so the policy a model sees and the policy the runtime
//! enforces are reviewed together.

use serde_json::Value;

use crate::provider::ChatToolDefinition;

/// The tools the native surface advertises.
///
/// Every tool is a PROJECTED tool: its schema comes from the TypeScript
/// registry through `chat_tool_contract.rs` — a JSON projection of it,
/// checked by this crate's own test against
/// `tests/fixtures/native-tool-contract.json`.
///
/// There used to be a second part: the DIVERGENT tools, whose native
/// implementation did not honour the registry and so kept a hand-written
/// schema saying what the native surface actually accepted. The last one
/// was `memphis_self_modify`, which under one name meant "write one file"
/// and under the other "apply changes to many files". Its native arm now
/// implements the registry's semantics
/// (`chat_self_modify.rs`), so the divergent list is empty — and a list
/// that is empty is dead weight, so it is gone rather than kept as a
/// placeholder for the next divergence.
///
/// The contract is parsed once and cached: the cockpit builds its tool
/// list per turn, and re-parsing it per turn would be waste.
pub(crate) fn native_tool_definitions() -> Vec<ChatToolDefinition> {
    static CACHE: std::sync::OnceLock<Vec<ChatToolDefinition>> = std::sync::OnceLock::new();
    CACHE
        .get_or_init(|| {
            let document: Value =
                serde_json::from_str(crate::chat_tool_contract::NATIVE_TOOL_CONTRACT_JSON)
                    .expect("the native tool contract must be valid JSON");
            let tools = document
                .get("tools")
                .and_then(Value::as_array)
                .expect("the native tool contract must carry a tools array");

            tools
                .iter()
                .map(|tool| ChatToolDefinition {
                    name: tool
                        .get("name")
                        .and_then(Value::as_str)
                        .expect("a tool must carry a name")
                        .to_string(),
                    description: tool
                        .get("description")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string(),
                    input_schema: tool
                        .get("input_schema")
                        .cloned()
                        .expect("a tool must carry an input schema"),
                })
                .collect()
        })
        .clone()
}

/// Tier for every tool the native surface exposes.
///
/// GENERATED — do not edit by hand. Source of truth is
/// src/gateway/tool-registry.ts (`TOOL_REGISTRY`), which the MCP server,
/// the JSON-schema exporter and the confabulation detector all read.
///
/// Regenerate with `npm run -s ops:sync-native-tiers`, and check drift with
/// `npm run -s ops:sync-native-tiers -- --check` (exit 1 when out of sync).
///
/// These two used to disagree, and nothing compared them:
/// `memphis_code_read` was tier 2 in TypeScript and tier 1 here, so a
/// surface pinned to tier 1 had the gateway refuse the call while the native
/// operator served the file body. `memphis_grep`, `memphis_glob`,
/// `memphis_git` and `memphis_web_fetch` were also one tier lower natively.
///
/// Covers all 23 catalog and dispatcher operations. Unknown tools
/// are denied; adding a tool without explicit policy fails generation.
pub(crate) fn tool_tier(name: &str) -> u8 {
    match name {
        "memphis_brave_search"
        | "memphis_classify"
        | "memphis_code_read"
        | "memphis_cron_script"
        | "memphis_exec"
        | "memphis_git"
        | "memphis_glob"
        | "memphis_grep"
        | "memphis_self_modify"
        | "memphis_test"
        | "memphis_web_fetch" => 2,
        "memphis_case_append"
        | "memphis_case_query"
        | "memphis_chain_query"
        | "memphis_chain_verify"
        | "memphis_decide"
        | "memphis_health"
        | "memphis_journal"
        | "memphis_recall"
        | "memphis_search"
        | "memphis_soul_read"
        | "memphis_soul_write"
        | "memphis_vault_list" => 0,
        _ => u8::MAX,
    }
}

/// Returns the operator's max allowed tool tier, read from
/// `MEMPHIS_OPERATOR_MAX_TOOL_TIER` (default: 2).
pub(crate) fn max_tool_tier_from_env() -> u8 {
    std::env::var("MEMPHIS_OPERATOR_MAX_TOOL_TIER")
        .ok()
        .and_then(|v| v.trim().parse::<u8>().ok())
        .unwrap_or(2)
}

#[cfg(test)]
mod contract_tests {
    //! The Rust side of the native tool contract gate.
    //!
    //! The artifact is `tests/fixtures/native-tool-contract.json`. The
    //! TypeScript side checks the registry against it
    //! (`tests/unit/native-tool-contract.test.ts`); this checks the
    //! cockpit's own projection against it. Neither side produces it
    //! alone, so neither side can change it alone.

    use super::*;

    const FIXTURE: &str = include_str!("../../../tests/fixtures/native-tool-contract.json");

    fn fixture() -> Value {
        serde_json::from_str(FIXTURE).expect("the contract fixture must be valid JSON")
    }

    fn projected() -> Value {
        serde_json::from_str(crate::chat_tool_contract::NATIVE_TOOL_CONTRACT_JSON)
            .expect("the projected contract must be valid JSON")
    }

    #[test]
    fn the_projection_is_the_fixture() {
        assert_eq!(
            projected(),
            fixture(),
            "the cockpit's projection differs from the agreed contract — run: npm run -s ops:sync-native-tool-contract"
        );
    }

    /// Every native tool comes from the projection.
    ///
    /// The cockpit used to keep a hand-written schema for the tools whose
    /// native implementation did not honour the registry, and the
    /// difference was declared in the fixture. The last such tool,
    /// `memphis_self_modify`, now implements the registry's semantics, so
    /// there is nothing left to declare — and a tool that drifts back into
    /// a second, hand-written schema must fail HERE rather than in
    /// production, where the model would be taught a shape the surface
    /// does not accept.
    #[test]
    fn every_native_tool_comes_from_the_projection() {
        let document = fixture();
        let declared: Vec<&str> = document["divergences"]
            .as_array()
            .expect("divergences array")
            .iter()
            .filter_map(|entry| entry.get("name").and_then(Value::as_str))
            .collect();

        assert!(
            declared.is_empty(),
            "the cockpit's tools all implement the registry, so the contract must declare no divergence — found: {declared:?}"
        );

        let projected: Vec<&str> = document["tools"]
            .as_array()
            .expect("tools array")
            .iter()
            .filter_map(|tool| tool.get("name").and_then(Value::as_str))
            .collect();

        let definitions = native_tool_definitions();
        let advertised: Vec<&str> = definitions.iter().map(|tool| tool.name.as_str()).collect();

        assert_eq!(
            advertised, projected,
            "the cockpit must advertise exactly the projected tools"
        );
    }

    /// The cockpit's prose must describe fields that EXIST. A description
    /// of a field the contract does not declare is the model being taught
    /// to send something the surface will reject.
    #[test]
    fn the_guidance_describes_only_fields_the_contract_declares() {
        let guidance: Value = serde_json::from_str(include_str!(
            "chat_tool_guidance.json"
        ))
        .expect("the guidance file must be valid JSON");
        let document = fixture();

        let mut problems: Vec<String> = Vec::new();
        if let Some(tools) = guidance.as_object() {
            for (tool_name, fields) in tools {
                let contract = document["tools"]
                    .as_array()
                    .and_then(|tools| {
                        tools
                            .iter()
                            .find(|tool| tool.get("name").and_then(Value::as_str) == Some(tool_name.as_str()))
                    })
                    .cloned();
                // A divergent tool keeps its own schema, so the guidance
                // for it is not checked against the projection.
                let contract = match contract {
                    Some(contract) => contract,
                    None => continue,
                };
                if let Some(fields) = fields.as_object() {
                    for field in fields.keys() {
                        let declared = contract["input_schema"]["properties"]
                            .get(field)
                            .is_some();
                        if !declared {
                            problems.push(format!("{tool_name}.{field} is not in the contract"));
                        }
                    }
                }
            }
        }

        assert!(
            problems.is_empty(),
            "the guidance describes fields the contract does not declare:\\n{}",
            problems.join("\\n")
        );
    }
}
