//! The bridge's payload shapes — ONE owner.
//!
//! ## Why this table exists
//!
//! E-01 gave the bridge's export VOCABULARY one owner. This table is the
//! next layer down: the SHAPE of what those exports carry. Until
//! 2026-11-24 the shape was guessed, in seven TypeScript files, with blind
//! casts and hedges:
//!
//! - `src/infra/storage/rust-vault-adapter.ts` declared
//!   `entries_json?` AND `entriesJson?`, `error_code?` AND `errorCode?`,
//!   `master_key?` AND `masterKey?` — and read
//!   `result.entries_json ?? result.entriesJson`. The contract was GUESSED,
//!   and the guess was written down twice.
//! - `src/infra/storage/rust-embed-adapter.ts` declared
//!   `RawEmbedStoreResult` and `RawEmbedSearchResult` by hand, and both
//!   were wrong: `normalized` is a STRING on the wire, not `boolean`.
//!
//! ## The measurement this table is built from
//!
//! Every row below was read off the BUILT bridge on the operator's host
//! (2026-11-24), not written from the Rust source. That matters, because
//! the source is not the truth about the wire:
//!
//! - `#[napi(object)]` structs speak in napi-rs's DEFAULT spelling —
//!   camelCase — unless a field carries `#[napi(js_name = "...")]`. So
//!   `JsEntriesResult { entries_json, entry, error_code }` reaches
//!   JavaScript as `entriesJson` and `errorCode`, while its sibling
//!   `JsVaultStateResult { error_code }` — which DOES carry an explicit
//!   `js_name` — reaches JavaScript as `error_code`.
//! - `Option` fields of a `#[napi(object)]` struct are OMITTED when they
//!   are `None`, not set to null. Measured: the error path of
//!   `vault_parse_entries` returns exactly one key (`errorCode`).
//! - The JSON-envelope family speaks snake_case, because that is what the
//!   `serde` structs in this crate serialize to — unless the struct says
//!   `#[serde(rename_all = "camelCase")]`, which is what the embed crate's
//!   `IndexMetadata` does.
//!
//! The TypeScript side no longer guesses: the projection
//! (`scripts/sync-bridge-payload-contract.mts`) reads this table from the
//! built module, writes the artefact
//! (`tests/fixtures/bridge-payload-contract.json`) and the TypeScript
//! mirror (`src/infra/storage/bridge-payloads.generated.ts`), and the two
//! runners check both sides against the artefact.
//!
//! ## The rule
//!
//! One row per export that carries a payload. A row names the export, the
//! way the payload travels, and the shape it has. Nothing about a payload
//! is written down twice: the TypeScript mirror is generated, and the
//! spelling on the wire is the spelling in this table.
//!
//! ## The second measurement: the embed family (2026-11-24)
//!
//! The vault family was measured first. The embed family was measured on
//! the same day, against an ISOLATED index (`RUST_EMBED_PERSIST_PATH`
//! pointed at a scratch directory, so the operator's own index was not
//! touched), and it found one thing the source does not say out loud:
//!
//! **`embed_discard_replacement` carries TWO shapes.** When the pipeline
//! was never initialized it answers
//! `{ discarded, was_initialized, replacement_state }` — three keys. When
//! it was initialized it answers SEVEN keys: the three above plus
//! `previous_replacement_state`, `count`, `persistence_enabled` and
//! `persistence_load_state`. The TypeScript side declared
//! `{ discarded: boolean }` and cast the rest away — it did not know
//! there was more. The shape is declared here with the four variant-only
//! keys marked OPTIONAL, and the payload is built from a struct
//! (`EmbedDiscardOut`) whose `#[serde(skip_serializing_if)]` keeps the
//! wire exactly as it was measured — absent, not null.
//!
//! ## The closed vocabularies
//!
//! Some fields cannot carry an arbitrary string: `normalized` is
//! `"true"` or `"provider-dependent"`, `persistence_load_state` is one of
//! five load states, the replacement state is one of three, and the index
//! metadata's `state` is one of six. A TypeScript side that does not know
//! that has to guess — and the guess shows up as a helper that maps
//! "whatever came" onto "whatever it meant".
//!
//! So the owner declares the vocabulary AND where it comes from: the
//! function whose string literals are the words. The gate
//! (`crates/memphis-napi/tests/bridge_payload_contract.rs`) parses that
//! function out of the crate's source and compares — every literal in it
//! must be a declared word, or be declared as an EXTRA (a literal that
//! is not a word of this field, like the provider name
//! `embed_normalized_to_str` compares against). The owner can therefore
//! neither invent a word the crate never writes, nor forget one it does.

