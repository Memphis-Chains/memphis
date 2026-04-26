//! Free formatting helpers used by the TUI: token-usage rendering,
//! context-pressure summarization, the `LineTone`-keyed `styled` family,
//! and small JSON shape helpers.
//!
//! Extracted from `app/mod.rs` (S4 PR 4). Pure functions only — no
//! `AppState` access. Submodule of `app`, so callers in mod.rs and
//! sibling submodules see these helpers via the `pub(super) use` glob
//! re-export at the top of `app/mod.rs`.

use memphis_operator::{TelegramReadinessSummary, TokenUsageSummary};
use serde_json::Value;

use super::{
    ContextPressureLevel, ContextPressureSummary, DegradationState, LineTone, StyledLine,
};

pub(super) fn format_token_count(tokens: u32) -> String {
    if tokens >= 1_000 {
        if tokens % 1_024 == 0 {
            format!("{}k", tokens / 1_024)
        } else if tokens % 1_000 == 0 {
            format!("{}k", tokens / 1_000)
        } else {
            format!("{:.1}k", tokens as f32 / 1_000.0)
        }
    } else {
        tokens.to_string()
    }
}

pub(super) fn estimate_tokens_from_chars(chars: usize) -> u32 {
    chars.div_ceil(4) as u32
}

#[cfg(test)]
pub(super) fn format_status_token_usage(usage: &TokenUsageSummary) -> String {
    if usage.estimated {
        format!("tok~:{}", usage.total_tokens)
    } else {
        format!("tok:{}", usage.total_tokens)
    }
}

pub(super) fn format_full_token_usage(usage: &TokenUsageSummary) -> String {
    let prefix = if usage.estimated { "tok~" } else { "tok" };
    format!(
        "{prefix} p:{} c:{} t:{}",
        usage.prompt_tokens, usage.completion_tokens, usage.total_tokens
    )
}

pub(super) fn derive_context_pressure_summary(
    context_window_tokens: Option<u32>,
    usage: Option<&TokenUsageSummary>,
) -> Option<ContextPressureSummary> {
    let context_window_tokens = context_window_tokens?;
    let usage = usage?;
    let remaining_context_tokens = context_window_tokens.saturating_sub(usage.prompt_tokens);
    let level = if remaining_context_tokens <= 2_048 {
        ContextPressureLevel::High
    } else if remaining_context_tokens <= 4_096 {
        ContextPressureLevel::Medium
    } else {
        ContextPressureLevel::Low
    };
    Some(ContextPressureSummary {
        level,
        remaining_context_tokens,
        estimated: usage.estimated,
    })
}

#[cfg(test)]
pub(super) fn format_status_pressure(pressure: &ContextPressureSummary) -> String {
    let remaining = format_token_count(pressure.remaining_context_tokens);
    if pressure.estimated {
        format!("prs:{} rem~:{remaining}", pressure.level.short_label())
    } else {
        format!("prs:{} rem:{remaining}", pressure.level.short_label())
    }
}

pub(super) fn format_full_context_headroom(pressure: &ContextPressureSummary) -> String {
    let remaining = format_token_count(pressure.remaining_context_tokens);
    if pressure.estimated {
        format!("~{remaining} tokens")
    } else {
        format!("{remaining} tokens")
    }
}

pub(super) fn format_degradation_summary(state: &DegradationState) -> String {
    let provider = state.actual_provider.trim();
    let reason = state.reason.trim();
    match (provider.is_empty(), reason.is_empty()) {
        (true, true) => "active".to_string(),
        (false, true) => format!("active via {provider}"),
        (true, false) => format!("active ({reason})"),
        (false, false) => format!("active via {provider} ({reason})"),
    }
}

pub(super) fn styled(content: impl Into<String>, tone: LineTone) -> StyledLine {
    StyledLine {
        content: content.into(),
        tone,
    }
}

pub(super) fn blank() -> StyledLine {
    plain("")
}

pub(super) fn plain(content: impl Into<String>) -> StyledLine {
    styled(content, LineTone::Plain)
}

pub(super) fn title(content: impl Into<String>) -> StyledLine {
    styled(content, LineTone::Title)
}

pub(super) fn section(content: impl Into<String>) -> StyledLine {
    styled(content, LineTone::Section)
}

pub(super) fn info(content: impl Into<String>) -> StyledLine {
    styled(content, LineTone::Info)
}

pub(super) fn success(content: impl Into<String>) -> StyledLine {
    styled(content, LineTone::Success)
}

pub(super) fn warning(content: impl Into<String>) -> StyledLine {
    styled(content, LineTone::Warning)
}

pub(super) fn error_line(content: impl Into<String>) -> StyledLine {
    styled(content, LineTone::Error)
}

pub(super) fn dim(content: impl Into<String>) -> StyledLine {
    styled(content, LineTone::Dim)
}

pub(super) fn accent(content: impl Into<String>) -> StyledLine {
    styled(content, LineTone::Accent)
}

pub(super) fn prompt(content: impl Into<String>) -> StyledLine {
    styled(content, LineTone::Prompt)
}

pub(super) fn yes_no(value: bool) -> &'static str {
    if value {
        "yes"
    } else {
        "no"
    }
}

pub(super) fn telegram_state_line(summary: &TelegramReadinessSummary) -> StyledLine {
    let tone = match summary.state.as_str() {
        "ready" => LineTone::Success,
        "configured" => LineTone::Warning,
        "disabled" => LineTone::Dim,
        _ => LineTone::Error,
    };
    styled(format!("State: {}", summary.state), tone)
}

pub(super) fn json_value_as_string(value: Option<&Value>) -> Option<String> {
    match value {
        Some(Value::String(text)) => Some(text.clone()),
        Some(Value::Number(number)) => Some(number.to_string()),
        Some(Value::Bool(flag)) => Some(flag.to_string()),
        _ => None,
    }
}

pub(super) fn json_string_list(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| match item {
                    Value::String(text) => Some(text.clone()),
                    Value::Number(number) => Some(number.to_string()),
                    Value::Bool(flag) => Some(flag.to_string()),
                    _ => None,
                })
                .collect()
        })
        .unwrap_or_default()
}
