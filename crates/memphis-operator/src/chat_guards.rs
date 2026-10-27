//! Guards and helpers shared by the native operator modules.
//!
//! These are the rules that must hold no matter which module calls them:
//! how a tool result is wrapped for the model, how model output is
//! screened for leaked secrets, what may be written to a memory chain,
//! and the small JSON/hash utilities the other modules use.
//!
//! Split out of `chat.rs` unchanged. Kept in one module so the screening
//! rules are reviewed as a set — a wrapper that escapes its tag and a
//! scanner that misses a path are the same class of bug.

use chrono::Utc;
use std::fs;
use std::path::Path;

use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::chat::PromptRiskClassification;
use crate::chat_memory::append_generic_block;
use crate::OperatorError;
use crate::text_truncation::truncate_with_ellipsis;
use crate::OperatorRuntime;

pub(crate) fn build_wrapped_segment(
    tag: &str,
    content: &str,
    classification: Option<&PromptRiskClassification>,
    tool_name: Option<&str>,
) -> String {
    let escaped = content
        .replace("</user_input>", "<\\/user_input>")
        .replace("</fetched_content>", "<\\/fetched_content>")
        .replace("</tool_output>", "<\\/tool_output>")
        .replace("</recalled_memory>", "<\\/recalled_memory>");
    let mut wrapped = Vec::new();
    match tag {
        "tool_output" => wrapped.push(format!(
            "<tool_output{}>",
            tool_name
                .map(|name| format!(" tool=\"{}\"", name))
                .unwrap_or_default()
        )),
        _ => wrapped.push(format!("<{tag}>")),
    }
    wrapped.push(escaped);
    wrapped.push(format!("</{tag}>"));
    if let Some(classification) = classification {
        if classification.risk != "low" {
            wrapped.push(format!(
                "<risk_annotation level=\"{}\">flags={}</risk_annotation>",
                classification.risk,
                classification.flags.join(", ")
            ));
        }
    }
    wrapped.join("\n")
}