use serde_json::{json, Value};

/// The type of one payload field.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PayloadType {
    /// A JSON string.
    String,
    /// A JSON number.
    Number,
    /// A JSON number that is always an integer.
    Integer,
    /// A JSON boolean.
    Boolean,
    /// A byte buffer — napi's `Buffer` in JavaScript.
    Bytes,
    /// Any JSON value.
    Json,
    /// A named shape from [`PAYLOAD_SHAPES`].
    Named(&'static str),
    /// A list of another type.
    Array(&'static PayloadType),
    /// A string with a CLOSED vocabulary — the words are in the field's
    /// [`Vocabulary`], and the gate checks them against the source that
    /// produces them.
    Enum,
}

/// The closed set of words one field can carry on the wire.
#[derive(Clone, Copy, Debug)]
pub struct Vocabulary {
    /// The words the field can carry.
    pub values: &'static [&'static str],
    /// The functions whose string literals ARE those words.
    ///
    /// The gate parses them out of the crate's source and compares: every
    /// literal in them must be a word of this field, or be declared in
    /// `extra_literals`.
    pub source_functions: &'static [&'static str],
    /// Literals in those functions that are NOT words of this field.
    ///
    /// `embed_normalized_to_str` compares the provider against the
    /// literal `"local-deterministic"` — that literal is not a word the
    /// field can carry, so it is declared here, and the comparison can
    /// stay exact.
    pub extra_literals: &'static [&'static str],
}

/// One field of a payload shape.
#[derive(Clone, Copy, Debug)]
pub struct PayloadField {
    /// The name the field carries ON THE WIRE — the JSON key for the
    /// envelope family, the property name for the native-object family.
    pub name: &'static str,
    pub ty: PayloadType,
    /// The key may be ABSENT.
    ///
    /// napi omits `None` fields of an `#[napi(object)]` struct; a serde
    /// `Option` inside an envelope is present and `null` instead (that is
    /// `nullable`, not `optional`); and a payload built from a literal
    /// may simply not carry a key at all — `embed_discard_replacement`
    /// does not, in its not-initialized variant.
    pub optional: bool,
    /// The key is present and may be `null`.
    pub nullable: bool,
    /// The spelling this field had in older binaries.
    ///
    /// MEASURED from the history, not guessed: commit `52ef4e2a56`
    /// ("refactor(bridge): stabilize napi contract naming", 2026-03-21)
    /// added `#[napi(js_name = "...")]` to `JsVault::master_key` and
    /// `JsVaultEntry::created_at`. Before it, napi-rs exported both in
    /// camelCase — `masterKey` and `createdAt`. Binaries that old are
    /// still in the field, so the compat is real; what was wrong was
    /// declaring it by hand in TypeScript, next to a guess.
    ///
    /// The legacy spelling is always the camelCase form of the Rust field
    /// name — the gate checks that.
    pub legacy_name: Option<&'static str>,
    /// The closed vocabulary of an enumerated field.
    pub vocabulary: Option<Vocabulary>,
}

/// A named payload shape.
#[derive(Clone, Copy, Debug)]
pub struct PayloadShape {
    /// The name the projection gives the shape in TypeScript.
    pub name: &'static str,
    /// How this shape's fields reach the wire — see [`PayloadNaming`].
    pub naming: PayloadNaming,
    /// The Rust struct this shape describes — the `#[napi(object)]` or the
    /// `serde` struct whose fields reach JavaScript under the names in
    /// `fields`.
    ///
    /// The gate (`crates/memphis-napi/tests/bridge_payload_contract.rs`)
    /// parses that struct out of the crate's source and checks the two
    /// against each other, so the table cannot drift from the struct it
    /// claims to describe.
    pub rust_type: &'static str,
    pub fields: &'static [PayloadField],
}

