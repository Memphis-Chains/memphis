//! Slash-command parsing for the Rust TUI.
//!
//! Token-stream classifiers and host-command builders extracted from
//! `app/mod.rs` (S4 plan). Pure functions: no `AppState` access. Anything
//! the TUI types in (e.g. `/tier 3 <pass>`, `/config surfaces set ...`)
//! flows through `classify_input_route` → either native, host RPC, legacy
//! CLI fallback, or unsupported.
//!
//! Visibility: only functions called from `app/mod.rs` are `pub(super)`;
//! the rest stay private to this module.

use std::collections::{HashMap, HashSet};

use serde_json::json;

use crate::client::ExtensionHostCommand;

use super::{ActiveCommandKind, CommandRoute};

pub(crate) fn classify_input_route(raw: &str) -> Result<CommandRoute, String> {
    let raw = raw.trim();
    if raw.is_empty() {
        return Err("input must not be empty".to_string());
    }

    if let Some(command_line) = raw.strip_prefix('/') {
        let tokens = split_command_tokens(command_line)?;
        return classify_command_route(&tokens);
    }

    Ok(CommandRoute::Native)
}

fn classify_command_route(tokens: &[String]) -> Result<CommandRoute, String> {
    if tokens.is_empty() {
        return Ok(CommandRoute::Unsupported);
    }

    match tokens {
        [scope, action, ..] if *scope == "telegram" && *action == "send" => {
            return Ok(CommandRoute::Host);
        }
        [cmd, ..] if *cmd == "legacy" => return Ok(CommandRoute::Legacy),
        _ => {}
    }

    if is_native_command_tokens(tokens) {
        return Ok(CommandRoute::Native);
    }

    match extension_host_command_for_tokens(tokens) {
        Ok(Some(_)) => Ok(CommandRoute::Host),
        Ok(None) => Ok(CommandRoute::Unsupported),
        Err(error) => Err(error),
    }
}

fn is_native_command_tokens(tokens: &[String]) -> bool {
    match tokens {
        [cmd]
            if matches!(
                cmd.as_str(),
                "help"
                    | "clear"
                    | "refresh"
                    | "overview"
                    | "memory"
                    | "sessions"
                    | "vault"
                    | "cases"
                    | "system"
                    | "telegram"
                    | "providers"
                    | "models"
            ) =>
        {
            true
        }
        [scope, action] if *scope == "telegram" && *action == "status" => true,
        [scope, mode, ..] if *scope == "memory" && (*mode == "semantic" || *mode == "exact") => {
            true
        }
        [scope, action, _key] if *scope == "vault" && *action == "get" => true,
        [scope, action, _name] if *scope == "provider" && *action == "set" => true,
        [scope, action, _model @ ..] if *scope == "model" && *action == "set" => true,
        [cmd, _value] if *cmd == "provider" => true,
        [cmd, _value @ ..] if *cmd == "model" => true,
        [cmd, _value] if *cmd == "session" => true,
        _ => false,
    }
}

