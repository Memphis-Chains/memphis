//! The bridge's export vocabulary is checked against the crate's own
//! declarations.
//!
//! ## Why this gate exists
//!
//! The vocabulary used to live in a hand-written list inside `bridge_manifest()`
//! and in a hand-written alias map in TypeScript, and nothing compared either
//! with the code they described. Measured 2026-11-23 on the operator's host:
//! the built module exports **37** functions, the manifest named **34**, and
//! nine of the names it did give were spellings the bridge never exports.
//!
//! ## What this gate asks
//!
//! Every `#[napi]` function this crate declares must be in
//! `bridge_exports::BRIDGE_EXPORTS`, with the JavaScript name napi-rs will
//! actually export:
//!
//! - an explicit `js_name` is used verbatim;
//! - a function without one is exported in camelCase.
//!
//! The table therefore cannot drift from the code, and the TypeScript side
//! (which reads the manifest) cannot invent a name the bridge does not have.
//!
//! The camelCase rule is checked here AND against the built binary by
//! `tests/unit/bridge-export-contract.test.ts`, so neither side has to be
//! trusted alone.

use memphis_napi::bridge_exports::BRIDGE_EXPORTS;

/// One `#[napi]` function declaration found in the crate's sources.
#[derive(Debug)]
struct Declaration {
    canonical: String,
    js_name: Option<String>,
}

/// The napi-rs conversion for a function without an explicit `js_name`.
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

/// Parse the `#[napi]` function declarations out of one source file.
///
/// A line-based scan, deliberately: the attribute always sits directly above
/// its function, and the crate's other `#[napi(...)]` attributes are either
/// `#[napi(object)]` on a struct or a field rename inside one.
fn parse_declarations(source: &str) -> Vec<Declaration> {
    let mut pending: Option<String> = None;
    let mut declarations = Vec::new();

    for line in source.lines() {
        let trimmed = line.trim();

        if trimmed.starts_with("#[napi") {
            pending = Some(trimmed.to_string());
            continue;
        }

        if let Some(rest) = trimmed.strip_prefix("pub fn ") {
            let canonical = rest
                .split('(')
                .next()
                .unwrap_or_default()
                .trim()
                .to_string();
            if let Some(attribute) = pending.take() {
                if attribute.contains("object") {
                    // A struct of named fields, not a function export.
                    continue;
                }
                let js_name = attribute.split("js_name").nth(1).and_then(|tail| {
                    tail.split('"')
                        .nth(1)
                        .map(|value| value.to_string())
                });
                declarations.push(Declaration { canonical, js_name });
            }
            continue;
        }

        if trimmed.starts_with("pub struct")
            || trimmed.starts_with("pub enum")
            || trimmed.starts_with("struct ")
            || trimmed.starts_with("enum ")
            || trimmed.starts_with("impl ")
        {
            pending = None;
        }
    }

    declarations
}

fn crate_declarations() -> Vec<Declaration> {
    let mut declarations = parse_declarations(include_str!("../src/lib.rs"));
    declarations.extend(parse_declarations(include_str!("../src/vault_bridge.rs")));
    declarations
}

#[test]
fn every_declared_export_is_in_the_table() {
    let declarations = crate_declarations();
    assert!(
        !declarations.is_empty(),
        "no #[napi] declarations found — the parser is broken, not the crate"
    );

    let table: Vec<&str> = BRIDGE_EXPORTS
        .iter()
        .map(|export| export.canonical)
        .collect();

    let missing: Vec<&String> = declarations
        .iter()
        .filter(|declaration| !table.contains(&declaration.canonical.as_str()))
        .map(|declaration| &declaration.canonical)
        .collect();
    assert!(
        missing.is_empty(),
        "the table is missing exports the crate declares: {missing:?}"
    );

    let declared: Vec<&str> = declarations
        .iter()
        .map(|declaration| declaration.canonical.as_str())
        .collect();
    let extra: Vec<&&str> = table.iter().filter(|name| !declared.contains(name)).collect();
    assert!(
        extra.is_empty(),
        "the table lists exports the crate does not declare: {extra:?}"
    );
}

#[test]
fn every_export_carries_the_name_napi_will_export() {
    for declaration in crate_declarations() {
        let export = BRIDGE_EXPORTS
            .iter()
            .find(|export| export.canonical == declaration.canonical)
            .unwrap_or_else(|| panic!("{} is not in the table", declaration.canonical));

        let expected = match &declaration.js_name {
            Some(explicit) => explicit.clone(),
            None => camel_case(&declaration.canonical),
        };
        assert_eq!(
            export.js_name, expected,
            "{}: the table says {}, napi-rs will export {expected}",
            declaration.canonical, export.js_name
        );
    }
}

#[test]
fn the_required_exports_are_a_subset_of_the_declared_ones() {
    let declared: Vec<String> = crate_declarations()
        .into_iter()
        .map(|declaration| declaration.canonical)
        .collect();

    for export in BRIDGE_EXPORTS.iter().filter(|export| export.required) {
        assert!(
            declared.contains(&export.canonical.to_string()),
            "{} is marked required but the crate does not declare it",
            export.canonical
        );
    }
}

/// The exports the runtime cannot work without.
///
/// This is the FLOOR, and it is written here on purpose. The `required` flag
/// in the table is a POLICY, so nothing else can check it: the projection
/// copies it, and the binary reports it back. Without a floor, flipping one
/// flag to `false` would change what the runtime demands without anything
/// noticing — and the projection would faithfully carry the mistake into the
/// artefact.
///
/// Relaxing the floor is a deliberate change to this gate, not a quiet edit
/// in the table.
const REQUIRED_FLOOR: &[&str] = &[
    "bridge_manifest",
    "chain_append",
    "chain_query",
    "chain_validate",
    "embed_search",
    "embed_store",
    "embed_shutdown",
    "vault_store",
    "vault_retrieve",
];

#[test]
fn the_floor_is_still_required() {
    for name in REQUIRED_FLOOR {
        let export = BRIDGE_EXPORTS
            .iter()
            .find(|export| export.canonical == *name)
            .unwrap_or_else(|| panic!("{name} is missing from the table"));
        assert!(
            export.required,
            "{name} is in the required floor but the table marks it optional"
        );
    }
}

#[test]
fn the_table_is_not_empty_and_covers_the_core() {
    assert!(BRIDGE_EXPORTS.len() >= 30, "the table lost its exports");
    for core in [
        "bridge_manifest",
        "chain_append",
        "chain_query",
        "chain_validate",
        "embed_search",
        "embed_store",
    ] {
        assert!(
            BRIDGE_EXPORTS.iter().any(|export| export.canonical == core),
            "{core} is missing from the table"
        );
    }
}