/// How a payload travels from Rust to JavaScript.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PayloadTransport {
    /// The function returns a JSON string; the payload is its `data`.
    EnvelopeJson,
    /// The function returns a JavaScript object.
    NativeObject,
    /// The function returns a byte buffer.
    Bytes,
}

impl PayloadTransport {
    pub fn as_str(self) -> &'static str {
        match self {
            PayloadTransport::EnvelopeJson => "envelopeJson",
            PayloadTransport::NativeObject => "nativeObject",
            PayloadTransport::Bytes => "bytes",
        }
    }
}

/// How a payload's field names reach the wire.
///
/// The bridge has two families, and they spell differently:
///
/// - a `#[napi(object)]` struct speaks napi-rs's rule — an explicit
///   `#[napi(js_name = "...")]` is used verbatim, a field without one is
///   exported in camelCase;
/// - a `serde` struct inside a JSON envelope speaks serde's rule —
///   `#[serde(rename_all = "camelCase")]` camelCases every field, a field
///   without it keeps its own name, and an explicit `#[serde(rename = "...")]`
///   is used verbatim.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PayloadNaming {
    NapiObject,
    Serde,
}

impl PayloadNaming {
    pub fn as_str(self) -> &'static str {
        match self {
            PayloadNaming::NapiObject => "napiObject",
            PayloadNaming::Serde => "serde",
        }
    }
}

/// One payload the bridge carries.
#[derive(Clone, Copy, Debug)]
pub struct BridgePayload {
    /// The canonical export name — the Rust function's name.
    pub export: &'static str,
    pub transport: PayloadTransport,
    /// The name of the shape in [`PAYLOAD_SHAPES`]. `None` for a payload
    /// that is not an object — a byte buffer carries no fields.
    pub shape: Option<&'static str>,
}

/// The vault object — the salt and the master key.
pub const VAULT_SHAPE: PayloadShape = PayloadShape {
    name: "VaultPayload",
    naming: PayloadNaming::NapiObject,
    rust_type: "JsVault",
    fields: &[
        PayloadField { name: "salt", ty: PayloadType::Bytes, optional: false, nullable: false, legacy_name: None, vocabulary: None },
        PayloadField { name: "master_key", ty: PayloadType::Bytes, optional: false, nullable: false, legacy_name: Some("masterKey"), vocabulary: None },
    ],
};

/// One stored vault entry.
pub const VAULT_ENTRY_SHAPE: PayloadShape = PayloadShape {
    name: "VaultEntryPayload",
    naming: PayloadNaming::NapiObject,
    rust_type: "JsVaultEntry",
    fields: &[
        PayloadField { name: "id", ty: PayloadType::String, optional: false, nullable: false, legacy_name: None, vocabulary: None },
        PayloadField { name: "key", ty: PayloadType::String, optional: false, nullable: false, legacy_name: None, vocabulary: None },
        PayloadField { name: "ciphertext", ty: PayloadType::Bytes, optional: false, nullable: false, legacy_name: None, vocabulary: None },
        PayloadField { name: "nonce", ty: PayloadType::Bytes, optional: false, nullable: false, legacy_name: None, vocabulary: None },
        PayloadField { name: "tag", ty: PayloadType::Bytes, optional: false, nullable: false, legacy_name: None, vocabulary: None },
        PayloadField { name: "created_at", ty: PayloadType::String, optional: false, nullable: false, legacy_name: Some("createdAt"), vocabulary: None },
    ],
};

/// `vault_init_full` — the new vault, its DID and the recovery question.
pub const VAULT_INIT_SHAPE: PayloadShape = PayloadShape {
    name: "VaultInitPayload",
    naming: PayloadNaming::NapiObject,
    rust_type: "JsVaultInitResult",
    fields: &[
        PayloadField { name: "vault", ty: PayloadType::Named("VaultPayload"), optional: false, nullable: false, legacy_name: None, vocabulary: None },
        PayloadField { name: "did", ty: PayloadType::String, optional: false, nullable: false, legacy_name: None, vocabulary: None },
        PayloadField { name: "qa_question", ty: PayloadType::String, optional: false, nullable: false, legacy_name: None, vocabulary: None },
    ],
};

