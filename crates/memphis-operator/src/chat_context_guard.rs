//! Context-window enforcement for the Rust operator chat path.
//!
//! The TypeScript gateway trims history before every provider call
//! (`enforceContextWindowBeforeProvider` in src/gateway/turn-runtime.ts).
//! The Rust operator only capped how many rows it loaded
//! (`MEMPHIS_CHAT_MAX_MESSAGES`), so a long conversation could build a
//! prompt larger than the model's window and the provider answered HTTP 400
//! "context window exceeds limit" instead of Memphis trimming. The TUI even
//! advertised the behaviour ("Memphis now trims old turns before provider
//! calls") while the Rust path did not implement it.
//!
//! This module mirrors the TypeScript semantics: same target ratio, same
//! estimate, same order (drop oldest first, then shorten the largest
//! message). One deliberate difference: after dropping a message the Rust
//! side also removes tool results whose assistant call was dropped. A
//! dangling tool message is rejected by OpenAI-compatible providers
//! ("tool result's tool id(...) not found"), so trimming that leaves
//! orphans would trade one 400 for another.

use std::collections::HashSet;

use crate::provider::ChatMessage;

/// Share of the context window we are willing to fill.
const TARGET_WINDOW_RATIO: f64 = 0.92;
/// Floor for the target, so a tiny window still allows a short exchange.
const MIN_TARGET_TOKENS: u64 = 512;
/// Floor for a single message's content when shortening it.
const MIN_MESSAGE_CHARS: usize = 128;
/// Marker appended to a shortened message — identical wording to the
/// TypeScript side so both surfaces leave the same breadcrumb in the
/// transcript.
const TRIM_MARKER: &str = "\n\n[context trimmed: message shortened before provider call]";

/// Outcome of one guard pass.
#[derive(Debug, Clone)]
pub(crate) struct ContextWindowGuardResult {
    /// The messages to send to the provider, trimmed to fit the window.
    pub(crate) messages: Vec<ChatMessage>,
    /// How many messages were dropped entirely.
    pub(crate) trimmed_messages: usize,
    /// How many messages were shortened.
    pub(crate) truncated_messages: usize,
}

/// Input for one guard pass.
pub(crate) struct ContextWindowGuardInput<'a> {
    /// The system prompt, sent next to the messages.
    pub(crate) system_prompt: Option<&'a str>,
    /// The conversation as it stands.
    pub(crate) messages: &'a [ChatMessage],
    /// Context window the model declares (capability snapshot).
    pub(crate) declared_context_window: Option<u64>,
    /// Context window the account granted, when stricter than the model's.
    pub(crate) account_context_window: Option<u64>,
}

/// Trim the conversation so the prompt fits the effective context window.
///
/// The effective window is the smaller of the declared and the account
/// limit: an account may narrow a model's window, never widen it.
pub(crate) fn enforce_context_window_before_provider(
    input: ContextWindowGuardInput<'_>,
) -> ContextWindowGuardResult {
    let Some(window) =
        resolve_context_window(input.declared_context_window, input.account_context_window)
    else {
        return ContextWindowGuardResult {
            messages: input.messages.to_vec(),
            trimmed_messages: 0,
            truncated_messages: 0,
        };
    };
    let target = (((window as f64) * TARGET_WINDOW_RATIO).floor() as u64).max(MIN_TARGET_TOKENS);

    let mut messages = input.messages.to_vec();
    let mut trimmed_messages = 0usize;
    let mut truncated_messages = 0usize;

    // 1. Drop the oldest non-system messages until the prompt fits. The last
    //    message is never dropped: it carries the turn the operator asked for.
    while messages.len() > 1 && estimate_prompt_tokens(input.system_prompt, &messages) > target {
        let Some(index) = messages
            .iter()
            .enumerate()
            .find(|(index, message)| *index < messages.len() - 1 && !is_system(message))
            .map(|(index, _)| index)
        else {
            break;
        };
        messages.remove(index);
        trimmed_messages += 1;
    }
    // Dropping an assistant message with tool calls orphans its tool
    // results; providers reject those.
    drop_orphaned_tool_messages(&mut messages);

    // 2. Still too large: shorten the biggest non-system message.
    while estimate_prompt_tokens(input.system_prompt, &messages) > target {
        let Some(index) = largest_message_index(&messages) else {
            break;
        };
        let length = messages[index].content().chars().count();
        if length <= MIN_MESSAGE_CHARS {
            break;
        }
        let excess = estimate_prompt_tokens(input.system_prompt, &messages) - target;
        let reduce = (excess as usize)
            .saturating_mul(4)
            .saturating_add(512)
            .max(length / 4);
        let keep = MIN_MESSAGE_CHARS.max(length.saturating_sub(reduce));
        let Some(shortened) = shorten_message_content(&messages[index], keep) else {
            break;
        };
        set_message_content(&mut messages[index], shortened);
        truncated_messages += 1;
    }

    ContextWindowGuardResult {
        messages,
        trimmed_messages,
        truncated_messages,
    }
}

