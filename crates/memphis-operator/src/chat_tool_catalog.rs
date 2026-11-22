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

use serde_json::{json, Value};

use crate::provider::ChatToolDefinition;

/// The tools the native surface advertises.
///
/// Two parts, and the difference between them is the point:
///
///   - the PROJECTED tools, whose schemas come from the TypeScript
///     registry through `chat_tool_contract.rs` — a JSON projection of it,
///     checked by this crate's own test against
///     `tests/fixtures/native-tool-contract.json`;
///   - the DIVERGENT tools, whose native implementation does not (yet)
///     honour the registry, so they keep a schema that says what the
///     native surface actually accepts.
///
/// Before the projection, the hand-written schemas were a second copy of
/// the registry with nothing comparing them. Measured 2026-11-22: five of
/// the 23 tools advertised different arguments than the registry, and
/// `memphis_self_modify` under one name meant "write one file" and under
/// the other "apply changes to many files".
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

            let mut definitions: Vec<ChatToolDefinition> = tools
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
                .collect();

            definitions.extend(native_divergent_definitions());
            definitions
        })
        .clone()
}

/// The tools whose native implementation does NOT implement the registry's
/// contract.
///
/// Measured 2026-11-22, five of the 23 native tools advertised different
/// arguments than the registry does. For the other eighteen the executor
/// already honoured the registry — their schemas are projected from it (see
/// `chat_tool_contract.rs`). For these five it does not, so they keep a
/// schema that says what the native surface ACTUALLY accepts, and the
/// difference is declared in
/// `tests/fixtures/native-tool-contract.json` with the reason and the work
/// that closes it.
///
/// The native surface must not advertise what it cannot execute: a schema
/// that promises `chain` and then writes to the default chain is the same
/// class of bug as a schema that promises the wrong argument names.
pub(crate) fn native_divergent_definitions() -> Vec<ChatToolDefinition> {
    vec![
        ChatToolDefinition {
                name: "memphis_journal".to_string(),
                description: "Save an entry to the Memphis journal chain".to_string(),
                input_schema: json!({
                    "type": "object",
                    "properties": {
                        "content": { "type": "string" },
                        "tags": { "type": "array", "items": { "type": "string" } }
                    },
                    "required": ["content"]
                }),
            },
        ChatToolDefinition {
                name: "memphis_case_append".to_string(),
                description: "Append a case chain entry. Arrays must be bare JSON arrays, never objects wrapping an array.".to_string(),
                input_schema: json!({
                    "type": "object",
                    "properties": {
                        "entry": case_entry_schema()
                    },
                    "required": ["entry"]
                }),
            },
        ChatToolDefinition {
                name: "memphis_chain_query".to_string(),
                description: "Query blocks from a Memphis chain (journal, decisions, patterns, reflections). Filter by substring or tag.".to_string(),
                input_schema: json!({
                    "type": "object",
                    "properties": {
                        "chain": { "type": "string", "description": "Chain name e.g. 'journal', 'decisions', 'patterns', 'reflections'" },
                        "contains": { "type": "string", "description": "Substring filter on block content" },
                        "tag": { "type": "string", "description": "Filter blocks by tag" },
                        "limit": { "type": "number", "description": "Max blocks to return (default: 20)" }
                    },
                    "required": ["chain"]
                }),
            },
        ChatToolDefinition {
                name: "memphis_classify".to_string(),
                description: "Advisory typed decision via the local BASAL service. Validates class probabilities and reports confidence, model, calibration and deferral. auto reports caller-threshold eligibility and honors deferral; it grants no action permissions or domain error-rate guarantee. Defaults use a bounded service threshold read with fallback0.93; explicit caller policy wins. Historical CPU calls took70-140seconds. Requires a separately running service.".to_string(),
                input_schema: json!({
                    "type": "object",
                    "properties": {
                        "state": { "type": "string", "description": "The text to classify: a message, a document, a case file" },
                        "question": { "type": "string", "description": "What to decide about it, in plain language" },
                        "criteria": {
                            "type": "object",
                            "description": "Options as {key: description} pairs. The model reads the descriptions, so they carry the meaning. Needs at least 2 and at most 10 entries. Send a bare object like {\"cards\": \"Reklamacje kart\"} — not {\"item\": [...] }.",
                            "additionalProperties": { "type": "string" },
                            "minProperties": 2,
                            "maxProperties": 10
                        },
                        "type": { "type": "string", "enum": ["choice", "noul", "score"], "description": "choice (default), noul (yes/no), or score; score objects require ordinal keys 0..n-1" },
                        "threshold": { "type": "number", "description": "Advisory confidence threshold from 0 to 1. Explicit policy overrides the service default; never grants action permissions." },
                        "orders": { "type": "number", "description": "1 = one forward pass, faster but order-sensitive; 2 = averaged over both option orders, invariant to ordering" }
                    },
                    "required": ["state", "question", "criteria"]
                }),
            },
        ChatToolDefinition {
                name: "memphis_self_modify".to_string(),
                description: "Submit a proposed complete file replacement for local operator review. No file is written until the operator runs evolve prepare in a local terminal; no password should be sent to the agent.".to_string(),
                input_schema: json!({
                    "type": "object",
                    "properties": {
                        "path": { "type": "string", "description": "File path to write" },
                        "content": { "type": "string", "description": "Full file content to write" },
                        "mode": { "type": "string", "enum": ["write"], "description": "Submit full replacement content" }
                    },
                    "required": ["path", "content"]
                }),
            },
    ]
}

