//! Lossless deduplication of repeated read results in provider context.
//! The durable transcript and every user instruction/tool pair are preserved.
use std::collections::HashMap;
use sha2::{Digest, Sha256};
use crate::provider::ChatMessage;

pub(crate) fn provider_context(messages: &[ChatMessage]) -> Vec<ChatMessage> {
    let mut tool_names = HashMap::new();
    for message in messages {
        if let ChatMessage::Assistant { tool_calls, .. } = message {
            for call in tool_calls { tool_names.insert(call.id.as_str(), call.name.as_str()); }
        }
    }
    let mut retained = HashMap::new();
    let mut context = messages.to_vec();
    // Keep the most recent full result; earlier exact duplicates point to it.
    for message in context.iter_mut().rev() {
        if let ChatMessage::Tool { tool_call_id, content } = message {
            let Some(name) = tool_names.get(tool_call_id.as_str()) else { continue };
            if !matches!(*name, "memphis_code_read" | "memphis_grep" | "memphis_glob" | "memphis_chain_query" | "memphis_recall" | "memphis_search") || content.len() < 1024 {
                continue;
            }
            let digest = format!("{name}:{:x}", Sha256::digest(content.as_bytes()));
            if let Some(id) = retained.get(&digest) {
                *content = format!("[Exact duplicate read result. Full identical content retained at tool_call_id={id}.]");
            } else { retained.insert(digest, tool_call_id.clone()); }
        }
    }
    context
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::provider::ChatToolCall;
    use serde_json::json;
    #[test]
    fn preserves_instructions_pairs_and_transcript_while_deduplicating_reads() {
        let content = "Pamiętaj o dowodach i ścieżkach.\n".repeat(300);
        let mut messages = vec![ChatMessage::User { content: "Continue the original task; preserve my constraints".into() }];
        for id in ["first", "second", "third"] {
            messages.push(ChatMessage::Assistant {
                content: String::new(),
                tool_calls: vec![ChatToolCall { id: id.into(), name: "memphis_code_read".into(), arguments: json!({"path":"README.md"}) }],
                reasoning_content: None,
            });
            messages.push(ChatMessage::Tool { tool_call_id: id.into(), content: content.clone() });
        }
        let context = provider_context(&messages);
        assert_eq!(context.len(), messages.len());
        assert_eq!(context[0].content(), messages[0].content());
        assert_eq!(context.last().unwrap().content(), content);
        assert_eq!(messages[2].content(), content);
        let before: usize = messages.iter().map(|m| m.content().len()).sum();
        let after: usize = context.iter().map(|m| m.content().len()).sum();
        assert!(after < before / 2);
        for (original, compacted) in messages.iter().zip(context.iter()) {
            if let (ChatMessage::Tool { tool_call_id: a, .. }, ChatMessage::Tool { tool_call_id: b, .. }) = (original, compacted) { assert_eq!(a, b); }
        }
    }
    #[test]
    fn does_not_deduplicate_mutations_or_unknown_tool_results() {
        let text = "x".repeat(2048);
        let messages = vec![ChatMessage::Tool { tool_call_id: "unknown".into(), content: text.clone() }, ChatMessage::Tool { tool_call_id: "unknown".into(), content: text.clone() }];
        assert_eq!(provider_context(&messages)[0].content(), text);
    }
}