/// The account may only narrow the window; widening it would let a prompt
/// past a limit the upstream API still enforces.
fn resolve_context_window(declared: Option<u64>, account: Option<u64>) -> Option<u64> {
    let declared = declared.filter(|value| *value > 0);
    let account = account.filter(|value| *value > 0);
    match (declared, account) {
        (None, None) => None,
        (Some(declared), None) => Some(declared),
        (None, Some(account)) => Some(account),
        (Some(declared), Some(account)) => Some(declared.min(account)),
    }
}

/// Rough prompt size in tokens: characters / 4, the same estimate the
/// TypeScript side uses. The count is per Unicode scalar, so text outside
/// the BMP is counted slightly lower than the JavaScript length would.
fn estimate_prompt_tokens(system_prompt: Option<&str>, messages: &[ChatMessage]) -> u64 {
    let mut parts: Vec<String> = Vec::with_capacity(messages.len() + 1);
    if let Some(prompt) = system_prompt
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        parts.push(prompt.to_string());
    }
    for message in messages {
        parts.push(serialize_message(message));
    }
    let joined = parts.join("\n\n");
    if joined.trim().is_empty() {
        return 0;
    }
    (joined.chars().count() as u64).div_ceil(4)
}

/// Flatten a message the way the provider would see it.
fn serialize_message(message: &ChatMessage) -> String {
    match message {
        ChatMessage::System { content } | ChatMessage::User { content } => content.clone(),
        ChatMessage::Assistant {
            content,
            tool_calls,
            ..
        } => {
            if tool_calls.is_empty() {
                content.clone()
            } else {
                let calls = serde_json::to_string(tool_calls).unwrap_or_default();
                format!("{content}\n{calls}")
            }
        }
        ChatMessage::Tool {
            tool_call_id,
            content,
        } => format!("{tool_call_id}\n{content}"),
    }
}

fn is_system(message: &ChatMessage) -> bool {
    matches!(message, ChatMessage::System { .. })
}

/// Index of the longest non-system message. Ties keep the earliest one, so
/// repeated passes shorten the same message instead of walking the list.
fn largest_message_index(messages: &[ChatMessage]) -> Option<usize> {
    let mut best: Option<(usize, usize)> = None;
    for (index, message) in messages.iter().enumerate() {
        if is_system(message) {
            continue;
        }
        let length = message.content().chars().count();
        if best
            .map(|(_, best_length)| length > best_length)
            .unwrap_or(true)
        {
            best = Some((index, length));
        }
    }
    best.map(|(index, _)| index)
}

/// Shorten a message to `max_chars`, keeping its head and tail with the
/// trim marker in between. Returns `None` when the message is already short
/// enough — shortening it would not buy anything.
fn shorten_message_content(message: &ChatMessage, max_chars: usize) -> Option<String> {
    let content = message.content();
    let chars: Vec<char> = content.chars().collect();
    if chars.len() <= max_chars {
        return None;
    }
    let marker_len = TRIM_MARKER.chars().count();
    let safe_max = max_chars.saturating_sub(marker_len).max(64);
    if chars.len() <= safe_max + marker_len {
        return None;
    }
    if safe_max <= MIN_MESSAGE_CHARS {
        let head: String = chars[..safe_max.min(chars.len())].iter().collect();
        return Some(format!("{}{TRIM_MARKER}", head.trim_end()));
    }
    let head_chars = ((safe_max as f64) * 0.65).floor() as usize;
    let tail_chars = safe_max.saturating_sub(head_chars).max(64);
    let head: String = chars[..head_chars.min(chars.len())].iter().collect();
    let tail: String = chars[chars.len().saturating_sub(tail_chars)..]
        .iter()
        .collect();
    Some(format!(
        "{}{TRIM_MARKER}\n\n{}",
        head.trim_end(),
        tail.trim_start()
    ))
}

fn set_message_content(message: &mut ChatMessage, content: String) {
    match message {
        ChatMessage::System { content: slot }
        | ChatMessage::User { content: slot }
        | ChatMessage::Assistant { content: slot, .. }
        | ChatMessage::Tool { content: slot, .. } => *slot = content,
    }
}