pub(crate) fn guard_model_output(
    runtime: &OperatorRuntime,
    output: &str,
    surface: &str,
) -> Result<String, OperatorError> {
    let mut redacted = output.to_string();
    let patterns = [
        (
            "system_prompt_leak",
            regex::Regex::new(r"(?iu)<memphis_system>[\s\S]*</memphis_system>").unwrap(),
            "[filtered: protected system prompt]",
        ),
        (
            "api_token_leak",
            regex::Regex::new(r"(?iu)MEMPHIS_API_TOKEN[^\n]*").unwrap(),
            "[filtered: protected api token reference]",
        ),
        (
            "vault_pepper_leak",
            regex::Regex::new(r"(?iu)MEMPHIS_VAULT_PEPPER[^\n]*").unwrap(),
            "[filtered: protected vault secret reference]",
        ),
        (
            "vault_plaintext_json_leak",
            regex::Regex::new(r#"(?iu)"plaintext"\s*:\s*"[^"]*""#).unwrap(),
            r#""plaintext":"[filtered: protected vault secret]""#,
        ),
        (
            "vault_plaintext_line_leak",
            regex::Regex::new(r"(?iu)\bplaintext\s*[:=]\s*[^\n]+").unwrap(),
            "plaintext=[filtered: protected vault secret]",
        ),
        (
            "developer_prompt_reference_leak",
            regex::Regex::new(r"(?iu)\b(?:developer message|hidden instructions)\s*[:=]\s*[^\n]+")
                .unwrap(),
            "[filtered: protected prompt reference]",
        ),
    ];
    let mut flags = Vec::new();
    for (flag, re, replacement) in patterns {
        if re.is_match(redacted.as_str()) {
            flags.push(flag.to_string());
            redacted = re.replace_all(redacted.as_str(), replacement).to_string();
        }
    }
    if !flags.is_empty() {
        emit_runtime_security_event(
            runtime,
            "prompt.output.redacted",
            "blocked",
            json!({
                "surface": surface,
                "flags": flags,
                "contentHash": sha256_hex(output.as_bytes()),
            }),
        )?;
    }
    Ok(redacted)
}

pub(crate) fn audit_input_classification(
    runtime: &OperatorRuntime,
    classification: &PromptRiskClassification,
    surface: &str,
) -> Result<(), OperatorError> {
    if classification.risk == "low" {
        return Ok(());
    }
    emit_runtime_security_event(
        runtime,
        "prompt.input.flagged",
        "allowed",
        json!({
            "surface": surface,
            "risk": classification.risk,
            "flags": classification.flags,
            "contentHash": classification.content_hash,
        }),
    )
}

pub(crate) fn emit_runtime_security_event(
    runtime: &OperatorRuntime,
    action: &str,
    status: &str,
    details: Value,
) -> Result<(), OperatorError> {
    append_generic_block(
        &runtime.config.data_dir,
        "system",
        json!({
            "type": "security_event",
            "action": action,
            "status": status,
            "details": sanitize_json(details),
            "timestamp": Utc::now().to_rfc3339(),
        }),
    )
    .map(|_| ())
}

pub(crate) fn sanitize_json(value: Value) -> Value {
    match value {
        Value::String(text) => {
            if text.len() > 300 {
                // Character-boundary cut: a fixed byte offset panicked
                // on any multi-byte character at that position.
                Value::String(truncate_with_ellipsis(&text, 300))
            } else {
                Value::String(text)
            }
        }
        Value::Array(items) => {
            Value::Array(items.into_iter().take(12).map(sanitize_json).collect())
        }
        Value::Object(map) => {
            let next = map
                .into_iter()
                .take(20)
                .map(|(key, value)| (key, sanitize_json(value)))
                .collect();
            Value::Object(next)
        }
        other => other,
    }
}

pub(crate) fn scan_memory_content(content: &str) -> Result<(), (String, String)> {
    const INVISIBLE: [char; 10] = [
        '\u{200b}', '\u{200c}', '\u{200d}', '\u{2060}', '\u{feff}', '\u{202a}', '\u{202b}',
        '\u{202c}', '\u{202d}', '\u{202e}',
    ];
    for ch in content.chars() {
        if INVISIBLE.contains(&ch) {
            return Err((
                "invisible_unicode".to_string(),
                format!("blocked invisible unicode U+{:04X}", ch as u32),
            ));
        }
    }

    let patterns = [
        (
            "prompt_injection",
            regex::Regex::new(r"(?iu)ignore\s+(previous|all|above|prior)\s+instructions").unwrap(),
            "content attempts to override instructions",
        ),
        (
            "role_hijack",
            regex::Regex::new(r"(?iu)you\s+are\s+now\s+").unwrap(),
            "content attempts to redefine the assistant role",
        ),
        (
            "deception_hide",
            regex::Regex::new(r"(?iu)do\s+not\s+tell\s+(the\s+)?user").unwrap(),
            "content attempts to hide behavior from the user",
        ),
        (
            "disregard_rules",
            regex::Regex::new(r"(?iu)disregard\s+(your|all|any)\s+(instructions|rules|guidelines)")
                .unwrap(),
            "content attempts to bypass runtime rules",
        ),
        // The seven arms below were missing here while MEMORY_PATTERNS in
        // src/security/content-scan.ts already had them. The native surface
        // is the one that actually writes journal entries, so the gap meant
        // exfiltration-shaped and SSH-persistence content was refused by
        // MCP/gateway and accepted by the TUI. Regexes are translated
        // one-for-one from the TypeScript list -- see
        // `native_scanner_blocks_every_pattern_the_typescript_profile_blocks`.
        (
            "sys_prompt_override",
            regex::Regex::new(r"(?iu)system\s+prompt\s+override").unwrap(),
            "content references prompt override behavior",
        ),
        (
            "bypass_restrictions",
            regex::Regex::new(
                r"(?iu)act\s+as\s+(if|though)\s+you\s+(have\s+no|do(?:n'?t)?\s+have)\s+(restrictions|limits|rules)"
            )
            .unwrap(),
            "content attempts to remove runtime restrictions",
        ),
    ];

    for (id, re, reason) in patterns.into_iter().chain(secret_exfiltration_patterns()) {
        if re.is_match(content) {
            return Err((id.to_string(), reason.to_string()));
        }
    }
    Ok(())
}

/// Arms shared by the `memory` and `code-change` profiles. In TypeScript
/// these appear in both `MEMORY_PATTERNS` and `CODE_CHANGE_PATTERNS`
/// (src/security/content-scan.ts); duplicating them per profile there is
/// what let the native copy drift. One function, two profiles.

pub(crate) fn secret_exfiltration_patterns(
) -> impl Iterator<Item = (&'static str, regex::Regex, &'static str)> {
    [
        (
            "exfil_curl",
            regex::Regex::new(
                r"(?iu)curl\s+[^\n]*\$\{?\w*(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|API)",
            )
            .unwrap(),
            "content appears to exfiltrate secrets via curl",
        ),
        (
            "exfil_wget",
            regex::Regex::new(
                r"(?iu)wget\s+[^\n]*\$\{?\w*(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|API)",
            )
            .unwrap(),
            "content appears to exfiltrate secrets via wget",
        ),
        (
            "read_secrets",
            regex::Regex::new(
                r"(?iu)cat\s+[^\n]*(\.env|credentials|\.netrc|\.pgpass|\.npmrc|\.pypirc)",
            )
            .unwrap(),
            "content appears to read secret material from disk",
        ),
        (
            "ssh_backdoor",
            regex::Regex::new(r"(?iu)authorized_keys").unwrap(),
            "content references SSH persistence",
        ),
        (
            "ssh_access",
            regex::Regex::new(r"(?iu)(?:\$HOME|~)/\.ssh").unwrap(),
            "content references SSH key material",
        ),
    ]
    .into_iter()
}

/// Paths the native `memphis_code_read` must refuse.
///
/// The TypeScript surface has refused these since the tool landed
/// (ALWAYS_BLOCKED_READ_PATTERNS in src/mcp/tools/code-read.ts). The native
/// tool checked only that the path sat under ~/memphis/, so `memphis_code_read`
/// on the authoritative surface would happily return `.env`, `vault-state.json`
/// and `vault-entries.json` -- the exact files the boundary exists to protect,
/// in the directory where they live.
///
/// Returned as Err with an operator-facing reason rather than silently
/// skipping, so the refusal is legible in the TUI.

pub(crate) fn assert_path_not_secret_material(resolved: &str) -> Result<(), String> {
    const BLOCKED: &[(&str, fn(&str) -> bool)] = &[
        (".env", |p: &str| p == ".env" || p.starts_with(".env.")),
        ("vault-state.json", |p: &str| p == "vault-state.json"),
        ("vault-entries.json", |p: &str| p == "vault-entries.json"),
        (".git/", |p: &str| p == ".git" || p.starts_with(".git/")),
        ("node_modules/", |p: &str| p.starts_with("node_modules/")),
    ];

    // Match on any path segment, so `src/.env` is refused like `.env`.
    for segment in resolved.split('/') {
        if segment.is_empty() || segment == "." {
            continue;
        }
        for (label, matches) in BLOCKED {
            if matches(segment) {
                return Err(format!(
                    "Path '{resolved}' is blocked because it matches {label} and may contain secrets or generated state"
                ));
            }
        }
    }
    Ok(())
}

/// Scan content about to be written to a file, mirroring
/// `scanContent(content, 'code-change')` in src/security/content-scan.ts.
///
/// Without this the native `memphis_self_modify` wrote files that the MCP
/// surface would have refused, and it did so on the surface that is
/// authoritative -- the one the operator drives from the TUI.

pub(crate) fn scan_code_change_content(content: &str) -> Result<(), (String, String)> {
    for ch in content.chars() {
        if matches!(
            ch,
            '\u{200b}'
                | '\u{200c}'
                | '\u{200d}'
                | '\u{2060}'
                | '\u{feff}'
                | '\u{202a}'
                | '\u{202b}'
                | '\u{202c}'
                | '\u{202d}'
                | '\u{202e}'
        ) {
            return Err((
                "invisible_unicode".to_string(),
                format!("blocked invisible unicode U+{:04X}", ch as u32),
            ));
        }
    }

    for (id, re, reason) in secret_exfiltration_patterns() {
        if re.is_match(content) {
            return Err((id.to_string(), reason.to_string()));
        }
    }
    Ok(())
}

pub(crate) fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    format!("{:x}", hasher.finalize())
}