/// `vault_load_state` — the persisted state, or the reason it is unreadable.
///
/// Measured on the error path: `error_code` and `error`. The `vault` and
/// `version` keys are absent there, because napi omits `None` fields.
pub const VAULT_LOAD_STATE_SHAPE: PayloadShape = PayloadShape {
    name: "VaultLoadStatePayload",
    naming: PayloadNaming::NapiObject,
    rust_type: "JsVaultStateResult",
    fields: &[
        PayloadField { name: "vault", ty: PayloadType::Named("VaultPayload"), optional: true, nullable: false, legacy_name: None, vocabulary: None },
        PayloadField { name: "version", ty: PayloadType::Integer, optional: true, nullable: false, legacy_name: None, vocabulary: None },
        PayloadField { name: "error_code", ty: PayloadType::String, optional: true, nullable: false, legacy_name: None, vocabulary: None },
        PayloadField { name: "error", ty: PayloadType::String, optional: true, nullable: false, legacy_name: None, vocabulary: None },
    ],
};

/// `vault_parse_entries` and `vault_decode_entry` — one shape, two exports.
///
/// MEASURED, and this is where the TypeScript side used to guess: this
/// struct does NOT carry `#[napi(js_name = ...)]`, so napi-rs exports its
/// fields in camelCase — `entriesJson` and `errorCode` — while its
/// sibling `JsVaultStateResult` (which DOES carry an explicit `js_name`)
/// exports `error_code`. The guess that hedged both spellings was not
/// laziness; it was one hand-written interface covering two different
/// payloads.
pub const VAULT_ENTRIES_SHAPE: PayloadShape = PayloadShape {
    name: "VaultEntriesPayload",
    naming: PayloadNaming::NapiObject,
    rust_type: "JsEntriesResult",
    fields: &[
        PayloadField { name: "entriesJson", ty: PayloadType::String, optional: true, nullable: false, legacy_name: None, vocabulary: None },
        PayloadField { name: "entry", ty: PayloadType::Named("VaultEntryPayload"), optional: true, nullable: false, legacy_name: None, vocabulary: None },
        PayloadField { name: "errorCode", ty: PayloadType::String, optional: true, nullable: false, legacy_name: None, vocabulary: None },
    ],
};

/// The words `normalized` can carry.
///
/// MEASURED: the wire always carries `"true"` or `"provider-dependent"` —
/// never `"false"`. The TypeScript side had a helper for a `"false"`
/// that cannot arrive, and a fallback for a missing value that cannot
/// arrive either.
const NORMALIZED_VOCABULARY: Vocabulary = Vocabulary {
    values: &["true", "provider-dependent"],
    source_functions: &["embed_normalized_to_str"],
    extra_literals: &["local-deterministic"],
};

/// The words `persistence_load_state` can carry.
const LOAD_STATE_VOCABULARY: Vocabulary = Vocabulary {
    values: &["disabled", "missing", "empty", "loaded", "corrupt"],
    source_functions: &["load_state_to_str"],
    extra_literals: &[],
};

/// The words the replacement state can carry.
const REPLACEMENT_STATE_VOCABULARY: Vocabulary = Vocabulary {
    values: &["idle", "armed", "failed"],
    source_functions: &["replacement_state_to_str"],
    extra_literals: &[],
};

/// The words the index metadata's `state` can carry.
///
/// MEASURED 2026-11-24 on the built module: `"empty"` for an index file
/// that exists and holds nothing. The other five come from the same
/// function that produced it.
///
/// The function also writes `"ndjson"` — the extension of the sibling
/// file it looks for. That literal is not a word of this field, so it is
/// declared as an extra: the comparison stays exact, and the owner has to
/// say so out loud.
const INDEX_STATE_VOCABULARY: Vocabulary = Vocabulary {
    values: &["missing", "unreadable", "empty", "corrupt", "degraded", "loaded"],
    source_functions: &["inspect_index"],
    extra_literals: &["ndjson"],
};

/// The words `dtype` can carry — the embed family always answers `f32`.
///
/// The five functions that write it also write one error code of their
/// own; it is not a dtype, so it is declared as an extra.
const DTYPE_VOCABULARY: Vocabulary = Vocabulary {
    values: &["f32"],
    source_functions: &[
        "embed_store",
        "embed_store_many",
        "embed_flush",
        "embed_search",
        "embed_search_tuned",
    ],
    extra_literals: &["embed_pipeline_lock_failed"],
};