/// Remove tool results whose assistant call is no longer in the window.
fn drop_orphaned_tool_messages(messages: &mut Vec<ChatMessage>) {
    let mut known_call_ids: HashSet<String> = HashSet::new();
    for message in messages.iter() {
        if let ChatMessage::Assistant { tool_calls, .. } = message {
            for call in tool_calls {
                known_call_ids.insert(call.id.clone());
            }
        }
    }
    messages.retain(|message| match message {
        ChatMessage::Tool { tool_call_id, .. } => known_call_ids.contains(tool_call_id),
        _ => true,
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::provider::ChatToolCall;
    use serde_json::json;

    fn user(content: &str) -> ChatMessage {
        ChatMessage::User {
            content: content.to_string(),
        }
    }

    #[test]
    fn keeps_a_conversation_that_fits_the_window() {
        let messages = vec![user("first"), user("second")];
        let result = enforce_context_window_before_provider(ContextWindowGuardInput {
            system_prompt: Some("system"),
            messages: &messages,
            declared_context_window: Some(100_000),
            account_context_window: None,
        });
        assert_eq!(result.messages.len(), 2);
        assert_eq!(result.trimmed_messages, 0);
        assert_eq!(result.truncated_messages, 0);
    }

    #[test]
    fn without_a_window_nothing_is_trimmed() {
        let messages = vec![user(&"x".repeat(50_000)), user("last")];
        let result = enforce_context_window_before_provider(ContextWindowGuardInput {
            system_prompt: None,
            messages: &messages,
            declared_context_window: None,
            account_context_window: None,
        });
        assert_eq!(result.messages.len(), 2);
        assert_eq!(result.trimmed_messages, 0);
        assert_eq!(result.truncated_messages, 0);
        assert_eq!(result.messages[0].content().len(), 50_000);
    }

    #[test]
    fn drops_the_oldest_messages_until_the_prompt_fits() {
        let messages: Vec<ChatMessage> = (0..10)
            .map(|index| user(&format!("m{index}{}", "x".repeat(1_000))))
            .collect();
        let result = enforce_context_window_before_provider(ContextWindowGuardInput {
            system_prompt: None,
            messages: &messages,
            declared_context_window: Some(1_000),
            account_context_window: None,
        });
        assert!(result.trimmed_messages > 0, "expected trimming");
        assert!(result.messages.len() < messages.len());
        // The newest message is the turn the operator asked for — never dropped.
        assert!(result
            .messages
            .last()
            .map(ChatMessage::content)
            .unwrap_or_default()
            .starts_with("m9"));
        // The oldest ones are gone.
        assert!(!result
            .messages
            .iter()
            .any(|message| message.content().starts_with("m0")));
    }

    #[test]
    fn never_drops_the_system_message() {
        let system = "s".repeat(5_000);
        let messages = vec![
            ChatMessage::System {
                content: system.clone(),
            },
            user(&"u".repeat(5_000)),
        ];
        let result = enforce_context_window_before_provider(ContextWindowGuardInput {
            system_prompt: None,
            messages: &messages,
            declared_context_window: Some(1_000),
            account_context_window: None,
        });
        assert_eq!(result.messages.len(), 2);
        assert_eq!(result.messages[0].content(), system.as_str());
        assert_eq!(result.truncated_messages, 1);
        assert!(result.messages[1].content().contains("[context trimmed"));
    }

    #[test]
    fn account_window_narrows_the_declared_window() {
        let messages: Vec<ChatMessage> = (0..6)
            .map(|index| user(&format!("{index}{}", "x".repeat(1_000))))
            .collect();
        let declared_only = enforce_context_window_before_provider(ContextWindowGuardInput {
            system_prompt: None,
            messages: &messages,
            declared_context_window: Some(1_000_000),
            account_context_window: None,
        });
        assert_eq!(declared_only.messages.len(), messages.len());
        assert_eq!(declared_only.trimmed_messages, 0);

        let account_limited = enforce_context_window_before_provider(ContextWindowGuardInput {
            system_prompt: None,
            messages: &messages,
            declared_context_window: Some(1_000_000),
            account_context_window: Some(1_000),
        });
        assert!(
            account_limited.messages.len() < messages.len(),
            "the account limit must narrow the declared window"
        );
        assert!(account_limited.trimmed_messages > 0);
    }

    #[test]
    fn shortens_the_largest_message_when_dropping_is_not_enough() {
        let original = "x".repeat(100_000);
        let messages = vec![user(&original)];
        let result = enforce_context_window_before_provider(ContextWindowGuardInput {
            system_prompt: None,
            messages: &messages,
            declared_context_window: Some(1_000),
            account_context_window: None,
        });
        assert_eq!(result.messages.len(), 1);
        assert!(result.truncated_messages >= 1);
        assert!(result.messages[0].content().len() < original.len());
        assert!(result.messages[0].content().contains("[context trimmed"));
    }

    #[test]
    fn drops_tool_results_whose_assistant_call_was_dropped() {
        let messages = vec![
            ChatMessage::Assistant {
                content: "x".repeat(40_000),
                tool_calls: vec![ChatToolCall {
                    id: "call-1".into(),
                    name: "memphis_recall".into(),
                    arguments: json!({ "query": "fixture" }),
                }],
                reasoning_content: None,
            },
            ChatMessage::Tool {
                tool_call_id: "call-1".into(),
                content: "small result".into(),
            },
            user("final question"),
        ];
        let result = enforce_context_window_before_provider(ContextWindowGuardInput {
            system_prompt: None,
            messages: &messages,
            declared_context_window: Some(2_000),
            account_context_window: None,
        });
        assert_eq!(result.trimmed_messages, 1);
        assert_eq!(
            result.messages.len(),
            1,
            "the orphaned tool result must not survive its assistant"
        );
        assert_eq!(result.messages[0].content(), "final question");
    }
}
