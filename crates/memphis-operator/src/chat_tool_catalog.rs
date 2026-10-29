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

pub(crate) fn native_tool_definitions() -> Vec<ChatToolDefinition> {
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
            name: "memphis_recall".to_string(),
            description: "Semantic search across Memphis memory chains".to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "query": { "type": "string" },
                    "limit": { "type": "number", "default": 5 }
                },
                "required": ["query"]
            }),
        },
        ChatToolDefinition {
            name: "memphis_search".to_string(),
            description: "Exact phrase search across indexed Memphis memory".to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "query": { "type": "string" },
                    "limit": { "type": "number", "default": 5 },
                    "chain": { "type": "string" }
                },
                "required": ["query"]
            }),
        },
        ChatToolDefinition {
            name: "memphis_health".to_string(),
            description: "Check Memphis runtime health".to_string(),
            input_schema: json!({ "type": "object", "properties": {} }),
        },
        ChatToolDefinition {
            name: "memphis_soul_read".to_string(),
            description: "Read soul manifest and soul memory".to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "section": { "type": "string", "enum": ["user", "self", "context", "all"] }
                }
            }),
        },
        ChatToolDefinition {
            name: "memphis_soul_write".to_string(),
            description: "Update soul memory. Arrays must be bare JSON arrays, never objects wrapping an array.".to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "updates": soul_updates_schema()
                },
                "required": ["updates"]
            }),
        },
        ChatToolDefinition {
            name: "memphis_case_query".to_string(),
            description: "Query the case chain index".to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "query": case_query_schema()
                },
                "required": ["query"]
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
            name: "memphis_vault_list".to_string(),
            description: "List vault metadata without revealing plaintext".to_string(),
            input_schema: json!({ "type": "object", "properties": {} }),
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
            name: "memphis_chain_verify".to_string(),
            description: "Authoritatively verify chain hashes, indexes, and prev-hash links before diagnosing corruption".to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "chain": { "type": "string", "description": "Optional chain name; omit to verify all chains" }
                }
            }),
        },
        ChatToolDefinition {
            name: "memphis_decide".to_string(),
            description: "Record a decision to the decisions chain with audit trail. Use when you and the operator agree on a course of action.".to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "title": { "type": "string", "description": "Decision title" },
                    "choice": { "type": "string", "description": "The chosen option" },
                    "context": { "type": "string", "description": "Why this decision was made" }
                },
                "required": ["title", "choice"]
            }),
        },
        // --- Tier 1 tools ---
        ChatToolDefinition {
            name: "memphis_code_read".to_string(),
            description: "Read a file from the Memphis workspace (~/memphis/)".to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "path": { "type": "string", "description": "File path (absolute or ~/relative)" },
                    "startLine": { "type": "number", "description": "Start line (1-based)" },
                    "endLine": { "type": "number", "description": "End line (inclusive)" },
                    "limit": { "type": "number", "description": "Max lines to return (default 2000)" }
                },
                "required": ["path"]
            }),
        },
        ChatToolDefinition {
            name: "memphis_grep".to_string(),
            description: "Search file contents by regex pattern in the Memphis workspace".to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "pattern": { "type": "string", "description": "Regex pattern to search for" },
                    "path": { "type": "string", "description": "Directory or file to search in (default: ~/memphis)" },
                    "glob": { "type": "string", "description": "Glob filter e.g. '*.ts'" },
                    "maxResults": { "type": "number", "description": "Max results (default 50)" }
                },
                "required": ["pattern"]
            }),
        },
        ChatToolDefinition {
            name: "memphis_glob".to_string(),
            description: "Find files by glob pattern in the Memphis workspace".to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "pattern": { "type": "string", "description": "Glob pattern e.g. 'src/**/*.ts'" },
                    "path": { "type": "string", "description": "Base directory (default: ~/memphis)" }
                },
                "required": ["pattern"]
            }),
        },
        ChatToolDefinition {
            name: "memphis_git".to_string(),
            description: "Run a read-only git command in the Memphis workspace".to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "command": { "type": "string", "description": "Git subcommand e.g. 'log --oneline -10', 'status', 'diff'" }
                },
                "required": ["command"]
            }),
        },
        ChatToolDefinition {
            name: "memphis_web_fetch".to_string(),
            description: "Fetch a URL and return text content".to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "url": { "type": "string", "description": "URL to fetch" },
                    "maxBytes": { "type": "number", "description": "Max bytes to read (default 32000)" }
                },
                "required": ["url"]
            }),
        },
        // --- Tier 2 tools ---
        ChatToolDefinition {
            name: "memphis_exec".to_string(),
            description: "Execute any shell command. Supports pipes, chaining (&&, ||, ;), subshells, and all programming language runtimes.".to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "command": { "type": "string", "description": "Shell command to execute" }
                },
                "required": ["command"]
            }),
        },
        ChatToolDefinition {
            name: "memphis_test".to_string(),
            description: "Run tests in the Memphis workspace".to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "suite": { "type": "string", "description": "Test suite: 'ts', 'rust', or 'all' (default: all)" },
                    "filter": { "type": "string", "description": "Test name filter pattern" }
                }
            }),
        },
        ChatToolDefinition {
            name: "memphis_self_modify".to_string(),
            description: "Write or edit a file in the Memphis workspace. Creates a git snapshot before writing. Set test=true to run build after write and auto-rollback on failure.".to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "path": { "type": "string", "description": "File path to write" },
                    "content": { "type": "string", "description": "Full file content to write" },
                    "mode": { "type": "string", "enum": ["write", "append"], "description": "Write mode (default: write)" },
                    "test": { "type": "boolean", "description": "Run build after write; rollback on failure (default: false)" }
                },
                "required": ["path", "content"]
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
            name: "memphis_cron_script".to_string(),
            description: "Manage cron script files in ~/memphis/crons/: list, add, remove, enable, disable. Each file carries its own cron expression and body; the runtime registers it as a scheduled task and runs it on that schedule. This is the FILE surface — `memphis_cron` manages scheduled TASKS.".to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "action": { "type": "string", "enum": ["list", "add", "remove", "enable", "disable"], "description": "Action (default: list)" },
                    "name": { "type": "string", "description": "Script name without the .sh suffix (required for add/remove/enable/disable)" },
                    "cron": { "type": "string", "description": "Cron expression e.g. '0 * * * *' (for add)" },
                    "script": { "type": "string", "description": "Shell script content (required for add)" }
                }
            }),
        },
    ]
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
/// Covers all 22 catalog and dispatcher operations. Unknown tools
/// are denied; adding a tool without explicit policy fails generation.
pub(crate) fn tool_tier(name: &str) -> u8 {
    match name {
        "memphis_classify"
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

/// JSON Schema for a single soul-memory list field (`string[]`).
///
/// Before this existed, `memphis_soul_write.updates` was declared as a bare
/// `{ "type": "object" }` with no `properties` and no `items`. A schema that
/// describes nothing is not neutral — the model fills the gap with the
/// simplest guess available, and for a list the guess is
/// `{ "item": [...] }`. That shape reached `run_soul_write` 18 times across
/// the chat history and was the payload the pre-fd008ea merge clobbered
/// silently. See decision #322.
pub(crate) fn soul_list_field(description: &str) -> Value {
    json!({
        "type": "array",
        "items": { "type": "string" },
        "description": format!(
            "{description} Send a bare JSON array like [\"first\", \"second\"] — never              {{\"item\": [...]}}."
        ),
        "examples": [["first", "second"]]
    })
}

pub(crate) fn soul_scalar_field(description: &str) -> Value {
    json!({
        "type": "string",
        "description": description
    })
}

/// Full JSON Schema for `memphis_soul_write.updates`, mirroring
/// `soulMemoryUpdateSchema` in `src/soul/types.ts` (zod, `.strict()`).
///
/// Sections and their field types are the SAME tables the runtime validator
/// enforces in `validate_soul_update_shape` — `SOUL_SCALAR_FIELDS` and
/// `SOUL_LIST_FIELDS` below. Three rules make the contract real:
///
/// 1. Every list field is `"type": "array"` with `items`. The model is told
///    the shape instead of guessing it.
/// 2. `"additionalProperties": false` on each section. A field the runtime
///    rejects is a field the schema already said was impossible.
/// 3. No `{"item": ...}` escape hatch anywhere. The wrapper is not a
///    supported shape, it is the failure mode this schema exists to prevent.
pub(crate) fn soul_updates_schema() -> Value {
    json!({
        "type": "object",
        "description": "Partial soul memory patch. Send arrays as bare JSON arrays, never wrapped in an object: {\"self\":{\"learnings\":[\"a\"]}}, NOT {\"self\":{\"learnings\":{\"item\":[\"a\"]}}}.",
        "properties": {
            "user": {
                "type": "object",
                "description": "What is known about the operator.",
                "additionalProperties": false,
                "properties": {
                    "name": soul_scalar_field("Operator display name."),
                    "languages": soul_list_field("Languages the operator writes in."),
                    "preferences": soul_list_field("How the operator wants work done."),
                    "expertise": soul_list_field("Domains the operator works in."),
                    "integrations": soul_list_field("External systems the operator uses.")
                }
            },
            "self": {
                "type": "object",
                "description": "What this agent has learned about itself.",
                "additionalProperties": false,
                "properties": {
                    "personality": soul_scalar_field("Agent personality summary."),
                    "strengths": soul_list_field("Demonstrated strengths."),
                    "learnings": soul_list_field("Lessons learned, each one a complete sentence."),
                    "evolvedCapabilities": soul_list_field("Capabilities gained through evolution.")
                }
            },
            "context": {
                "type": "object",
                "description": "What the agent is doing right now.",
                "additionalProperties": false,
                "properties": {
                    "activeWork": soul_scalar_field("One line on the current task."),
                    "recentDecisions": soul_list_field("Short summaries of recent decisions.")
                }
            }
        },
        "additionalProperties": false
    })
}

/// JSON Schema for `memphis_case_query.query` — mirrors the `CaseQuery` struct
/// in `crates/memphis-core/src/case_entry.rs`.
pub(crate) fn case_query_schema() -> Value {
    json!({
        "type": "object",
        "description": "Filter over case chain entries. Every field is optional; omit what you do not filter on.",
        "additionalProperties": false,
        "properties": {
            "case_type": {
                "type": "string",
                "enum": [
                    "nominative", "genitive", "dative", "accusative",
                    "instrumental", "locative", "ablative", "vocative"
                ],
                "description": "Filter by case entry type."
            },
            "entity": { "type": "string", "description": "Filter by entity." },
            "actor": { "type": "string", "description": "Filter by actor." },
            "target": { "type": "string", "description": "Filter by target." },
            "instrument": { "type": "string", "description": "Filter by instrument." },
            "location": { "type": "string", "description": "Filter by location." },
            "limit": { "type": "integer", "minimum": 1, "description": "Max results (default: 20)." }
        }
    })
}

/// JSON Schema for `memphis_case_append.entry` — mirrors the `CaseEntry`
/// enum in `crates/memphis-core/src/case_entry.rs`, which is
/// `#[serde(tag = "case_type")]`: `case_type` selects the variant and each
/// variant carries its own required fields.
///
/// Kept permissive on purpose. The runtime deserializes with serde and
/// reports serde's error, so an over-strict schema here would reject
/// entries the code can still store (callers legitimately pass extra
/// bookkeeping keys such as `chain`, `kind`, `requestId` or `tags`). The
/// harm being fixed here is the `{"item": ...}` wrapper on `tags`, not
/// missing `case_type` — so the schema names the fields and types the
/// wrapper problem away, while `tags` gets the explicit array shape it
/// never had.
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
