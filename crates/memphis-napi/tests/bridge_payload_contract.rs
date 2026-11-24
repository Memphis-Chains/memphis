//! The bridge's payload shapes are checked against the crate's own
//! `#[napi(object)]` structs, and against the artefact both arms share.
//!
//! ## Why this gate exists
//!
//! E-01 gave the bridge's export vocabulary one owner. The SHAPE of what
//! those exports carry was still guessed, in seven TypeScript files:
//!
//! - `rust-vault-adapter.ts` declared `entries_json?` AND `entriesJson?`,
//!   `error_code?` AND `errorCode?`, `master_key?` AND `masterKey?`, and
//!   read `result.entries_json ?? result.entriesJson`;
//! - `rust-embed-adapter.ts` declared `RawEmbedStoreResult` by hand, with
//!   `normalized?: boolean | string` — on the wire `normalized` is a
//!   STRING, always.
//!
//! The hedge was not caution. It was the truth about the wire, discovered
//! the hard way: a `#[napi(object)]` struct with an explicit
//! `#[napi(js_name = "...")]` speaks snake_case, one without it speaks
//! camelCase. Measured 2026-11-24 on the built module:
//! `vault_load_state` returns `error_code`, `vault_decode_entry` returns
//! `errorCode`.
//!
//! ## What this gate asks
//!
//! 1. Every field in a shape is the name napi-rs will really export for
//!    the struct the shape claims to describe — an explicit `js_name` is
//!    used verbatim, a field without one is exported in camelCase.
//! 2. Every payload names a shape that exists, and an export the crate
//!    really declares.
//! 3. The artefact (`tests/fixtures/bridge-payload-contract.json`) is
//!    exactly what the owner's table says. The TypeScript arm reads the
//!    same artefact, so neither arm can change it alone.
//!
//! The camelCase rule is checked here AND against the built binary by
//! `tests/unit/bridge-payload-contract.test.ts`, so neither side has to be
//! trusted alone.

use std::fs;

use memphis_napi::bridge_exports::BRIDGE_EXPORTS;
use memphis_napi::bridge_payloads::{BRIDGE_PAYLOADS, PAYLOAD_SHAPES, PayloadType};

/// One field of a `#[napi(object)]` struct, as the crate declares it.
#[derive(Debug)]
struct StructField {
    name: String,
    js_name: Option<String>,
}

/// One `#[napi(object)]` struct, as the crate declares it.
#[derive(Debug)]
struct NapiStruct {
    name: String,
    fields: Vec<StructField>,
}

/// The napi-rs conversion for a field without an explicit `js_name`.
fn camel_case(name: &str) -> String {
    let mut parts = name.split('_');
    let mut out = String::from(parts.next().unwrap_or_default());
    for part in parts {
        let mut chars = part.chars();
        if let Some(first) = chars.next() {
            out.extend(first.to_uppercase());
            out.push_str(chars.as_str());
        }
    }
    out
}

/// Parse the `#[napi(object)]` structs out of one source file.
///
/// A line-based scan, deliberately: the attribute always sits directly above
/// the struct, and a field rename is the only attribute inside one.
fn parse_napi_objects(source: &str) -> Vec<NapiStruct> {
    let mut structs: Vec<NapiStruct> = Vec::new();
    let mut pending_object = false;
    let mut current: Option<NapiStruct> = None;
    let mut pending_js_name: Option<String> = None;

    for line in source.lines() {
        let trimmed = line.trim();

        if trimmed.starts_with("#[napi") {
            if trimmed.contains("object") {
                pending_object = true;
            } else if let Some(rest) = trimmed.split("js_name").nth(1) {
                // A field rename — but only a field carries one inside a
                // struct. A function's `js_name` (this crate has many) must
                // never leak into the next struct that follows it.
                if current.is_some() {
                    pending_js_name = rest.split('"').nth(1).map(|value| value.to_string());
                }
            }
            continue;
        }

        if let Some(rest) = trimmed.strip_prefix("pub struct ") {
            let name = rest
                .split(['<', ' '])
                .next()
                .unwrap_or_default()
                .trim()
                .to_string();
            if pending_object {
                current = Some(NapiStruct { name, fields: Vec::new() });
                pending_object = false;
            }
            continue;
        }

        if let Some(rest) = trimmed.strip_prefix("pub ") {
            let rest = rest.trim_start();
            if rest.starts_with("fn ") {
                // A method inside the struct's `impl` block — not a field.
                continue;
            }
            if rest.starts_with(':') {
                continue;
            }
            let name = rest
                .split([':', ' ', ',', '<'])
                .next()
                .unwrap_or_default()
                .trim()
                .to_string();
            if let Some(structure) = current.as_mut() {
                structure.fields.push(StructField {
                    name,
                    js_name: pending_js_name.take(),
                });
            }
            continue;        }

        if trimmed.starts_with('}') {
            if let Some(structure) = current.take() {
                structs.push(structure);
            }
        }
    }

    structs
}

