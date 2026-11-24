//! The bridge's payload shapes are checked against the crate's own
//! structs, against the source that produces the words, and against the
//! artefact both arms share.
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
//! 1. Every field in a shape is the name the wire really carries for the
//!    struct the shape claims to describe — and the two families are
//!    spelled by two different rules:
//!    - a `#[napi(object)]` struct: an explicit `js_name` is used
//!      verbatim, a field without one is exported in camelCase;
//!    - a `serde` struct inside a JSON envelope: `rename_all =
//!      "camelCase"` camelCases every field, a field without a rule
//!      keeps its own name, an explicit `rename` is used verbatim.
//! 2. The TYPE of every field is the type the struct declares — a
//!    `usize` is an integer, a `Vec<String>` is a list of strings, a
//!    named struct is the shape that struct is.
//! 3. The PRESENCE of every field is right: a napi `Option` is omitted
//!    when it is `None` (optional), a serde `Option` is present and
//!    `null` (nullable), and a `skip_serializing_if` field is absent
//!    (optional).
//! 4. The CLOSED VOCABULARY of every enumerated field is exactly the set
//!    of string literals in the function that produces it — so the owner
//!    can neither invent a word the crate never writes, nor forget one
//!    it does.
//! 5. Every payload names a shape that exists, and an export the crate
//!    really declares.
//! 6. The artefact (`tests/fixtures/bridge-payload-contract.json`) is
//!    exactly what the owner's table says. The TypeScript arm reads the
//!    same artefact, so neither arm can change it alone.
//!
//! The camelCase rule is checked here AND against the built binary by
//! `tests/unit/bridge-payload-contract.test.ts`, so neither side has to be
//! trusted alone.

use std::collections::BTreeSet;
use std::fs;

use memphis_napi::bridge_exports::BRIDGE_EXPORTS;
use memphis_napi::bridge_payloads::{
    BRIDGE_PAYLOADS, PAYLOAD_SHAPES, PayloadNaming, PayloadType, Vocabulary,
};

// ---------------------------------------------------------------------------
// The source of truth: the crate's own structs.
// ---------------------------------------------------------------------------

/// Which convention a struct speaks.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum StructKind {
    /// A `#[napi(object)]` struct — napi-rs's naming rule.
    NapiObject,
    /// A plain `serde` struct — serde's naming rule.
    Serde,
}

/// One field of a struct, as the crate declares it.
#[derive(Debug, Clone)]
struct SourceField {
    name: String,
    /// The Rust type as written — `String`, `Option<u32>`, `Vec<String>`.
    type_text: String,
    /// The explicit `#[napi(js_name = "...")]`, if the field has one.
    js_name: Option<String>,
    /// The explicit `#[serde(rename = "...")]`, if the field has one.
    serde_rename: Option<String>,
    /// The field carries `#[serde(skip_serializing_if = "...")]`.
    skip_serializing_if: bool,
}

/// One struct, as the crate declares it.
#[derive(Debug)]
struct SourceStruct {
    name: String,
    kind: StructKind,
    /// The struct-level `#[serde(rename_all = "...")]`.
    rename_all: Option<String>,
    fields: Vec<SourceField>,
}

/// One function, as the crate declares it — with its string literals.
#[derive(Debug)]
struct SourceFunction {
    name: String,
    /// The string literals in the body, minus the format strings.
    literals: Vec<String>,
}

/// One enum, as the crate declares it.
#[derive(Debug)]
struct SourceEnum {
    name: String,
    /// The enum-level `#[serde(rename_all = "...")]`.
    rename_all: Option<String>,
    /// The enum-level `#[serde(tag = "...")]` — the key the wire carries
    /// the variant name in.
    tag: Option<String>,
    /// The variants, in declaration order.
    variants: Vec<SourceVariant>,
    /// The `#[serde(alias = "...")]` values on the variants — read-side
    /// compatibility, never words the wire writes.
    aliases: Vec<String>,
}

/// One variant of an enum.
#[derive(Debug)]
struct SourceVariant {
    name: String,
    /// The fields of a STRUCT variant, in declaration order. A unit
    /// variant has none.
    fields: Vec<SourceField>,
}

/// The string value of an attribute key — `rename_all = "snake_case"`
/// yields `snake_case`.
fn attr_string(text: &str, key: &str) -> Option<String> {
    let rest = text.split(key).nth(1)?;
    rest.split('"').nth(1).map(|value| value.to_string())
}

/// Split a piece of Rust source at the commas that are NOT inside a
/// bracket, a brace or a parenthesis.
///
/// The enum body needs this: a variant's attribute list carries commas
/// of its own (`#[serde(alias = "a", alias = "b")]`), and a struct
/// variant's fields are separated by commas too.
fn split_top_level_commas(text: &str) -> Vec<String> {
    let mut parts = Vec::new();
    let mut current = String::new();
    let mut depth = 0i32;

    for ch in text.chars() {
        match ch {
            '{' | '[' | '(' => {
                depth += 1;
                current.push(ch);
            }
            '}' | ']' | ')' => {
                depth -= 1;
                current.push(ch);
            }
            ',' if depth == 0 => {
                parts.push(current.clone());
                current.clear();
            }
            _ => current.push(ch),
        }
    }

    if !current.trim().is_empty() {
        parts.push(current);
    }

    parts
}