pub(super) fn extension_host_command_for_tokens(
    tokens: &[String],
) -> Result<Option<(ExtensionHostCommand, ActiveCommandKind)>, String> {
    match tokens {
        [cmd] if *cmd == "guide" || *cmd == "design" => Ok(Some((
            ExtensionHostCommand {
                label: "guide".to_string(),
                command: "guide.show".to_string(),
                args: json!({}),
            },
            ActiveCommandKind::Generic,
        ))),
        [cmd, sub] if *cmd == "init" && *sub == "status" => Ok(Some((
            ExtensionHostCommand {
                label: "init status".to_string(),
                command: "init.status".to_string(),
                args: json!({}),
            },
            ActiveCommandKind::Generic,
        ))),
        [cmd] if *cmd == "health" => Ok(Some((
            ExtensionHostCommand {
                label: "health".to_string(),
                command: "health.status".to_string(),
                args: json!({}),
            },
            ActiveCommandKind::Generic,
        ))),
        [cmd] if *cmd == "pulse" => Ok(Some((
            ExtensionHostCommand {
                label: "pulse".to_string(),
                command: "pulse.status".to_string(),
                args: json!({}),
            },
            ActiveCommandKind::Generic,
        ))),
        [cmd, sub] if *cmd == "pulse" && *sub == "status" => Ok(Some((
            ExtensionHostCommand {
                label: "pulse status".to_string(),
                command: "pulse.status".to_string(),
                args: json!({}),
            },
            ActiveCommandKind::Generic,
        ))),
        [cmd, rest @ ..] if *cmd == "doctor" => {
            let (bools, values) =
                parse_supported_flags(rest, &["--fix", "--force", "--deep"], &[])?;
            if !values.is_empty() {
                return Err("doctor does not accept value flags in the TUI".to_string());
            }
            Ok(Some((
                ExtensionHostCommand {
                    label: "doctor".to_string(),
                    command: "doctor.run".to_string(),
                    args: json!({
                        "fix": bools.contains("--fix"),
                        "force": bools.contains("--force"),
                        "deep": bools.contains("--deep"),
                    }),
                },
                ActiveCommandKind::Generic,
            )))
        }
        [cmd, sub] if *cmd == "agents" && *sub == "list" => Ok(Some((
            ExtensionHostCommand {
                label: "agents list".to_string(),
                command: "agents.list".to_string(),
                args: json!({}),
            },
            ActiveCommandKind::Generic,
        ))),
        [cmd, sub] if *cmd == "agents" && *sub == "discover" => Ok(Some((
            ExtensionHostCommand {
                label: "agents discover".to_string(),
                command: "agents.discover".to_string(),
                args: json!({}),
            },
            ActiveCommandKind::Generic,
        ))),
        [cmd, sub, did] if *cmd == "agents" && *sub == "show" => Ok(Some((
            ExtensionHostCommand {
                label: format!("agents show {did}"),
                command: "agents.show".to_string(),
                args: json!({ "did": did }),
            },
            ActiveCommandKind::Generic,
        ))),
        [cmd, sub, rest @ ..] if *cmd == "sync" && *sub == "status" => {
            let (_bools, values) = parse_supported_flags(rest, &[], &["--chain"])?;
            Ok(Some((
                ExtensionHostCommand {
                    label: "sync status".to_string(),
                    command: "sync.status".to_string(),
                    args: json!({ "chain": values.get("--chain") }),
                },
                ActiveCommandKind::Generic,
            )))
        }
        [cmd, sub] if *cmd == "apps" && *sub == "list" => Ok(Some((
            ExtensionHostCommand {
                label: "apps list".to_string(),
                command: "apps.list".to_string(),
                args: json!({}),
            },
            ActiveCommandKind::Generic,
        ))),
        [cmd, sub, rest @ ..] if *cmd == "apps" && *sub == "show" => {
            let (id, flag_tokens) = match rest.split_first() {
                Some((first, remaining)) if !first.starts_with("--") => {
                    (Some(first.clone()), remaining)
                }
                _ => (None, rest),
            };
            let (_bools, values) = parse_supported_flags(flag_tokens, &[], &["--file"])?;
            let file = values.get("--file").cloned();
            if id.is_none() && file.is_none() {
                return Err("apps show requires <id> or --file <manifest.json>".to_string());
            }
            let label_target = id
                .clone()
                .or_else(|| file.clone())
                .unwrap_or_else(|| "manifest".to_string());
            Ok(Some((
                ExtensionHostCommand {
                    label: format!("apps show {label_target}"),
                    command: "apps.show".to_string(),
                    args: json!({ "id": id, "file": file }),
                },
                ActiveCommandKind::Generic,
            )))
        }
        [cmd, sub, id, rest @ ..] if *cmd == "apps" && *sub == "plan" => {
            let (_bools, values) = parse_supported_flags(rest, &[], &["--file", "--action"])?;
            Ok(Some((
                ExtensionHostCommand {
                    label: format!("apps plan {id}"),
                    command: "apps.plan".to_string(),
                    args: json!({
                        "id": id,
                        "file": values.get("--file"),
                        "action": values.get("--action"),
                    }),
                },
                ActiveCommandKind::Generic,
            )))
        }
        [cmd, rest @ ..] if *cmd == "reflect" => {
            let (bools, values) = parse_supported_flags(rest, &["--save"], &[])?;
            if !values.is_empty() {
                return Err("reflect does not accept value flags in the TUI".to_string());
            }
            Ok(Some((
                ExtensionHostCommand {
                    label: "reflect".to_string(),
                    command: "reflect.run".to_string(),
                    args: json!({ "save": bools.contains("--save") }),
                },
                ActiveCommandKind::Generic,
            )))
        }
        [cmd, rest @ ..] if *cmd == "insights" || *cmd == "insight" => {
            let (bools, values) =
                parse_supported_flags(rest, &["--save", "--daily", "--weekly"], &["--topic"])?;
            if bools.contains("--daily") && bools.contains("--weekly") {
                return Err("insights cannot use --daily and --weekly together".to_string());
            }
            let window = if values.contains_key("--topic") {
                "topic"
            } else if bools.contains("--weekly") {
                "weekly"
            } else {
                "daily"
            };
            Ok(Some((
                ExtensionHostCommand {
                    label: "insights".to_string(),
                    command: "insights.run".to_string(),
                    args: json!({
                        "window": window,
                        "topic": values.get("--topic"),
                        "save": bools.contains("--save"),
                    }),
                },
                ActiveCommandKind::Generic,
            )))
        }
        [cmd, sub] if *cmd == "knowledge" && *sub == "status" => Ok(Some((
            ExtensionHostCommand {
                label: "knowledge status".to_string(),
                command: "knowledge.status".to_string(),
                args: json!({}),
            },
            ActiveCommandKind::Generic,
        ))),
        [cmd, sub] if *cmd == "knowledge" && *sub == "sources" => Ok(Some((
            ExtensionHostCommand {
                label: "knowledge sources".to_string(),
                command: "knowledge.status".to_string(),
                args: json!({}),
            },
            ActiveCommandKind::Generic,
        ))),
        [cmd] if *cmd == "mode" => Ok(Some((
            ExtensionHostCommand {
                label: "mode".to_string(),
                command: "cognitive.mode".to_string(),
                args: json!({ "subcommand": "get" }),
            },
            ActiveCommandKind::Generic,
        ))),
        [cmd, mode] if *cmd == "mode" => {
            let normalized = mode.to_ascii_uppercase();
            match normalized.as_str() {
                "A" | "B" | "C" | "D" | "E" => Ok(Some((
                    ExtensionHostCommand {
                        label: format!("mode {normalized}"),
                        command: "cognitive.mode".to_string(),
                        args: json!({ "subcommand": "set", "mode": normalized }),
                    },
                    ActiveCommandKind::Generic,
                ))),
                _ => Err("mode requires one of: A | B | C | D | E".to_string()),
            }
        }
        [cmd, sub, rest @ ..] if *cmd == "knowledge" && *sub == "query" => {
            let (_bools, values) =
                parse_supported_flags(rest, &[], &["--topic", "--source", "--limit"])?;
            let Some(topic) = values.get("--topic") else {
                return Err("knowledge query requires --topic <text> in the TUI".to_string());
            };
            let limit = values
                .get("--limit")
                .and_then(|value| value.parse::<u64>().ok())
                .unwrap_or(5);
            Ok(Some((
                ExtensionHostCommand {
                    label: format!("knowledge query {topic}"),
                    command: "knowledge.query".to_string(),
                    args: json!({
                        "topic": topic,
                        "source": values.get("--source"),
                        "limit": limit,
                    }),
                },
                ActiveCommandKind::Generic,
            )))
        }
        [cmd, topic @ ..] if *cmd == "knowledge" => {
            let topic = topic.join(" ");
            if topic.trim().is_empty() {
                return Err("knowledge requires a topic or subcommand".to_string());
            }
            Ok(Some((
                ExtensionHostCommand {
                    label: format!("knowledge {topic}"),
                    command: "knowledge.query".to_string(),
                    args: json!({ "topic": topic }),
                },
                ActiveCommandKind::Generic,
            )))
        }
        [cmd, scope, action] if *cmd == "config" && *scope == "tools" && *action == "list" => {
            Ok(Some((
                ExtensionHostCommand {
                    label: "config tools list".to_string(),
                    command: "config.tools.list".to_string(),
                    args: json!({}),
                },
                ActiveCommandKind::Generic,
            )))
        }
        [cmd, scope, action, tool_name]
            if *cmd == "config" && *scope == "tools" && *action == "check" =>
        {
            Ok(Some((
                ExtensionHostCommand {
                    label: format!("config tools check {tool_name}"),
                    command: "config.tools.check".to_string(),
                    args: json!({ "toolName": tool_name }),
                },
                ActiveCommandKind::Generic,
            )))
        }
        [cmd, scope, action] if *cmd == "config" && *scope == "tools" && *action == "pending" => {
            Ok(Some((
                ExtensionHostCommand {
                    label: "config tools pending".to_string(),
                    command: "config.tools.pending".to_string(),
                    args: json!({}),
                },
                ActiveCommandKind::Generic,
            )))
        }
        [cmd, scope, action] if *cmd == "config" && *scope == "surfaces" && *action == "list" => {
            Ok(Some((
                ExtensionHostCommand {
                    label: "config surfaces list".to_string(),
                    command: "config.surfaces.list".to_string(),
                    args: json!({}),
                },
                ActiveCommandKind::Generic,
            )))
        }
        [cmd, scope, action, surface]
            if *cmd == "config" && *scope == "surfaces" && *action == "check" =>
        {
            Ok(Some((
                ExtensionHostCommand {
                    label: format!("config surfaces check {surface}"),
                    command: "config.surfaces.check".to_string(),
                    args: json!({ "surface": surface }),
                },
                ActiveCommandKind::Generic,
            )))
        }
        [cmd, scope, action, surface, setting, value @ ..]
            if *cmd == "config" && *scope == "surfaces" && *action == "set" =>
        {
            let value = value.join(" ");
            if value.trim().is_empty() {
                return Err(
                    "config surfaces set requires <surface> <setting> <value> in the TUI"
                        .to_string(),
                );
            }
            Ok(Some((
                ExtensionHostCommand {
                    label: format!("config surfaces set {surface} {setting}"),
                    command: "config.surfaces.set".to_string(),
                    args: json!({ "surface": surface, "setting": setting, "value": value }),
                },
                ActiveCommandKind::Generic,
            )))
        }
        [cmd, scope, action, surface]
            if *cmd == "config" && *scope == "surfaces" && *action == "reset" =>
        {
            Ok(Some((
                ExtensionHostCommand {
                    label: format!("config surfaces reset {surface}"),
                    command: "config.surfaces.reset".to_string(),
                    args: json!({ "surface": surface }),
                },
                ActiveCommandKind::Generic,
            )))
        }
        [cmd, scope, action, surface, setting]
            if *cmd == "config" && *scope == "surfaces" && *action == "reset" =>
        {
            Ok(Some((
                ExtensionHostCommand {
                    label: format!("config surfaces reset {surface} {setting}"),
                    command: "config.surfaces.reset".to_string(),
                    args: json!({ "surface": surface, "setting": setting }),
                },
                ActiveCommandKind::Generic,
            )))
        }
        [cmd] if *cmd == "tier" => Ok(Some((
            ExtensionHostCommand {
                label: "tier status".to_string(),
                command: "security.tier.status".to_string(),
                args: json!({}),
            },
            ActiveCommandKind::Generic,
        ))),
        [cmd, sub] if *cmd == "tier" && *sub == "status" => Ok(Some((
            ExtensionHostCommand {
                label: "tier status".to_string(),
                command: "security.tier.status".to_string(),
                args: json!({}),
            },
            ActiveCommandKind::Generic,
        ))),
        [cmd, sub] if *cmd == "tier" && *sub == "revoke" => Ok(Some((
            ExtensionHostCommand {
                label: "tier revoke".to_string(),
                command: "security.tier.revoke".to_string(),
                args: json!({}),
            },
            ActiveCommandKind::Generic,
        ))),
        [cmd, tier, rest @ ..] if *cmd == "tier" && *tier == "3" => {
            let passphrase = rest.join(" ");
            if passphrase.trim().is_empty() {
                return Err(
                    "tier 3 requires the operator passphrase: /tier 3 <passphrase>".to_string(),
                );
            }
            Ok(Some((
                ExtensionHostCommand {
                    label: "tier 3 elevate".to_string(),
                    command: "security.tier.elevate".to_string(),
                    args: json!({ "tier": 3, "passphrase": passphrase }),
                },
                ActiveCommandKind::Generic,
            )))
        }
        // Sprint S2 (2026-04-26): tier 0/1/2 dispatch in TUI to match Telegram.
        // Before this, /tier 0|1|2 fell through to the unsupported-command
        // notice, leaving the operator without a way to demote tier 3 except
        // /tier revoke (revoke restores tier 2 by default; cannot reach 0/1).
        [cmd, sub] if *cmd == "tier" && (*sub == "0" || *sub == "1" || *sub == "2") => {
            let target_tier: u8 = sub.parse().expect("matched 0/1/2 above");
            Ok(Some((
                ExtensionHostCommand {
                    label: format!("tier {target_tier} set"),
                    command: "security.tier.set".to_string(),
                    args: json!({ "tier": target_tier }),
                },
                ActiveCommandKind::Generic,
            )))
        }
        _ => Ok(None),
    }
}

