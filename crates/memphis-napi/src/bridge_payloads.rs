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
//!   `serde` structs in this crate serialize to.
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
}

/// One field of a payload shape.
#[derive(Clone, Copy, Debug)]
pub struct PayloadField {
    /// The name the field carries ON THE WIRE — the JSON key for the
    /// envelope family, the property name for the native-object family.
    pub name: &'static str,
    pub ty: PayloadType,
    /// The key may be ABSENT. napi omits `None` fields of an
    /// `#[napi(object)]` struct; a serde `Option` inside an envelope is
    /// present and `null` instead, which is `nullable` and not
    /// `optional`.
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
}

/// A named payload shape.
#[derive(Clone, Copy, Debug)]
pub struct PayloadShape {
    /// The name the projection gives the shape in TypeScript.
    pub name: &'static str,
    /// The Rust struct this shape describes — the `#[napi(object)]` whose
    /// fields reach JavaScript under the names in `fields`.
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
    rust_type: "JsVault",
    fields: &[
        PayloadField { name: "salt", ty: PayloadType::Bytes, optional: false, nullable: false, legacy_name: None },
        PayloadField { name: "master_key", ty: PayloadType::Bytes, optional: false, nullable: false, legacy_name: Some("masterKey") },
    ],
};

/// One stored vault entry.
pub const VAULT_ENTRY_SHAPE: PayloadShape = PayloadShape {
    name: "VaultEntryPayload",
    rust_type: "JsVaultEntry",
    fields: &[
        PayloadField { name: "id", ty: PayloadType::String, optional: false, nullable: false, legacy_name: None },
        PayloadField { name: "key", ty: PayloadType::String, optional: false, nullable: false, legacy_name: None },
        PayloadField { name: "ciphertext", ty: PayloadType::Bytes, optional: false, nullable: false, legacy_name: None },
        PayloadField { name: "nonce", ty: PayloadType::Bytes, optional: false, nullable: false, legacy_name: None },
        PayloadField { name: "tag", ty: PayloadType::Bytes, optional: false, nullable: false, legacy_name: None },
        PayloadField { name: "created_at", ty: PayloadType::String, optional: false, nullable: false, legacy_name: Some("createdAt") },
    ],
};

/// `vault_init_full` — the new vault, its DID and the recovery question.
pub const VAULT_INIT_SHAPE: PayloadShape = PayloadShape {
    name: "VaultInitPayload",
    rust_type: "JsVaultInitResult",
    fields: &[
        PayloadField { name: "vault", ty: PayloadType::Named("VaultPayload"), optional: false, nullable: false, legacy_name: None },
        PayloadField { name: "did", ty: PayloadType::String, optional: false, nullable: false, legacy_name: None },
        PayloadField { name: "qa_question", ty: PayloadType::String, optional: false, nullable: false, legacy_name: None },
    ],
};

/// `vault_load_state` — the persisted state, or the reason it is unreadable.
///
/// Measured on the error path: `error_code` and `error`. The `vault` and
/// `version` keys are absent there, because napi omits `None` fields.
pub const VAULT_LOAD_STATE_SHAPE: PayloadShape = PayloadShape {
    name: "VaultLoadStatePayload",
    rust_type: "JsVaultStateResult",
    fields: &[
        PayloadField { name: "vault", ty: PayloadType::Named("VaultPayload"), optional: true, nullable: false, legacy_name: None },
        PayloadField { name: "version", ty: PayloadType::Integer, optional: true, nullable: false, legacy_name: None },
        PayloadField { name: "error_code", ty: PayloadType::String, optional: true, nullable: false, legacy_name: None },
        PayloadField { name: "error", ty: PayloadType::String, optional: true, nullable: false, legacy_name: None },
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
    rust_type: "JsEntriesResult",
    fields: &[
        PayloadField { name: "entriesJson", ty: PayloadType::String, optional: true, nullable: false, legacy_name: None },
        PayloadField { name: "entry", ty: PayloadType::Named("VaultEntryPayload"), optional: true, nullable: false, legacy_name: None },
        PayloadField { name: "errorCode", ty: PayloadType::String, optional: true, nullable: false, legacy_name: None },
    ],
};

/// Every payload shape, by name.
pub const PAYLOAD_SHAPES: &[PayloadShape] = &[
    VAULT_SHAPE,
    VAULT_ENTRY_SHAPE,
    VAULT_INIT_SHAPE,
    VAULT_LOAD_STATE_SHAPE,
    VAULT_ENTRIES_SHAPE,
];

/// Every payload the bridge carries.
///
/// The vault family is here first because it is the family the TypeScript
/// side guessed hardest. The envelope families (embed, chain, case, soul)
/// follow in the next phase of E-09; the ratchet in the gate counts what
/// is left.
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
    }
}

fn render_shape(shape: &PayloadShape) -> Value {
    json!({
        "name": shape.name,
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
        "schemaVersion": 1,
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