/// The attribute blocks in a piece of source — `#[serde(...)]` and the
/// rest — and the text with them removed.
fn split_attributes(text: &str) -> (Vec<String>, String) {
    let mut attributes = Vec::new();
    let mut rest = String::new();
    let mut chars = text.chars().peekable();

    while let Some(ch) = chars.peek() {
        if *ch == '#' {
            let mut attribute = String::new();
            // The attribute block: `#[` … `]`, with the brackets counted
            // so a nested one does not end it early.
            let mut depth = 0i32;
            while let Some(inner) = chars.next() {
                attribute.push(inner);
                match inner {
                    '[' => depth += 1,
                    ']' => {
                        depth -= 1;
                        if depth == 0 {
                            break;
                        }
                    }
                    _ => {}
                }
            }
            attributes.push(attribute);
            continue;
        }
        rest.push(*ch);
        chars.next();
    }

    (attributes, rest)
}

/// Remove the comments from a piece of Rust source, leaving the string
/// literals alone.
///
/// An enum body carries its history in comments — `BlockType` explains
/// its fourteen read-side aliases in seven lines of prose — and a
/// comment is not a variant.
fn strip_comments(text: &str) -> String {
    let mut out = String::new();
    let mut chars = text.chars().peekable();
    let mut in_string = false;
    let mut escaped = false;

    while let Some(ch) = chars.next() {
        if in_string {
            out.push(ch);
            if escaped {
                escaped = false;
                continue;
            }
            match ch {
                '\\' => escaped = true,
                '"' => in_string = false,
                _ => {}
            }
            continue;
        }
        if ch == '"' {
            in_string = true;
            out.push(ch);
            continue;
        }
        if ch == '/' {
            if chars.peek() == Some(&'/') {
                // A line comment — to the end of the line.
                for inner in chars.by_ref() {
                    if inner == '\n' {
                        out.push('\n');
                        break;
                    }
                }
                continue;
            }
            if chars.peek() == Some(&'*') {
                chars.next();
                let mut previous = '\0';
                for inner in chars.by_ref() {
                    if previous == '*' && inner == '/' {
                        break;
                    }
                    previous = inner;
                }
                continue;
            }
        }
        out.push(ch);
    }

    out
}

/// Parse the enums out of one source file.
///
/// The enum body is taken as TEXT — not line by line — because a variant
/// can be written on one line (`Genitive { owner: String, possessed: String }`)
/// or on five, and the fields of a variant are the same either way.
fn parse_enums(source: &str) -> Vec<SourceEnum> {
    let mut enums = Vec::new();
    let lines: Vec<&str> = source.lines().collect();
    let mut index = 0;

    // The attributes that belong to the next item.
    let mut pending_rename_all: Option<String> = None;
    let mut pending_tag: Option<String> = None;

    while index < lines.len() {
        let trimmed = lines[index].trim();

        if trimmed.starts_with("#[serde") {
            if let Some(rule) = attr_string(trimmed, "rename_all") {
                pending_rename_all = Some(rule);
            }
            if let Some(tag) = attr_string(trimmed, "tag") {
                pending_tag = Some(tag);
            }
            index += 1;
            continue;
        }
        if trimmed.starts_with("#[") {
            index += 1;
            continue;
        }

        let declaration = trimmed
            .strip_prefix("pub enum ")
            .or_else(|| trimmed.strip_prefix("enum "));
        let Some(rest) = declaration else {
            // Any other item ends the pending attributes — they belong to
            // the item that follows, and that item is not this enum.
            if trimmed.starts_with("pub ") || trimmed.starts_with("fn ") {
                pending_rename_all = None;
                pending_tag = None;
            }
            index += 1;
            continue;
        };

        let name = rest
            .split(['<', ' ', '{', '(', ','])
            .next()
            .unwrap_or_default()
            .trim()
            .to_string();

        // The body of the enum: from the opening brace to its match.
        let mut body = String::new();
        let mut depth = 0i32;
        let mut started = false;
        while index < lines.len() {
            let line = lines[index];
            for ch in line.chars() {
                if ch == '{' {
                    depth += 1;
                    started = true;
                } else if ch == '}' {
                    depth -= 1;
                }
                if started {
                    body.push(ch);
                }
            }
            // The line break matters: without it a `//` comment would run
            // to the end of the whole body and eat the variants behind it.
            if started {
                body.push('\n');
            }
            index += 1;
            if started && depth <= 0 {
                break;
            }
        }

        let mut variants: Vec<SourceVariant> = Vec::new();
        let mut aliases: Vec<String> = Vec::new();

        // The body still carries the enum's own braces — they have to go,
        // or every comma of the body would be "inside a brace".
        let body = strip_comments(body.trim());
        let body = body.trim();
        let body = body.strip_prefix('{').unwrap_or(body);
        let body = body.strip_suffix('}').unwrap_or(body);

        for chunk in split_top_level_commas(body) {
            let (attributes, text) = split_attributes(&chunk);
            for attribute in &attributes {
                if attribute.contains("alias") {
                    if let Some(alias) = attr_string(attribute, "alias") {
                        aliases.push(alias);
                    }
                }
            }

            let text = text.trim();
            if text.is_empty() {
                continue;
            }

            let variant_name = text
                .split(['{', '(', ' '])
                .next()
                .unwrap_or_default()
                .trim()
                .to_string();

            let fields = match text.find('{') {
                Some(brace) => {
                    let inner = &text[brace + 1..];
                    let inner = inner.rsplit_once('}').map(|(head, _)| head).unwrap_or(inner);
                    parse_variant_fields(inner)
                }
                None => Vec::new(),
            };

            variants.push(SourceVariant {
                name: variant_name,
                fields,
            });
        }

        enums.push(SourceEnum {
            name,
            rename_all: pending_rename_all.take(),
            tag: pending_tag.take(),
            variants,
            aliases,
        });
    }

    enums
}