fn crate_objects() -> Vec<NapiStruct> {
    let mut objects = parse_napi_objects(include_str!("../src/vault_bridge.rs"));
    objects.extend(parse_napi_objects(include_str!("../src/lib.rs")));
    objects
}

fn artefact_path() -> String {
    // The artefact lives at the repository root, two levels up from
    // `crates/memphis-napi/tests/`.
    let mut path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    path.pop();
    path.pop();
    path.push("tests/fixtures/bridge-payload-contract.json");
    path.to_string_lossy().to_string()
}

#[test]
fn every_shape_field_is_the_name_napi_will_export() {
    let objects = crate_objects();
    assert!(
        !objects.is_empty(),
        "no #[napi(object)] structs found — the parser is broken, not the crate"
    );

    for shape in PAYLOAD_SHAPES {
        let structure = objects
            .iter()
            .find(|object| object.name == shape.rust_type)
            .unwrap_or_else(|| {
                panic!(
                    "shape {} claims to describe {}, and the crate does not declare it",
                    shape.name, shape.rust_type
                )
            });

        assert_eq!(
            structure.fields.len(),
            shape.fields.len(),
            "{}: the struct has {} fields, the table has {}",
            shape.name,
            structure.fields.len(),
            shape.fields.len()
        );

        for (parsed, declared) in structure.fields.iter().zip(shape.fields.iter()) {
            // The name napi-rs will export: an explicit `js_name` verbatim,
            // a field without one in camelCase.
            let expected = match &parsed.js_name {
                Some(explicit) => explicit.clone(),
                None => camel_case(&parsed.name),
            };
            assert_eq!(
                declared.name, expected,
                "{}: the table says {}, but napi-rs will export {expected} for {}.{}",
                shape.name, declared.name, shape.rust_type, parsed.name
            );

            // A legacy spelling is not a guess either: it is the camelCase
            // form of the Rust field name — what napi-rs exported BEFORE the
            // naming stabilization added the explicit `js_name`. Anything
            // else is a spelling no binary ever had.
            if let Some(legacy) = declared.legacy_name {
                assert_eq!(
                    legacy,
                    camel_case(&parsed.name),
                    "{}: the legacy spelling of {}.{} is {}, but napi-rs exported {} before the naming stabilization",
                    shape.name,
                    shape.rust_type,
                    parsed.name,
                    legacy,
                    camel_case(&parsed.name)
                );
                assert_ne!(
                    legacy, declared.name,
                    "{}: the legacy spelling of {} is the same as the current one",
                    shape.name, declared.name
                );
            }
        }
    }
}

#[test]
fn every_payload_names_a_shape_and_a_real_export() {
    for payload in BRIDGE_PAYLOADS {
        if let Some(shape) = payload.shape {
            assert!(
                PAYLOAD_SHAPES.iter().any(|candidate| candidate.name == shape),
                "{}: the shape {shape} does not exist",
                payload.export
            );
        }
        assert!(
            BRIDGE_EXPORTS
                .iter()
                .any(|export| export.canonical == payload.export),
            "{}: the table describes a payload of an export the bridge does not have",
            payload.export
        );
    }
}