pub(crate) fn case_entry_schema() -> Value {
    json!({
        "type": "object",
        "description": "Case chain entry. case_type selects the variant and determines the other fields. Send arrays as bare JSON arrays, never wrapped in an object.",
        "properties": {
            "case_type": {
                "type": "string",
                "enum": [
                    "nominative", "genitive", "dative", "accusative",
                    "instrumental", "locative", "ablative", "vocative"
                ],
                "description": "Case entry type. Required by the serde-tagged enum."
            },
            "entity": { "type": "string", "description": "nominative/locative/ablative: the subject." },
            "action": { "type": "string", "description": "nominative: what the entity did." },
            "timestamp": { "type": "string", "description": "nominative: when it happened." },
            "owner": { "type": "string", "description": "genitive: who holds it." },
            "possessed": { "type": "string", "description": "genitive: what is held." },
            "giver": { "type": "string", "description": "dative: who gives." },
            "recipient": { "type": "string", "description": "dative: who receives." },
            "object": { "type": "string", "description": "dative/accusative: the object acted on." },
            "subject": { "type": "string", "description": "accusative: who acts." },
            "verb": { "type": "string", "description": "accusative: the action performed." },
            "actor": { "type": "string", "description": "instrumental: who acts." },
            "instrument": { "type": "string", "description": "instrumental: the means used." },
            "target": { "type": "string", "description": "instrumental/vocative: the recipient of the action." },
            "location": { "type": "string", "description": "locative: where." },
            "origin": { "type": "string", "description": "ablative: where from." },
            "destination": { "type": "string", "description": "ablative: optional where to." },
            "invoker": { "type": "string", "description": "vocative: who calls." },
            "invocation": { "type": "string", "description": "vocative: the call itself." },
            "content": { "type": "string", "description": "Free-text body for the entry." },
            "chain": { "type": "string", "description": "Chain the entry belongs to." },
            "kind": { "type": "string", "description": "Entry kind (bookkeeping)." },
            "role": { "type": "string", "description": "Entry role (bookkeeping)." },
            "source": { "type": "string", "description": "Where the entry came from." },
            "requestId": { "type": "string", "description": "Request identifier (bookkeeping)." },
            "action_kind": { "type": "string", "description": "Action label (bookkeeping)." },
            "tags": {
                "type": "array",
                "items": { "type": "string" },
                "description": "Tags. Bare JSON array — never {\"item\": [...]}.",
                "examples": [["instance-council-response", "collective"]]
            }
        }
    })
}

///
/// The definitions come from `chat_tool_contract.rs` — a JSON projection
/// of the TypeScript registry, checked by the operator crate's own test
/// against `tests/fixtures/native-tool-contract.json`. The hand-written
/// schemas that used to live here were a second copy of the registry:
/// measured 2026-11-22, five of the 23 tools advertised different
/// arguments than the registry does, and `memphis_self_modify` under one
/// name meant "write one file" and under the other "apply changes to
/// many files".
///
/// The contract is parsed once and cached: the cockpit builds its tool
/// list per turn, and re-parsing 18 KB of JSON per turn would be waste.
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

    #[test]
    fn the_divergent_tools_are_declared_in_the_fixture() {
        let document = fixture();
        let declared: Vec<&str> = document["divergences"]
            .as_array()
            .expect("divergences array")
            .iter()
            .filter_map(|entry| entry.get("name").and_then(Value::as_str))
            .collect();

        let divergent = native_divergent_definitions();
        let offered: Vec<&str> = divergent.iter().map(|tool| tool.name.as_str()).collect();

        assert_eq!(
            offered, declared,
            "the tools the cockpit keeps its own schema for must be the ones the contract declares as divergent"
        );
    }

    #[test]
    fn the_projection_and_the_divergences_cover_every_native_tool() {
        let document = fixture();
        let projected: Vec<&str> = document["tools"]
            .as_array()
            .expect("tools array")
            .iter()
            .filter_map(|tool| tool.get("name").and_then(Value::as_str))
            .collect();

        let divergent = native_divergent_definitions();
        let mut offered: Vec<&str> = projected.clone();
        offered.extend(divergent.iter().map(|tool| tool.name.as_str()));

        assert_eq!(
            offered.len(),
            projected.len() + divergent.len(),
            "no native tool may be offered twice"
        );
        let mut unique = offered.clone();
        unique.sort_unstable();
        unique.dedup();
        assert_eq!(unique.len(), offered.len(), "no native tool may be offered twice");
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