/// `embed_store` — one document upserted.
pub const EMBED_STORE_SHAPE: PayloadShape = PayloadShape {
    name: "EmbedStorePayload",
    naming: PayloadNaming::Serde,
    rust_type: "EmbedStoreOut",
    fields: &[
        PayloadField { name: "id", ty: PayloadType::String, optional: false, nullable: false, legacy_name: None, vocabulary: None },
        PayloadField { name: "count", ty: PayloadType::Integer, optional: false, nullable: false, legacy_name: None, vocabulary: None },
        PayloadField { name: "dim", ty: PayloadType::Integer, optional: false, nullable: false, legacy_name: None, vocabulary: None },
        PayloadField { name: "dtype", ty: PayloadType::Enum, optional: false, nullable: false, legacy_name: None, vocabulary: Some(DTYPE_VOCABULARY) },
        PayloadField { name: "provider", ty: PayloadType::String, optional: false, nullable: false, legacy_name: None, vocabulary: None },
        PayloadField { name: "normalized", ty: PayloadType::Enum, optional: false, nullable: false, legacy_name: None, vocabulary: Some(NORMALIZED_VOCABULARY) },
        PayloadField { name: "persistence_enabled", ty: PayloadType::Boolean, optional: false, nullable: false, legacy_name: None, vocabulary: None },
        PayloadField { name: "persistence_load_state", ty: PayloadType::Enum, optional: false, nullable: false, legacy_name: None, vocabulary: Some(LOAD_STATE_VOCABULARY) },
    ],
};

/// `embed_store_many` — the bulk upsert's answer.
pub const EMBED_STORE_MANY_SHAPE: PayloadShape = PayloadShape {
    name: "EmbedStoreManyPayload",
    naming: PayloadNaming::Serde,
    rust_type: "EmbedStoreManyOut",
    fields: &[
        PayloadField { name: "inserted", ty: PayloadType::Integer, optional: false, nullable: false, legacy_name: None, vocabulary: None },
        PayloadField { name: "count", ty: PayloadType::Integer, optional: false, nullable: false, legacy_name: None, vocabulary: None },
        PayloadField { name: "dim", ty: PayloadType::Integer, optional: false, nullable: false, legacy_name: None, vocabulary: None },
        PayloadField { name: "dtype", ty: PayloadType::Enum, optional: false, nullable: false, legacy_name: None, vocabulary: Some(DTYPE_VOCABULARY) },
        PayloadField { name: "provider", ty: PayloadType::String, optional: false, nullable: false, legacy_name: None, vocabulary: None },
        PayloadField { name: "normalized", ty: PayloadType::Enum, optional: false, nullable: false, legacy_name: None, vocabulary: Some(NORMALIZED_VOCABULARY) },
        PayloadField { name: "persistence_enabled", ty: PayloadType::Boolean, optional: false, nullable: false, legacy_name: None, vocabulary: None },
    ],
};

/// `embed_flush` — the index was written to disk.
pub const EMBED_FLUSH_SHAPE: PayloadShape = PayloadShape {
    name: "EmbedFlushPayload",
    naming: PayloadNaming::Serde,
    rust_type: "EmbedFlushOut",
    fields: &[
        PayloadField { name: "flushed", ty: PayloadType::Boolean, optional: false, nullable: false, legacy_name: None, vocabulary: None },
        PayloadField { name: "dim", ty: PayloadType::Integer, optional: false, nullable: false, legacy_name: None, vocabulary: None },
        PayloadField { name: "dtype", ty: PayloadType::Enum, optional: false, nullable: false, legacy_name: None, vocabulary: Some(DTYPE_VOCABULARY) },
    ],
};

/// One search hit.
pub const EMBED_SEARCH_HIT_SHAPE: PayloadShape = PayloadShape {
    name: "EmbedSearchHitPayload",
    naming: PayloadNaming::Serde,
    rust_type: "EmbedSearchHitOut",
    fields: &[
        PayloadField { name: "id", ty: PayloadType::String, optional: false, nullable: false, legacy_name: None, vocabulary: None },
        PayloadField { name: "score", ty: PayloadType::Number, optional: false, nullable: false, legacy_name: None, vocabulary: None },
        PayloadField { name: "text_preview", ty: PayloadType::String, optional: false, nullable: false, legacy_name: None, vocabulary: None },
        PayloadField { name: "tags", ty: PayloadType::Array(&PayloadType::String), optional: false, nullable: false, legacy_name: None, vocabulary: None },
    ],
};