fn parse_supported_flags(
    tokens: &[String],
    bool_flags: &[&str],
    value_flags: &[&str],
) -> Result<(HashSet<String>, HashMap<String, String>), String> {
    let mut bools = HashSet::new();
    let mut values = HashMap::new();
    let bool_allowed = bool_flags.iter().copied().collect::<HashSet<_>>();
    let value_allowed = value_flags.iter().copied().collect::<HashSet<_>>();
    let mut index = 0usize;

    while index < tokens.len() {
        let token = tokens[index].as_str();
        if bool_allowed.contains(token) {
            bools.insert(token.to_string());
            index += 1;
            continue;
        }
        if value_allowed.contains(token) {
            let Some(value) = tokens.get(index + 1) else {
                return Err(format!("{token} requires a value"));
            };
            values.insert(token.to_string(), value.clone());
            index += 2;
            continue;
        }
        return Err(format!(
            "unsupported flag or argument for extension host command: {token}"
        ));
    }

    Ok((bools, values))
}

pub(super) fn legacy_cli_fallback_notice(tokens: &[String]) -> String {
    let command = if tokens.is_empty() {
        "unknown command".to_string()
    } else {
        tokens.join(" ")
    };
    format!(
        "Emergency CLI escape hatch: `{command}` is running through the one-shot memphis --json compatibility path."
    )
}