/// The fields of one struct variant, from the text inside its braces.
fn parse_variant_fields(inner: &str) -> Vec<SourceField> {
    let mut fields: Vec<SourceField> = Vec::new();
    let mut pending_rename: Option<String> = None;
    let mut pending_skip = false;

    for chunk in split_top_level_commas(inner) {
        let (attributes, text) = split_attributes(&chunk);
        for attribute in &attributes {
            if attribute.contains("skip_serializing_if") {
                pending_skip = true;
            }
            if !attribute.contains("rename_all") {
                if let Some(rename) = attr_string(attribute, "rename") {
                    pending_rename = Some(rename);
                }
            }
        }

        let text = text.trim();
        if text.is_empty() {
            continue;
        }
        let Some((name, type_text)) = text.split_once(':') else {
            continue;
        };
        let name = name.trim().trim_start_matches("pub ").trim().to_string();
        let type_text = type_text.trim().trim_end_matches(',').trim().to_string();
        if name.is_empty() || name.contains(' ') || type_text.is_empty() {
            continue;
        }

        fields.push(SourceField {
            name,
            type_text,
            js_name: None,
            serde_rename: pending_rename.take(),
            skip_serializing_if: std::mem::take(&mut pending_skip),
        });
    }

    fields
}

/// Parse the structs out of one source file.
///
/// A line-based scan, deliberately: the attributes always sit directly
/// above what they describe, and a field rename is the only attribute
/// inside one struct.
fn parse_structs(source: &str) -> Vec<SourceStruct> {
    let mut structs: Vec<SourceStruct> = Vec::new();

    let mut pending_napi_object = false;
    let mut pending_js_name: Option<String> = None;
    let mut pending_serde_rename: Option<String> = None;
    let mut pending_rename_all: Option<String> = None;
    let mut pending_skip = false;

    let mut current: Option<SourceStruct> = None;

    for line in source.lines() {
        let trimmed = line.trim();

        if trimmed.starts_with("#[") {
            if trimmed.starts_with("#[napi") {
                if trimmed.contains("object") {
                    pending_napi_object = true;
                } else if let Some(rest) = trimmed.split("js_name").nth(1) {
                    // A field rename — but only a field carries one inside a
                    // struct. A function's `js_name` (this crate has many)
                    // must never leak into the next struct that follows it,
                    // so the pending name is dropped when a function
                    // declaration comes next.
                    pending_js_name = rest.split('"').nth(1).map(|value| value.to_string());
                }
            } else if trimmed.starts_with("#[serde") {
                if trimmed.contains("rename_all") {
                    pending_rename_all = trimmed
                        .split("rename_all")
                        .nth(1)
                        .and_then(|rest| rest.split('"').nth(1))
                        .map(|value| value.to_string());
                } else if trimmed.contains("rename") {
                    pending_serde_rename = trimmed
                        .split("rename")
                        .nth(1)
                        .and_then(|rest| rest.split('"').nth(1))
                        .map(|value| value.to_string());
                }
                if trimmed.contains("skip_serializing_if") {
                    pending_skip = true;
                }
            }
            continue;
        }

        if trimmed.is_empty() {
            continue;
        }

        // A function declaration ends any pending attribute — the
        // `js_name` of a function belongs to the function.
        if trimmed.starts_with("fn ") || trimmed.starts_with("pub fn ") {
            pending_js_name = None;
            pending_serde_rename = None;
            pending_skip = false;
            pending_napi_object = false;
            continue;
        }

        // A struct declaration.
        if let Some(rest) = trimmed
            .strip_prefix("pub ")
            .unwrap_or(trimmed)
            .strip_prefix("struct ")
        {
            let name = rest
                .split(['<', ' ', '{'])
                .next()
                .unwrap_or_default()
                .trim()
                .to_string();
            let kind = if pending_napi_object {
                StructKind::NapiObject
            } else {
                StructKind::Serde
            };
            current = Some(SourceStruct {
                name,
                kind,
                rename_all: pending_rename_all.take(),
                fields: Vec::new(),
            });
            pending_napi_object = false;
            pending_js_name = None;
            pending_serde_rename = None;
            pending_rename_all = None;
            pending_skip = false;
            continue;
        }

        if let Some(structure) = current.as_mut() {
            if trimmed.starts_with('}') {
                structs.push(current.take().unwrap());
                pending_js_name = None;
                pending_serde_rename = None;
                pending_skip = false;
                continue;
            }
            // A field: `name: Type,` or `pub name: Type,`.
            let field_source = trimmed.strip_prefix("pub ").unwrap_or(trimmed);
            if let Some((name, type_text)) = field_source.split_once(':') {
                let name = name.trim().to_string();
                let type_text = type_text.trim().trim_end_matches(',').to_string();
                if !name.is_empty()
                    && !name.contains(' ')
                    && !type_text.is_empty()
                    && !type_text.starts_with('!')
                {
                    structure.fields.push(SourceField {
                        name,
                        type_text,
                        js_name: pending_js_name.take(),
                        serde_rename: pending_serde_rename.take(),
                        skip_serializing_if: std::mem::take(&mut pending_skip),
                    });
                }
            }
        }
    }

    if let Some(structure) = current.take() {
        structs.push(structure);
    }

    structs
}