#[test]
fn every_named_field_type_resolves() {
    for shape in PAYLOAD_SHAPES {
        for field in shape.fields {
            if let PayloadType::Named(name) = field.ty {
                assert!(
                    PAYLOAD_SHAPES.iter().any(|candidate| candidate.name == name),
                    "{}: the field {} names the unknown shape {name}",
                    shape.name,
                    field.name
                );
            }
        }
    }
}

#[test]
fn the_artefact_is_what_the_table_says() {
    let path = artefact_path();
    let raw = fs::read_to_string(&path).unwrap_or_else(|error| {
        panic!(
            "the payload artefact is missing at {path} — run `npm run -s ops:sync-bridge-payload-contract`: {error}"
        )
    });
    let artefact: serde_json::Value =
        serde_json::from_str(&raw).unwrap_or_else(|error| panic!("the artefact is not JSON: {error}"));

    let shapes = artefact
        .get("shapes")
        .and_then(|value| value.as_array())
        .unwrap_or_else(|| panic!("the artefact carries no shapes"));
    let payloads = artefact
        .get("payloads")
        .and_then(|value| value.as_array())
        .unwrap_or_else(|| panic!("the artefact carries no payloads"));

    assert_eq!(
        shapes.len(),
        PAYLOAD_SHAPES.len(),
        "the artefact has {} shapes, the table has {}",
        shapes.len(),
        PAYLOAD_SHAPES.len()
    );
    assert_eq!(
        payloads.len(),
        BRIDGE_PAYLOADS.len(),
        "the artefact has {} payloads, the table has {}",
        payloads.len(),
        BRIDGE_PAYLOADS.len()
    );

    for shape in PAYLOAD_SHAPES {
        let entry = shapes
            .iter()
            .find(|entry| entry.get("name").and_then(|value| value.as_str()) == Some(shape.name))
            .unwrap_or_else(|| panic!("the artefact has no shape {}", shape.name));

        assert_eq!(
            entry.get("rustType").and_then(|value| value.as_str()),
            Some(shape.rust_type),
            "the artefact's shape {} names a different Rust struct",
            shape.name
        );

        let fields = entry
            .get("fields")
            .and_then(|value| value.as_array())
            .unwrap_or_else(|| panic!("the artefact's shape {} has no fields", shape.name));
        assert_eq!(
            fields.len(),
            shape.fields.len(),
            "the artefact's shape {} has {} fields, the table has {}",
            shape.name,
            fields.len(),
            shape.fields.len()
        );

        for (field, declared) in fields.iter().zip(shape.fields.iter()) {
            assert_eq!(
                field.get("name").and_then(|value| value.as_str()),
                Some(declared.name),
                "the artefact's shape {} names a different field",
                shape.name
            );
        }
    }

    for payload in BRIDGE_PAYLOADS {
        let entry = payloads
            .iter()
            .find(|entry| {
                entry.get("export").and_then(|value| value.as_str()) == Some(payload.export)
            })
            .unwrap_or_else(|| panic!("the artefact has no payload {}", payload.export));

        assert_eq!(
            entry.get("transport").and_then(|value| value.as_str()),
            Some(payload.transport.as_str()),
            "the artefact's payload {} names a different transport",
            payload.export
        );
    }
}

#[test]
fn the_table_is_not_empty_and_covers_the_vault_family() {
    assert!(
        BRIDGE_PAYLOADS.len() >= 6,
        "the table lost its payloads"
    );
    for export in [
        "vault_init_full",
        "vault_load_state",
        "vault_parse_entries",
        "vault_decode_entry",
        "vault_store",
        "vault_retrieve",
    ] {
        assert!(
            BRIDGE_PAYLOADS.iter().any(|payload| payload.export == export),
            "{export} is missing from the table"
        );
    }
}