/// `embed_search` and `embed_search_tuned` — one shape, two exports.
pub const EMBED_SEARCH_SHAPE: PayloadShape = PayloadShape {
    name: "EmbedSearchPayload",
    naming: PayloadNaming::Serde,
    rust_type: "EmbedSearchOut",
    fields: &[
        PayloadField { name: "query", ty: PayloadType::String, optional: false, nullable: false, legacy_name: None, vocabulary: None },
        PayloadField { name: "count", ty: PayloadType::Integer, optional: false, nullable: false, legacy_name: None, vocabulary: None },
        PayloadField { name: "dim", ty: PayloadType::Integer, optional: false, nullable: false, legacy_name: None, vocabulary: None },
        PayloadField { name: "dtype", ty: PayloadType::Enum, optional: false, nullable: false, legacy_name: None, vocabulary: Some(DTYPE_VOCABULARY) },
        PayloadField { name: "provider", ty: PayloadType::String, optional: false, nullable: false, legacy_name: None, vocabulary: None },
        PayloadField { name: "normalized", ty: PayloadType::Enum, optional: false, nullable: false, legacy_name: None, vocabulary: Some(NORMALIZED_VOCABULARY) },
        PayloadField { name: "hits", ty: PayloadType::Array(&PayloadType::Named("EmbedSearchHitPayload")), optional: false, nullable: false, legacy_name: None, vocabulary: None },
    ],
};

/// `embed_clear_in_memory` — the in-memory index was dropped.
///
/// It used to be a `serde_json::json!({ "cleared": true })` literal — a
/// payload with no owner, which is how the TypeScript side ended up
/// hand-writing its shape. The struct makes the shape checkable.
pub const EMBED_CLEAR_SHAPE: PayloadShape = PayloadShape {
    name: "EmbedClearPayload",
    naming: PayloadNaming::Serde,
    rust_type: "EmbedClearOut",
    fields: &[
        PayloadField { name: "cleared", ty: PayloadType::Boolean, optional: false, nullable: false, legacy_name: None, vocabulary: None },
    ],
};

/// `embed_reset` — the index was reset, in memory and on disk.
///
/// Same wire as `embed_clear_in_memory`, different meaning: `embed_reset`
/// COMMITS the empty index to disk, `embed_clear_in_memory` does not.
/// They are two exports, so they are two rows — the shape is shared, the
/// meaning is not.
pub const EMBED_RESET_SHAPE: PayloadShape = PayloadShape {
    name: "EmbedResetPayload",
    naming: PayloadNaming::Serde,
    rust_type: "EmbedResetOut",
    fields: &[
        PayloadField { name: "cleared", ty: PayloadType::Boolean, optional: false, nullable: false, legacy_name: None, vocabulary: None },
    ],
};

/// `embed_discard_replacement` — a partial rebuild was dropped.
///
/// MEASURED: TWO shapes, not one. Without an initialized pipeline the
/// answer carries three keys (`discarded`, `was_initialized`,
/// `replacement_state`); with one it carries seven — the four below are
/// OPTIONAL, because they only exist in that second variant. The
/// TypeScript side declared `{ discarded: boolean }` and threw the other
/// six away without knowing they were there.
pub const EMBED_DISCARD_SHAPE: PayloadShape = PayloadShape {
    name: "EmbedDiscardPayload",
    naming: PayloadNaming::Serde,
    rust_type: "EmbedDiscardOut",
    fields: &[
        PayloadField { name: "discarded", ty: PayloadType::Boolean, optional: false, nullable: false, legacy_name: None, vocabulary: None },
        PayloadField { name: "was_initialized", ty: PayloadType::Boolean, optional: false, nullable: false, legacy_name: None, vocabulary: None },
        PayloadField { name: "previous_replacement_state", ty: PayloadType::Enum, optional: true, nullable: false, legacy_name: None, vocabulary: Some(REPLACEMENT_STATE_VOCABULARY) },
        PayloadField { name: "replacement_state", ty: PayloadType::Enum, optional: false, nullable: false, legacy_name: None, vocabulary: Some(REPLACEMENT_STATE_VOCABULARY) },
        PayloadField { name: "count", ty: PayloadType::Integer, optional: true, nullable: false, legacy_name: None, vocabulary: None },
        PayloadField { name: "persistence_enabled", ty: PayloadType::Boolean, optional: true, nullable: false, legacy_name: None, vocabulary: None },
        PayloadField { name: "persistence_load_state", ty: PayloadType::Enum, optional: true, nullable: false, legacy_name: None, vocabulary: Some(LOAD_STATE_VOCABULARY) },
    ],
};