/// Parse the functions out of one source file, with their string literals.
///
/// The functions matter because they are where the WORDS live: a closed
/// vocabulary is the set of literals in the function that produces it.
fn parse_functions(source: &str) -> Vec<SourceFunction> {
    let mut functions: Vec<SourceFunction> = Vec::new();
    let lines: Vec<&str> = source.lines().collect();
    let mut index = 0;

    while index < lines.len() {
        let trimmed = lines[index].trim();
        let declaration = trimmed
            .strip_prefix("pub fn ")
            .or_else(|| trimmed.strip_prefix("fn "));
        let Some(rest) = declaration else {
            index += 1;
            continue;
        };

        let name = rest
            .split(['(', '<', ' '])
            .next()
            .unwrap_or_default()
            .to_string();

        let mut literals: Vec<String> = Vec::new();
        let mut depth = 0i32;
        let mut started = false;
        while index < lines.len() {
            let line = lines[index];
            for ch in line.chars() {
                if ch == '{' {
                    depth += 1;
                    started = true;
                } else if ch == '}' {
                    depth -= 1;
                }
            }
            literals.extend(string_literals(line));
            index += 1;
            if started && depth <= 0 {
                break;
            }
        }

        functions.push(SourceFunction { name, literals });
    }

    functions
}

/// The string literals of one line — the format strings excluded.
///
/// A format string (`"embed_store_failed: {e}"`) is not a word the wire
/// can carry; it is an error code for the log. Only plain literals count.
fn string_literals(line: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut current = String::new();
    let mut in_string = false;
    let mut escaped = false;
    let mut is_format = false;

    for ch in line.chars() {
        if in_string {
            if escaped {
                escaped = false;
                current.push(ch);
                continue;
            }
            match ch {
                '\\' => escaped = true,
                '"' => {
                    in_string = false;
                    if !is_format {
                        out.push(current.clone());
                    }
                    current.clear();
                    is_format = false;
                }
                '{' | '}' => is_format = true,
                _ => current.push(ch),
            }
            continue;
        }
        if ch == '"' {
            in_string = true;
            current.clear();
            is_format = false;
        }
    }

    out
}

// ---------------------------------------------------------------------------
// The two naming rules.
// ---------------------------------------------------------------------------

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

/// serde's `PascalCase.apply_to_field`.
fn pascal_case(field: &str) -> String {
    let mut pascal = String::new();
    let mut capitalize = true;
    for ch in field.chars() {
        if ch == '_' {
            capitalize = true;
        } else if capitalize {
            pascal.push(ch.to_ascii_uppercase());
            capitalize = false;
        } else {
            pascal.push(ch);
        }
    }
    pascal
}

/// serde's `RenameRule::apply_to_field`.
///
/// Copied from `serde_derive`'s own `internals/case.rs` — the rule is not
/// "camelCase-ish", it is serde's rule, and a second approximation would
/// be a second guess.
fn serde_field_name(rule: Option<&str>, field: &str) -> String {
    match rule {
        None => field.to_string(),
        Some("lowercase") => field.to_ascii_lowercase(),
        Some("UPPERCASE") => field.to_ascii_uppercase(),
        Some("PascalCase") => pascal_case(field),
        Some("camelCase") => {
            let pascal = pascal_case(field);
            let mut chars = pascal.chars();
            match chars.next() {
                Some(first) => {
                    first.to_ascii_lowercase().to_string() + chars.as_str()
                }
                None => pascal,
            }
        }
        Some("snake_case") => field.to_string(),
        Some("SCREAMING_SNAKE_CASE") => field.to_ascii_uppercase(),
        Some("kebab-case") => field.replace('_', "-"),
        Some("SCREAMING-KEBAB-CASE") => field.to_ascii_uppercase().replace('_', "-"),
        Some(other) => panic!("serde rename_all = {other:?} is not a rule this gate knows"),
    }
}