pub(super) fn unsupported_tui_command_notice(tokens: &[String]) -> String {
    let command = if tokens.is_empty() {
        "unknown command".to_string()
    } else {
        tokens.join(" ")
    };
    format!(
        "unsupported command: `/{command}`. This Rust TUI only runs native or host-backed commands by default. Check /help. If you intentionally need the compatibility path, rerun it as /legacy {command}."
    )
}

fn split_stderr_details(error: &str) -> (String, Vec<String>) {
    let mut primary_lines = Vec::new();
    let mut stderr_lines = Vec::new();
    let mut in_stderr = false;

    for line in error.lines() {
        let trimmed = line.trim();
        if trimmed.eq_ignore_ascii_case("stderr:") {
            in_stderr = true;
            continue;
        }

        if in_stderr {
            if !trimmed.is_empty() {
                stderr_lines.push(trimmed.to_string());
            }
        } else if !trimmed.is_empty() {
            primary_lines.push(trimmed.to_string());
        }
    }

    (primary_lines.join("\n"), stderr_lines)
}

pub(super) fn summarize_host_command_error(
    error: &str,
) -> (&'static str, Option<String>, Vec<String>, bool) {
    let (primary, stderr_lines) = split_stderr_details(error);
    let normalized = primary.trim();

    let (status, detail, reset_hint) = if let Some(detail) =
        normalized.strip_prefix("extension host request timed out before start: ")
    {
        ("Status: host start timeout", detail.trim(), true)
    } else if let Some(detail) = normalized.strip_prefix("extension host request stalled: ") {
        ("Status: host request stalled", detail.trim(), true)
    } else if let Some(detail) = normalized.strip_prefix("extension host stopped unexpectedly: ") {
        ("Status: host stopped unexpectedly", detail.trim(), true)
    } else if let Some(detail) = normalized.strip_prefix("extension host protocol error: ") {
        ("Status: host protocol reset", detail.trim(), true)
    } else if let Some(detail) =
        normalized.strip_prefix("failed to launch memphis extension host: ")
    {
        ("Status: host startup failed", detail.trim(), false)
    } else if let Some(detail) =
        normalized.strip_prefix("extension host did not emit ready handshake: ")
    {
        ("Status: host startup failed", detail.trim(), false)
    } else if let Some(detail) =
        normalized.strip_prefix("unsupported extension host protocol version: ")
    {
        ("Status: host startup failed", detail.trim(), false)
    } else if let Some(detail) =
        normalized.strip_prefix("extension host emitted invalid ready event: ")
    {
        ("Status: host startup failed", detail.trim(), false)
    } else if let Some(detail) =
        normalized.strip_prefix("extension host emitted unexpected startup event: ")
    {
        ("Status: host startup failed", detail.trim(), false)
    } else if let Some(detail) = normalized.strip_prefix("failed writing extension host request: ")
    {
        ("Status: host request write failed", detail.trim(), false)
    } else {
        ("Status: host command failed", normalized, false)
    };

    let detail = if detail.is_empty() {
        None
    } else {
        Some(detail.to_string())
    };

    (status, detail, stderr_lines, reset_hint)
}

pub(super) fn split_command_tokens(input: &str) -> Result<Vec<String>, String> {
    let mut tokens = Vec::new();
    let mut current = String::new();
    let mut quote: Option<char> = None;
    let mut chars = input.chars().peekable();

    while let Some(ch) = chars.next() {
        if let Some(active_quote) = quote {
            if ch == active_quote {
                quote = None;
            } else if ch == '\\' {
                if let Some(next) = chars.next() {
                    current.push(next);
                }
            } else {
                current.push(ch);
            }
            continue;
        }

        match ch {
            '\'' | '"' => quote = Some(ch),
            ' ' | '\t' if !current.is_empty() => {
                tokens.push(std::mem::take(&mut current));
            }
            ' ' | '\t' => {}
            '\\' => {
                if let Some(next) = chars.next() {
                    current.push(next);
                }
            }
            _ => current.push(ch),
        }
    }

    if quote.is_some() {
        return Err("unterminated quoted string".to_string());
    }

    if !current.is_empty() {
        tokens.push(current);
    }

    Ok(tokens)
}