/// `embed_index_metadata` — the index on disk.
///
/// MEASURED: `formatVersion` and `dimension` are NULL when the index is
/// missing or unreadable, and numbers when it is there. The struct lives
/// in the embed crate and speaks camelCase
/// (`#[serde(rename_all = "camelCase")]`).
pub const EMBED_INDEX_METADATA_SHAPE: PayloadShape = PayloadShape {
    name: "EmbedIndexMetadataPayload",
    naming: PayloadNaming::Serde,
    rust_type: "IndexMetadata",
    fields: &[
        PayloadField { name: "schemaVersion", ty: PayloadType::Integer, optional: false, nullable: false, legacy_name: None, vocabulary: None },
        PayloadField { name: "path", ty: PayloadType::String, optional: false, nullable: false, legacy_name: None, vocabulary: None },
        PayloadField { name: "formatVersion", ty: PayloadType::Integer, optional: false, nullable: true, legacy_name: None, vocabulary: None },
        PayloadField { name: "state", ty: PayloadType::Enum, optional: false, nullable: false, legacy_name: None, vocabulary: Some(INDEX_STATE_VOCABULARY) },
        PayloadField { name: "documents", ty: PayloadType::Integer, optional: false, nullable: false, legacy_name: None, vocabulary: None },
        PayloadField { name: "invalidRecords", ty: PayloadType::Integer, optional: false, nullable: false, legacy_name: None, vocabulary: None },
        PayloadField { name: "dimension", ty: PayloadType::Integer, optional: false, nullable: true, legacy_name: None, vocabulary: None },
        PayloadField { name: "sizeBytes", ty: PayloadType::Integer, optional: false, nullable: false, legacy_name: None, vocabulary: None },
    ],
};

/// Every payload shape, by name.
pub const PAYLOAD_SHAPES: &[PayloadShape] = &[
    VAULT_SHAPE,
    VAULT_ENTRY_SHAPE,
    VAULT_INIT_SHAPE,
    VAULT_LOAD_STATE_SHAPE,
    VAULT_ENTRIES_SHAPE,
    EMBED_STORE_SHAPE,
    EMBED_STORE_MANY_SHAPE,
    EMBED_FLUSH_SHAPE,
    EMBED_SEARCH_HIT_SHAPE,
    EMBED_SEARCH_SHAPE,
    EMBED_CLEAR_SHAPE,
    EMBED_RESET_SHAPE,
    EMBED_DISCARD_SHAPE,
    EMBED_INDEX_METADATA_SHAPE,
];