// ---------------------------------------------------------------------------
// The types.
// ---------------------------------------------------------------------------

/// The kind of a value, without the shape it points at.
#[derive(Debug, Clone, PartialEq, Eq)]
enum Kind {
    String,
    Number,
    Integer,
    Boolean,
    Bytes,
    Named(String),
    Array(Box<Kind>),
    /// A Rust ENUM used as a field type — the field carries ONE of the
    /// enum's words, so the owner declares it as an enumerated field (or
    /// as the shape of the whole enum).
    Enum(String),
}

fn kind_of(ty: PayloadType) -> Kind {
    match ty {
        PayloadType::String => Kind::String,
        PayloadType::Number => Kind::Number,
        PayloadType::Integer => Kind::Integer,
        PayloadType::Boolean => Kind::Boolean,
        PayloadType::Bytes => Kind::Bytes,
        PayloadType::Json => Kind::String,
        PayloadType::Named(name) => Kind::Named(name.to_string()),
        PayloadType::Array(inner) => Kind::Array(Box::new(kind_of(*inner))),
        // An enumerated field is a string on the wire — the CLOSED set of
        // words is checked separately, against the source that produces
        // them.
        PayloadType::Enum => Kind::String,
    }
}

/// The kind a Rust type declares, and whether it is an `Option`.
fn rust_kind(
    type_text: &str,
    shapes: &[&'static str],
    enums: &[SourceEnum],
) -> Option<(Kind, bool)> {
    let type_text = type_text.trim();
    if let Some(inner) = type_text
        .strip_prefix("Option<")
        .and_then(|rest| rest.strip_suffix('>'))
    {
        return rust_kind(inner, shapes, enums).map(|(kind, _)| (kind, true));
    }
    if let Some(inner) = type_text
        .strip_prefix("Vec<")
        .and_then(|rest| rest.strip_suffix('>'))
    {
        return rust_kind(inner, shapes, enums).map(|(kind, _)| (Kind::Array(Box::new(kind)), false));
    }
    // An ENUM type is not a string and not a struct: it is a closed set
    // of words, and the owner has to say so.
    if let Some(enum_) = enums.iter().find(|candidate| candidate.name == type_text) {
        return Some((Kind::Enum(enum_.name.clone()), false));
    }
    // A path-qualified type (`bridge_exports::BridgeExportBinding`) names
    // the same type as the bare one — the path is not part of the shape.
    let type_text = type_text.rsplit("::").next().unwrap_or(type_text).trim();
    let kind = match type_text {
        "String" | "&str" | "&'static str" => Kind::String,
        "bool" => Kind::Boolean,
        "u8" | "u16" | "u32" | "u64" | "usize" | "i8" | "i16" | "i32" | "i64" | "isize" => {
            Kind::Integer
        }
        "f32" | "f64" => Kind::Number,
        "Buffer" | "Vec<u8>" => Kind::Bytes,
        other => {
            if shapes.contains(&other) {
                let shape = PAYLOAD_SHAPES
                    .iter()
                    .find(|shape| shape.rust_type == other)
                    .expect("the shape list is the source of the names");
                Kind::Named(shape.name.to_string())
            } else {
                return None;
            }
        }
    };
    Some((kind, false))
}

// ---------------------------------------------------------------------------
// The sources.
// ---------------------------------------------------------------------------

fn crate_sources() -> (Vec<SourceStruct>, Vec<SourceFunction>, Vec<SourceEnum>) {
    let mut structs = Vec::new();
    let mut functions = Vec::new();
    let mut enums = Vec::new();

    for source in [
        include_str!("../src/lib.rs"),
        include_str!("../src/vault_bridge.rs"),
        include_str!("../src/bridge_exports.rs"),
        include_str!("../../memphis-embed/src/metadata.rs"),
        // The chain, soul and case families live in the core crates, not
        // in the bridge — so the gate reads them from THERE.
        include_str!("../../memphis-core/src/block.rs"),
        include_str!("../../memphis-core/src/loop_engine.rs"),
        include_str!("../../memphis-core/src/harness.rs"),
        include_str!("../../memphis-core/src/case_entry.rs"),
        include_str!("../../memphis-case-index/src/lib.rs"),
    ] {
        structs.extend(parse_structs(source));
        functions.extend(parse_functions(source));
        enums.extend(parse_enums(source));
    }

    (structs, functions, enums)
}

// ---------------------------------------------------------------------------
// The checks.
// ---------------------------------------------------------------------------

#[test]
fn every_shape_field_is_the_name_the_wire_really_carries() {
    let (structs, _, enums) = crate_sources();
    assert!(
        !structs.is_empty(),
        "no structs found — the parser is broken, not the crate"
    );

    for shape in PAYLOAD_SHAPES {
        // A shape whose Rust type is an ENUM has no struct fields: it is
        // a tag plus the union of the enum's variants, and it is checked
        // by `every_enum_shape_is_the_tag_and_the_union_of_its_variants`.
        if enums.iter().any(|candidate| candidate.name == shape.rust_type) {
            continue;
        }

        let structure = structs
            .iter()
            .find(|object| object.name == shape.rust_type)
            .unwrap_or_else(|| {
                panic!(
                    "shape {} claims to describe {}, and the crate does not declare it",
                    shape.name, shape.rust_type
                )
            });

        let expected_kind = match shape.naming {
            PayloadNaming::NapiObject => StructKind::NapiObject,
            PayloadNaming::Serde => StructKind::Serde,
        };
        assert_eq!(
            structure.kind, expected_kind,
            "{}: the table says the shape speaks {:?}, but {} is a {:?} struct",
            shape.name, shape.naming, shape.rust_type, structure.kind
        );

        assert_eq!(
            structure.fields.len(),
            shape.fields.len(),
            "{}: the struct has {} fields, the table has {}",
            shape.name,
            structure.fields.len(),
            shape.fields.len()
        );

        for (parsed, declared) in structure.fields.iter().zip(shape.fields.iter()) {
            // The name on the wire — by the rule of the family the shape
            // belongs to.
            let expected_name = match shape.naming {
                PayloadNaming::NapiObject => match &parsed.js_name {
                    Some(explicit) => explicit.clone(),
                    None => camel_case(&parsed.name),
                },
                PayloadNaming::Serde => match &parsed.serde_rename {
                    Some(explicit) => explicit.clone(),
                    None => serde_field_name(structure.rename_all.as_deref(), &parsed.name),
                },
            };
            assert_eq!(
                declared.name, expected_name,
                "{}: the table says {}, but the wire will carry {expected_name} for {}.{}",
                shape.name, declared.name, shape.rust_type, parsed.name
            );

            // The type on the wire.
            let rust_types: Vec<&'static str> = PAYLOAD_SHAPES
                .iter()
                .map(|shape| shape.rust_type)
                .collect();
            let (expected_type, is_option) = rust_kind(&parsed.type_text, &rust_types, &enums)
                .unwrap_or_else(|| {
                    panic!(
                        "{}: the gate does not know the Rust type {} of {}.{}",
                        shape.name, parsed.type_text, shape.rust_type, parsed.name
                    )
                });

            // A field whose Rust type is an ENUM carries one of that
            // enum's words, so the owner has two honest ways to declare
            // it: as an enumerated field (the words), or as the shape of
            // the whole enum (the object). Both are checked here — and
            // nothing else is accepted.
            if let Kind::Enum(enum_name) = &expected_type {
                let declared_ok = match declared.ty {
                    PayloadType::Enum => declared.vocabulary.is_some_and(|vocabulary| {
                        vocabulary.sources.iter().any(|source| source == enum_name)
                    }),
                    PayloadType::Named(shape_name) => PAYLOAD_SHAPES
                        .iter()
                        .any(|candidate| candidate.rust_type == *enum_name && candidate.name == shape_name),
                    _ => false,
                };
                assert!(
                    declared_ok,
                    "{}: the field {} is the Rust enum {}, but the table declares it as {:?}",
                    shape.name,
                    declared.name,
                    enum_name,
                    declared.ty
                );
            } else {
                assert_eq!(
                    kind_of(declared.ty),
                    expected_type,
                    "{}: the table says {:?} for {}, but the struct declares {}",
                    shape.name,
                    declared.ty,
                    declared.name,
                    parsed.type_text
                );
            }

            // The PRESENCE of the key on the wire.
            let (expected_optional, expected_nullable) = match shape.naming {
                PayloadNaming::NapiObject => {
                    // napi omits a `None` field entirely.
                    (is_option, false)
                }
                PayloadNaming::Serde => {
                    if parsed.skip_serializing_if {
                        // Absent, not null.
                        (true, false)
                    } else {
                        // Present and null.
                        (false, is_option)
                    }
                }
            };
            assert_eq!(
                (declared.optional, declared.nullable),
                (expected_optional, expected_nullable),
                "{}: the table says optional={} nullable={} for {}, but the struct declares {}",
                shape.name,
                declared.optional,
                declared.nullable,
                declared.name,
                parsed.type_text
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
fn every_enumerated_field_carries_exactly_the_words_the_crate_writes() {
    let (_, functions, enums) = crate_sources();

    for shape in PAYLOAD_SHAPES {
        for field in shape.fields {
            let Some(vocabulary) = field.vocabulary else {
                continue;
            };
            let collected = vocabulary_words(&functions, &enums, &vocabulary);
            let mut declared: BTreeSet<String> =
                vocabulary.values.iter().map(|word| word.to_string()).collect();
            declared.extend(vocabulary.extra_literals.iter().map(|word| word.to_string()));

            // An ENUM accepts ALIASES on read — compatibility words that
            // the wire never writes. A vocabulary that lists one of them
            // would promise a word the bridge does not produce. This
            // check comes FIRST on purpose: an alias is never a variant
            // name, so the equality below would catch it too — but with
            // a message that says only "the sets differ".
            for source in vocabulary.sources {
                let Some(enum_) = enums.iter().find(|candidate| candidate.name == *source) else {
                    continue;
                };
                for alias in &enum_.aliases {
                    assert!(
                        !declared.contains(alias),
                        "{}: the vocabulary of {} declares the read-side alias {alias}, which the wire never writes",
                        shape.name,
                        field.name
                    );
                }
            }

            assert_eq!(
                collected, declared,
                "{}: the vocabulary of {} is {:?}, but the source writes {:?}",
                shape.name,
                field.name,
                declared,
                collected
            );
        }
    }
}

/// The words the sources of one vocabulary produce.
///
/// A source is a FUNCTION (its string literals are the words) or an
/// ENUM (its variant names, renamed by the enum's own rule, are the
/// words). The two are told apart by what the crate declares.
fn vocabulary_words(
    functions: &[SourceFunction],
    enums: &[SourceEnum],
    vocabulary: &Vocabulary,
) -> BTreeSet<String> {
    let mut collected = BTreeSet::new();
    for name in vocabulary.sources {
        if let Some(enum_) = enums.iter().find(|candidate| candidate.name == *name) {
            for variant in &enum_.variants {
                collected.insert(serde_variant_name(enum_.rename_all.as_deref(), &variant.name));
            }
            continue;
        }
        let function = functions.iter().find(|function| function.name == *name).unwrap_or_else(|| {
            panic!(
                "the vocabulary points at the source {name}, and the crate declares neither a function nor an enum by that name"
            )
        });
        collected.extend(function.literals.iter().cloned());
    }
    collected
}

/// serde's `RenameRule::apply_to_variant`.
///
/// The VARIANT rule is not the FIELD rule: `SnakeCase` on a field keeps
/// the field's own name, but on a variant it splits the PascalCase name
/// — `WalletTxRequested` becomes `wallet_tx_requested`. Copied from
/// `serde_derive`'s own `internals/case.rs`.
fn serde_variant_name(rule: Option<&str>, variant: &str) -> String {
    match rule {
        None | Some("PascalCase") => variant.to_string(),
        Some("lowercase") => variant.to_ascii_lowercase(),
        Some("UPPERCASE") => variant.to_ascii_uppercase(),
        Some("camelCase") => {
            let mut chars = variant.chars();
            match chars.next() {
                Some(first) => first.to_ascii_lowercase().to_string() + chars.as_str(),
                None => variant.to_string(),
            }
        }
        Some("snake_case") => snake_case(variant),
        Some("SCREAMING_SNAKE_CASE") => snake_case(variant).to_ascii_uppercase(),
        Some("kebab-case") => snake_case(variant).replace('_', "-"),
        Some("SCREAMING-KEBAB-CASE") => snake_case(variant).to_ascii_uppercase().replace('_', "-"),
        Some(other) => panic!("serde rename_all = {other:?} is not a rule this gate knows"),
    }
}

/// serde's snake_case of a variant name.
fn snake_case(variant: &str) -> String {
    let mut snake = String::new();
    for (index, ch) in variant.char_indices() {
        if index > 0 && ch.is_uppercase() {
            snake.push('_');
        }
        snake.push(ch.to_ascii_lowercase());
    }
    snake
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
            match field.ty {
                PayloadType::Named(name) => assert!(
                    PAYLOAD_SHAPES.iter().any(|candidate| candidate.name == name),
                    "{}: the field {} names the unknown shape {name}",
                    shape.name,
                    field.name
                ),
                PayloadType::Array(inner) => match *inner {
                    PayloadType::Named(name) => assert!(
                        PAYLOAD_SHAPES.iter().any(|candidate| candidate.name == name),
                        "{}: the field {} names the unknown shape {name}",
                        shape.name,
                        field.name
                    ),
                    _ => {}
                },
                _ => {}
            }
        }
    }
}

#[test]
fn every_enumerated_field_declares_its_vocabulary() {
    for shape in PAYLOAD_SHAPES {
        for field in shape.fields {
            if field.ty == PayloadType::Enum {
                assert!(
                    field.vocabulary.is_some(),
                    "{}: the field {} is enumerated but declares no vocabulary",
                    shape.name,
                    field.name
                );
            } else {
                assert!(
                    field.vocabulary.is_none(),
                    "{}: the field {} declares a vocabulary but is not enumerated",
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

#[test]
fn the_embed_family_is_in_the_table() {
    for export in [
        "embed_store",
        "embed_store_many",
        "embed_flush",
        "embed_search",
        "embed_search_tuned",
        "embed_clear_in_memory",
        "embed_reset",
        "embed_discard_replacement",
        "embed_index_metadata",
    ] {
        assert!(
            BRIDGE_PAYLOADS.iter().any(|payload| payload.export == export),
            "{export} is missing from the table"
        );
    }
}

#[test]
fn the_chain_soul_and_case_families_are_in_the_table() {
    // These eight answers were built from `json!` literals — a payload
    // with no owner — until 2026-11-24. The table is where they live
    // now, and the gate checks the table against the structs that carry
    // them.
    for export in [
        "chain_validate",
        "chain_append",
        "chain_query",
        "soul_loop_step",
        "soul_replay",
        "case_append",
        "case_query",
        "case_rebuild",
    ] {
        assert!(
            BRIDGE_PAYLOADS.iter().any(|payload| payload.export == export),
            "{export} is missing from the table"
        );
    }
}

/// The union of an enum's variant fields, in order of first appearance.
///
/// A tagged enum puts ONE variant's fields on the wire, so the shape of
/// the WHOLE enum is the tag plus the union of the variants — and the
/// union is what the owner has to declare.
fn union_fields(enum_: &SourceEnum) -> Vec<SourceField> {
    let mut union: Vec<SourceField> = Vec::new();
    for variant in &enum_.variants {
        for field in &variant.fields {
            match union.iter_mut().find(|existing| existing.name == field.name) {
                Some(existing) => assert_eq!(
                    existing.type_text, field.type_text,
                    "the enum {} declares the field {} with two types, so the union has no single type for it",
                    enum_.name, field.name
                ),
                None => union.push(field.clone()),
            }
        }
    }
    union
}

#[test]
fn every_enum_shape_is_the_tag_and_the_union_of_its_variants() {
    let (_, _, enums) = crate_sources();
    let rust_types: Vec<&'static str> = PAYLOAD_SHAPES.iter().map(|shape| shape.rust_type).collect();

    let mut checked = 0;
    for shape in PAYLOAD_SHAPES {
        let Some(enum_) = enums.iter().find(|candidate| candidate.name == shape.rust_type) else {
            continue;
        };
        checked += 1;

        let tag = enum_.tag.as_ref().unwrap_or_else(|| {
            panic!(
                "the shape {} describes the enum {}, and that enum carries no serde tag — an untagged enum has no single wire shape",
                shape.name, enum_.name
            )
        });

        // The tag is the first field, and it is enumerated: the wire
        // carries one of the enum's variant names in it.
        let tag_field = &shape.fields[0];
        assert_eq!(
            tag_field.name, tag,
            "{}: the shape says the tag is {}, but the enum says {}",
            shape.name, tag_field.name, tag
        );
        assert_eq!(
            tag_field.ty,
            PayloadType::Enum,
            "{}: the tag {} must be enumerated — it carries the enum's variant names",
            shape.name, tag
        );

        // Then the union of the variants' fields.
        let union = union_fields(enum_);
        assert_eq!(
            shape.fields.len(),
            union.len() + 1,
            "{}: the shape has {} fields, but the union of the variants of {} has {}",
            shape.name,
            shape.fields.len(),
            enum_.name,
            union.len()
        );

        for (declared, field) in shape.fields[1..].iter().zip(union.iter()) {
            assert_eq!(
                declared.name, field.name,
                "{}: the shape says {}, but the union of the variants of {} says {}",
                shape.name,
                declared.name,
                enum_.name,
                field.name
            );

            let (expected_type, is_option) = rust_kind(&field.type_text, &rust_types, &enums)
                .unwrap_or_else(|| {
                    panic!(
                        "{}: the gate does not know the Rust type {} of the variant field {}",
                        shape.name, field.type_text, field.name
                    )
                });
            assert_eq!(
                kind_of(declared.ty),
                expected_type,
                "{}: the table says {:?} for {}, but the variant declares {}",
                shape.name,
                declared.ty,
                declared.name,
                field.type_text
            );

            // The PRESENCE of a union field: a field that only SOME
            // variants carry is ABSENT on the wire when another variant
            // is the one on it — absent, not null.
            let in_every_variant = enum_
                .variants
                .iter()
                .all(|variant| variant.fields.iter().any(|other| other.name == field.name));
            let (expected_optional, expected_nullable) = if in_every_variant {
                if field.skip_serializing_if {
                    (true, false)
                } else {
                    (false, is_option)
                }
            } else {
                (true, false)
            };
            assert_eq!(
                (declared.optional, declared.nullable),
                (expected_optional, expected_nullable),
                "{}: the table says optional={} nullable={} for {}, but the variants of {} say otherwise",
                shape.name,
                declared.optional,
                declared.nullable,
                declared.name,
                enum_.name
            );
        }
    }

    assert!(
        checked > 0,
        "the gate found no enum shape at all — the parser is broken, not the crate"
    );
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