pub(crate) fn load_json_file(path: &Path) -> Option<Value> {
    let raw = fs::read_to_string(path).ok()?;
    serde_json::from_str(&raw).ok()
}

pub(crate) fn write_json_file(path: &Path, value: &Value) -> Result<(), OperatorError> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| OperatorError::Io(error.to_string()))?;
    }
    fs::write(
        path,
        serde_json::to_vec_pretty(value).map_err(|error| OperatorError::Json(error.to_string()))?,
    )
    .map_err(|error| OperatorError::Io(error.to_string()))
}

#[cfg(test)]
mod tests {
    use super::sanitize_json;
    use serde_json::Value;

    /// A tool result in Polish is longer than 300 bytes and carries
    /// multi-byte characters. The cut has to land on a character
    /// boundary — the same class of bug that killed the chat worker on
    /// 2026-10-27.
    #[test]
    fn sanitize_json_never_splits_a_character() {
        for offset in 0..400usize {
            let mut text = "x".repeat(offset);
            text.push('\u{201e}');
            text.push_str(&"y".repeat(400));
            let value = sanitize_json(Value::String(text));
            let sanitized = value.as_str().expect("a string stays a string");
            assert!(
                sanitized.len() <= 303,
                "offset {offset}: sanitized is {} bytes, over the budget",
                sanitized.len()
            );
        }
    }

    #[test]
    fn sanitize_json_keeps_short_strings_intact() {
        let value = sanitize_json(Value::String("krótko".to_string()));
        assert_eq!(value.as_str(), Some("krótko"));
    }
}