/// Every payload the bridge carries.
///
/// The vault family is here first because it is the family the TypeScript
/// side guessed hardest. The envelope families (chain, case, soul) follow
/// in the next phases of E-09; the ratchet in the gate counts what is
/// left.
pub const BRIDGE_PAYLOADS: &[BridgePayload] = &[
    BridgePayload {
        export: "vault_init_full",
        transport: PayloadTransport::NativeObject,
        shape: Some("VaultInitPayload"),
    },
    BridgePayload {
        export: "vault_load_state",
        transport: PayloadTransport::NativeObject,
        shape: Some("VaultLoadStatePayload"),
    },
    BridgePayload {
        export: "vault_parse_entries",
        transport: PayloadTransport::NativeObject,
        shape: Some("VaultEntriesPayload"),
    },
    BridgePayload {
        export: "vault_decode_entry",
        transport: PayloadTransport::NativeObject,
        shape: Some("VaultEntriesPayload"),
    },
    BridgePayload {
        export: "vault_store",
        transport: PayloadTransport::NativeObject,
        shape: Some("VaultEntryPayload"),
    },
    BridgePayload {
        export: "vault_retrieve",
        transport: PayloadTransport::Bytes,
        shape: None,
    },
    // The embed family — JSON envelopes whose payload is the `data` field.
    BridgePayload {
        export: "embed_store",
        transport: PayloadTransport::EnvelopeJson,
        shape: Some("EmbedStorePayload"),
    },
    BridgePayload {
        export: "embed_store_many",
        transport: PayloadTransport::EnvelopeJson,
        shape: Some("EmbedStoreManyPayload"),
    },
    BridgePayload {
        export: "embed_flush",
        transport: PayloadTransport::EnvelopeJson,
        shape: Some("EmbedFlushPayload"),
    },
    BridgePayload {
        export: "embed_search",
        transport: PayloadTransport::EnvelopeJson,
        shape: Some("EmbedSearchPayload"),
    },
    BridgePayload {
        export: "embed_search_tuned",
        transport: PayloadTransport::EnvelopeJson,
        shape: Some("EmbedSearchPayload"),
    },
    BridgePayload {
        export: "embed_clear_in_memory",
        transport: PayloadTransport::EnvelopeJson,
        shape: Some("EmbedClearPayload"),
    },
    BridgePayload {
        export: "embed_reset",
        transport: PayloadTransport::EnvelopeJson,
        shape: Some("EmbedResetPayload"),
    },
    BridgePayload {
        export: "embed_discard_replacement",
        transport: PayloadTransport::EnvelopeJson,
        shape: Some("EmbedDiscardPayload"),
    },
    BridgePayload {
        export: "embed_index_metadata",
        transport: PayloadTransport::EnvelopeJson,
        shape: Some("EmbedIndexMetadataPayload"),
    },
];

fn field_type(ty: PayloadType) -> Value {
    match ty {
        PayloadType::String => json!({ "kind": "string" }),
        PayloadType::Number => json!({ "kind": "number" }),
        PayloadType::Integer => json!({ "kind": "integer" }),
        PayloadType::Boolean => json!({ "kind": "boolean" }),
        PayloadType::Bytes => json!({ "kind": "bytes" }),
        PayloadType::Json => json!({ "kind": "json" }),
        PayloadType::Named(name) => json!({ "kind": "named", "name": name }),
        PayloadType::Array(inner) => json!({ "kind": "array", "of": field_type(*inner) }),
        PayloadType::Enum => json!({ "kind": "enum" }),
    }
}

fn render_vocabulary(vocabulary: &Vocabulary) -> Value {
    json!({
        "values": vocabulary.values,
        "sourceFunctions": vocabulary.source_functions,
        "extraLiterals": vocabulary.extra_literals,
    })
}

fn render_shape(shape: &PayloadShape) -> Value {
    json!({
        "name": shape.name,
        "naming": shape.naming.as_str(),
        "rustType": shape.rust_type,
        "fields": shape
            .fields
            .iter()
            .map(|field| {
                json!({
                    "name": field.name,
                    "type": field_type(field.ty),
                    "optional": field.optional,
                    "nullable": field.nullable,
                    "legacyName": field.legacy_name,
                    "vocabulary": field.vocabulary.as_ref().map(render_vocabulary),
                })
            })
            .collect::<Vec<Value>>(),
    })
}

/// The manifest the bridge serves: this table, rendered as JSON.
///
/// The projection reads it from the BUILT module, exactly like
/// `bridge_manifest` for the export vocabulary — so the table cannot
/// describe a bridge that is not there.
pub fn manifest() -> Value {
    json!({
        "name": "memphis-napi",
        "schemaVersion": 2,
        "owner": "crates/memphis-napi/src/bridge_payloads.rs",
        "shapes": PAYLOAD_SHAPES.iter().map(render_shape).collect::<Vec<Value>>(),
        "payloads": BRIDGE_PAYLOADS
            .iter()
            .map(|payload| {
                json!({
                    "export": payload.export,
                    "transport": payload.transport.as_str(),
                    "shape": payload.shape,
                })            })
            .collect::<Vec<Value>>(),
    })
}

/// The shape a payload names, if the table has it.
pub fn shape_of(name: &str) -> Option<&'static PayloadShape> {
    PAYLOAD_SHAPES.iter().find(|shape| shape.name == name)
}
