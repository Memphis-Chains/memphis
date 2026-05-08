use std::{
    io::{BufRead, BufReader},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc,
    },
    thread,
    time::Duration,
};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::{runtime::try_read_vault_secret_plaintext, OperatorConfig, OperatorError};

/// Sanitize a string for JSON serialization.
/// JSON only supports `\uXXXX` and `\\` escapes. Invalid `\xNN` (1-digit hex)
/// or incomplete `\x` escapes must be converted/removed or serde_json will
/// produce invalid JSON that DeepSeek and other providers reject.
///
/// Non-ASCII input must be preserved as full UTF-8 characters. Previously
/// this function walked raw bytes and used `b as char`, which turned multi-
/// byte UTF-8 sequences into individual Latin-1 code points — e.g. Polish
/// `ę` (bytes 0xC4 0x99) became `Ä` + `\u{0099}`, and after re-encoding to
/// UTF-8 rendered as mojibake like `JÄ™zyki` in the chat response.
fn sanitize_for_json(content: &str) -> String {
    let mut result = String::with_capacity(content.len());
    let bytes = content.as_bytes();
    let mut i = 0;

    while i < bytes.len() {
        let b = bytes[i];
        if b == b'\\' && i + 1 < bytes.len() {
            let next = bytes[i + 1];
            if next == b'\\' {
                result.push_str("\\\\");
                i += 2;
                continue;
            }
            if next == b'u' {
                if i + 5 < bytes.len() && bytes[i + 2..i + 6].iter().all(|c| c.is_ascii_hexdigit())
                {
                    result.push_str(&content[i..i + 6]);
                    i += 6;
                } else {
                    result.push('\u{FFFD}');
                    i += 2;
                }
                continue;
            }
            if next.is_ascii_hexdigit() {
                let mut hex_len = 0;
                let mut j = i + 2;
                while j < bytes.len() && bytes[j].is_ascii_hexdigit() && hex_len < 2 {
                    hex_len += 1;
                    j += 1;
                }
                match hex_len {
                    2 => {
                        result.push_str("\\u00");
                        result.push(bytes[i + 2] as char);
                        result.push(bytes[i + 3] as char);
                        i += 4;
                    }
                    1 => {
                        result.push('\u{FFFD}');
                        i += 3;
                    }
                    _ => {
                        result.push('\u{FFFD}');
                        i += 1;
                    }
                }
                continue;
            }
            // Unknown escape (\n \t \" etc) — preserve the backslash and let
            // the following byte be handled by the next loop iteration.
            result.push('\\');
            i += 1;
            continue;
        }

        if b < 0x20 || b == 0x7F {
            if b == b'\t' || b == b'\n' || b == b'\r' {
                result.push(b as char);
            }
            i += 1;
        } else if b < 0x80 {
            result.push(b as char);
            i += 1;
        } else {
            // Multi-byte UTF-8. `content` is `&str`, so `i` is guaranteed to
            // sit on a char boundary (we only step by full char widths or by
            // 1 for ASCII bytes). Copy the whole char, not a single byte.
            let ch = content[i..]
                .chars()
                .next()
                .expect("byte at char boundary has a char");
            result.push(ch);
            i += ch.len_utf8();
        }
    }

    result
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum ChatMessage {
    System {
        content: String,
    },
    User {
        content: String,
    },
    Assistant {
        content: String,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        tool_calls: Vec<ChatToolCall>,
    },
    Tool {
        tool_call_id: String,
        content: String,
    },
}

impl ChatMessage {
    pub fn content(&self) -> &str {
        match self {
            ChatMessage::System { content }
            | ChatMessage::User { content }
            | ChatMessage::Assistant { content, .. }
            | ChatMessage::Tool { content, .. } => content.as_str(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatToolDefinition {
    pub name: String,
    pub description: String,
    pub input_schema: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatToolCall {
    pub id: String,
    pub name: String,
    pub arguments: Value,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TokenUsageSummary {
    pub prompt_tokens: u32,
    pub completion_tokens: u32,
    pub total_tokens: u32,
    #[serde(default)]
    pub estimated: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ChatStreamEvent {
    Text(String),
    Usage(TokenUsageSummary),
}

#[derive(Debug, Clone, Default)]
pub struct ChatRequestOptions {
    pub provider: Option<String>,
    pub model: Option<String>,
    pub system_prompt: Option<String>,
    pub temperature: Option<f32>,
    pub max_tokens: Option<u32>,
}

#[derive(Debug, Clone)]
pub struct ChatCompletion {
    pub content: String,
    pub model: String,
    pub provider: String,
    pub tool_calls: Vec<ChatToolCall>,
    pub token_usage: Option<TokenUsageSummary>,
}

#[derive(Debug, Clone)]
pub struct ProviderStatus {
    pub name: String,
    pub configured: bool,
    pub available: bool,
    pub default_model: String,
    pub models: Vec<String>,
    pub model_capabilities: Vec<ModelCapabilitySummary>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ModelCapabilitySummary {
    pub model: String,
    pub context_window_tokens: Option<u32>,
    pub supports_streaming: bool,
    pub supports_vision: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ProviderKind {
    LocalFallback,
    SharedLlm,
    DecentralizedLlm,
    Ollama,
    Minimax,
    Deepseek,
    Glm,
    Anthropic,
}

#[derive(Debug, Clone)]
pub struct ProviderRuntime {
    kind: ProviderKind,
    name: String,
    base_url: Option<String>,
    api_key: Option<String>,
    /// Pre-formatted operator-actionable hint emitted when `api_key` is None.
    /// Populated at resolve time by `diagnose_missing_api_key` so the error
    /// at request time can name the actual failure mode (env not set vs.
    /// vault entry missing) rather than the opaque "missing api key".
    /// Empty for providers that never expect a key (local-fallback, ollama).
    api_key_missing_hint: String,
    default_model: String,
    timeout_ms: u64,
}

impl ProviderRuntime {
    pub fn default_model(&self) -> &str {
        self.default_model.as_str()
    }

    /// Borrow the api_key or fail with an operator-actionable hint.
    ///
    /// Replaces the 5 inline `self.api_key.as_deref().ok_or_else(...)` blocks
    /// that all formatted the same opaque "provider X missing api key"
    /// message — operators hit this in TUI 2026-04-26 with no idea whether
    /// the env was missing, the vault entry was missing, or the vault read
    /// failed. The hint is precomputed in `resolve_provider` and lives on
    /// `self.api_key_missing_hint`.
    fn require_api_key(&self) -> Result<&str, OperatorError> {
        self.api_key.as_deref().ok_or_else(|| {
            let detail = if self.api_key_missing_hint.is_empty() {
                String::new()
            } else {
                format!(" — {}", self.api_key_missing_hint)
            };
            OperatorError::Message(format!("provider {} missing api key{detail}", self.name))
        })
    }

    pub fn status(&self) -> ProviderStatus {
        let configured = self.is_configured();
        let availability = self.check_availability();
        let mut models = self.list_models();
        if !models.iter().any(|model| model == &self.default_model) {
            models.insert(0, self.default_model.clone());
        }
        ProviderStatus {
            name: self.name.clone(),
            configured,
            available: availability.is_ok(),
            default_model: self.default_model.clone(),
            model_capabilities: models
                .iter()
                .map(|model| self.model_capability(model))
                .collect(),
            models,
            error: availability.err(),
        }
    }

    #[allow(dead_code)]
    pub fn chat(
        &self,
        messages: &[ChatMessage],
        opts: &ChatRequestOptions,
        tools: &[ChatToolDefinition],
    ) -> Result<ChatCompletion, OperatorError> {
        let model = opts
            .model
            .as_deref()
            .filter(|value| !value.trim().is_empty())
            .unwrap_or(self.default_model());

        match self.kind {
            ProviderKind::LocalFallback => {
                let input = build_generate_input_from_chat(messages, opts, tools);
                let content = format!("Fallback response: {input}");
                Ok(ChatCompletion {
                    content: content.clone(),
                    model: model.to_string(),
                    provider: self.name.clone(),
                    tool_calls: Vec::new(),
                    token_usage: Some(estimated_text_usage(input.as_str(), content.as_str())),
                })
            }
            ProviderKind::SharedLlm | ProviderKind::DecentralizedLlm => {
                self.chat_generate_provider(messages, opts, tools, model, None)
            }
            ProviderKind::Ollama => self.chat_ollama(messages, opts, tools, model),
            ProviderKind::Minimax => self.chat_openai_compatible(
                messages,
                opts,
                tools,
                model,
                self.base_url
                    .clone()
                    .unwrap_or_else(|| "https://api.minimax.io/v1".to_string())
                    .trim_end_matches('/')
                    .to_string(),
            ),
            ProviderKind::Deepseek => self.chat_openai_compatible(
                messages,
                opts,
                tools,
                model,
                self.base_url
                    .clone()
                    .unwrap_or_else(|| "https://api.deepseek.com".to_string())
                    .trim_end_matches('/')
                    .to_string(),
            ),
            ProviderKind::Glm => self.chat_openai_compatible(
                messages,
                opts,
                tools,
                model,
                self.base_url
                    .clone()
                    .unwrap_or_else(|| "https://open.bigmodel.cn/api/paas/v4".to_string())
                    .trim_end_matches('/')
                    .to_string(),
            ),
            ProviderKind::Anthropic => self.chat_anthropic(messages, opts, tools, model),
        }
    }

    pub fn chat_stream_with_cancel<F>(
        &self,
        messages: &[ChatMessage],
        opts: &ChatRequestOptions,
        tools: &[ChatToolDefinition],
        cancel_flag: Option<&AtomicBool>,
        mut on_event: F,
    ) -> Result<ChatCompletion, OperatorError>
    where
        F: FnMut(ChatStreamEvent),
    {
        let model = opts
            .model
            .as_deref()
            .filter(|value| !value.trim().is_empty())
            .unwrap_or(self.default_model());

        match self.kind {
            ProviderKind::LocalFallback => {
                ensure_not_cancelled(cancel_flag)?;
                let input = build_generate_input_from_chat(messages, opts, tools);
                // Local-fallback is the always-respond provider for when no
                // LLM is reachable. Echoing the full prompt back was debug
                // noise (made operator wait through 14KB of soul context
                // streamed at 50ms/word). Now: short, honest acknowledgement
                // that the runtime is alive but no real LLM is wired.
                let content = "[local-fallback] No LLM configured — runtime is alive but cannot answer substantively. Configure a provider (memphis vault add --key <provider>_api_key) and re-select with /provider <name>.".to_string();
                let token_usage = estimated_text_usage(input.as_str(), content.as_str());
                on_event(ChatStreamEvent::Usage(token_usage.clone()));
                // No artificial delay — local-fallback has no real LLM
                // latency to simulate; instant emit is the right UX.
                emit_text_chunks(content.as_str(), cancel_flag, None, &mut on_event)?;
                Ok(ChatCompletion {
                    content,
                    model: model.to_string(),
                    provider: self.name.clone(),
                    tool_calls: Vec::new(),
                    token_usage: Some(token_usage),
                })
            }
            ProviderKind::SharedLlm | ProviderKind::DecentralizedLlm => {
                let completion =
                    self.chat_generate_provider(messages, opts, tools, model, cancel_flag)?;
                if let Some(usage) = completion.token_usage.clone() {
                    on_event(ChatStreamEvent::Usage(usage));
                }
                emit_text_chunks(
                    completion.content.as_str(),
                    cancel_flag,
                    None,
                    &mut on_event,
                )?;
                Ok(completion)
            }
            ProviderKind::Ollama => {
                self.chat_ollama_stream(messages, opts, tools, model, cancel_flag, on_event)
            }
            ProviderKind::Minimax => self.chat_openai_compatible_stream(
                messages,
                opts,
                tools,
                model,
                self.base_url
                    .clone()
                    .unwrap_or_else(|| "https://api.minimax.io/v1".to_string())
                    .trim_end_matches('/')
                    .to_string(),
                cancel_flag,
                on_event,
            ),
            ProviderKind::Deepseek => self.chat_openai_compatible_stream(
                messages,
                opts,
                tools,
                model,
                self.base_url
                    .clone()
                    .unwrap_or_else(|| "https://api.deepseek.com".to_string())
                    .trim_end_matches('/')
                    .to_string(),
                cancel_flag,
                on_event,
            ),
            ProviderKind::Glm => self.chat_openai_compatible_stream(
                messages,
                opts,
                tools,
                model,
                self.base_url
                    .clone()
                    .unwrap_or_else(|| "https://open.bigmodel.cn/api/paas/v4".to_string())
                    .trim_end_matches('/')
                    .to_string(),
                cancel_flag,
                on_event,
            ),
            ProviderKind::Anthropic => {
                self.chat_anthropic_stream(messages, opts, tools, model, cancel_flag, on_event)
            }
        }
    }

    fn chat_generate_provider(
        &self,
        messages: &[ChatMessage],
        opts: &ChatRequestOptions,
        tools: &[ChatToolDefinition],
        model: &str,
        cancel_flag: Option<&AtomicBool>,
    ) -> Result<ChatCompletion, OperatorError> {
        let base_url = self.base_url.as_deref().ok_or_else(|| {
            OperatorError::Message(format!("provider {} missing base url", self.name))
        })?;
        let api_key = self.require_api_key()?;
        let url = format!("{}/v1/generate", base_url.trim_end_matches('/'));
        let payload = json!({
            "input": build_generate_input_from_chat(messages, opts, tools),
            "model": model,
            "options": {
                "temperature": opts.temperature.unwrap_or(0.7),
                "maxTokens": opts.max_tokens.unwrap_or(2048),
                "timeoutMs": self.timeout_ms,
            }
        });
        let body = match cancel_flag {
            Some(cancel_flag) => {
                let api_key = api_key.to_string();
                let timeout_ms = self.timeout_ms;
                run_blocking_with_cancel(cancel_flag, move || {
                    post_json(
                        url.as_str(),
                        payload,
                        Some(api_key.as_str()),
                        timeout_ms,
                        &[],
                    )
                })?
            }
            None => post_json(url.as_str(), payload, Some(api_key), self.timeout_ms, &[])?,
        };
        let mut completion = parse_generate_provider_response(body, model, self.name.as_str());
        if completion.token_usage.is_none() {
            completion.token_usage = Some(estimated_chat_usage(
                messages,
                opts,
                tools,
                completion.content.as_str(),
            ));
        }
        Ok(completion)
    }

    #[allow(dead_code)]
    fn chat_ollama(
        &self,
        messages: &[ChatMessage],
        opts: &ChatRequestOptions,
        tools: &[ChatToolDefinition],
        model: &str,
    ) -> Result<ChatCompletion, OperatorError> {
        let base_url = self
            .base_url
            .clone()
            .unwrap_or_else(|| "http://127.0.0.1:11434".to_string());
        let ollama_messages = messages
            .iter()
            .map(ollama_message_to_json)
            .collect::<Vec<_>>();
        let all_messages = if let Some(system_prompt) = opts.system_prompt.as_deref() {
            let mut combined = vec![json!({ "role": "system", "content": system_prompt })];
            combined.extend(ollama_messages);
            combined
        } else {
            ollama_messages
        };
        let body = post_json(
            format!("{}/api/chat", base_url.trim_end_matches('/')).as_str(),
            json!({
                "model": model,
                "messages": all_messages,
                "stream": false,
                "options": {
                    "temperature": opts.temperature.unwrap_or(0.7),
                    "num_predict": opts.max_tokens.unwrap_or(2048),
                },
                "tools": build_tools_json(tools),
            }),
            None,
            self.timeout_ms,
            &[],
        )?;
        let message = body.get("message").cloned().unwrap_or(Value::Null);
        Ok(ChatCompletion {
            content: message
                .get("content")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            model: model.to_string(),
            provider: self.name.clone(),
            tool_calls: parse_tool_calls(message.get("tool_calls").unwrap_or(&Value::Null)),
            token_usage: parse_ollama_usage(&body).or_else(|| {
                Some(estimated_chat_usage(
                    messages,
                    opts,
                    tools,
                    message
                        .get("content")
                        .and_then(Value::as_str)
                        .unwrap_or_default(),
                ))
            }),
        })
    }

    fn chat_ollama_stream<F>(
        &self,
        messages: &[ChatMessage],
        opts: &ChatRequestOptions,
        tools: &[ChatToolDefinition],
        model: &str,
        cancel_flag: Option<&AtomicBool>,
        mut on_event: F,
    ) -> Result<ChatCompletion, OperatorError>
    where
        F: FnMut(ChatStreamEvent),
    {
        ensure_not_cancelled(cancel_flag)?;
        let base_url = self
            .base_url
            .clone()
            .unwrap_or_else(|| "http://127.0.0.1:11434".to_string());
        let ollama_messages = messages
            .iter()
            .map(ollama_message_to_json)
            .collect::<Vec<_>>();
        let all_messages = if let Some(system_prompt) = opts.system_prompt.as_deref() {
            let mut combined = vec![json!({ "role": "system", "content": system_prompt })];
            combined.extend(ollama_messages);
            combined
        } else {
            ollama_messages
        };

        let response = post_response_with_provider(
            format!("{}/api/chat", base_url.trim_end_matches('/')).as_str(),
            json!({
                "model": model,
                "messages": all_messages,
                "stream": true,
                "options": {
                    "temperature": opts.temperature.unwrap_or(0.7),
                    "num_predict": opts.max_tokens.unwrap_or(2048),
                },
                "tools": build_tools_json(tools),
            }),
            None,
            self.timeout_ms,
            &[],
            Some(self.name.as_str()),
        )?;
        let reader = BufReader::new(response.into_reader());
        let mut content = String::new();
        let mut resolved_model = model.to_string();
        let mut tool_calls = Vec::new();
        let mut token_usage = None;
        let mut last_emitted_usage = None;

        for line in reader.lines() {
            ensure_not_cancelled(cancel_flag)?;
            let line = line.map_err(|error| {
                OperatorError::Message(format!("invalid ollama stream response: {error}"))
            })?;
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }

            let payload = serde_json::from_str::<Value>(trimmed).map_err(|error| {
                OperatorError::Message(format!("invalid ollama stream payload: {error}"))
            })?;
            if let Some(stream_model) = payload.get("model").and_then(Value::as_str) {
                resolved_model = stream_model.to_string();
            }
            if let Some(usage) = parse_ollama_usage(&payload) {
                emit_usage_if_changed(&usage, &mut last_emitted_usage, &mut on_event);
                token_usage = Some(usage);
            }

            let message = payload.get("message").cloned().unwrap_or(Value::Null);
            if let Some(token) = message.get("content").and_then(Value::as_str) {
                if !token.is_empty() {
                    ensure_not_cancelled(cancel_flag)?;
                    content.push_str(token);
                    on_event(ChatStreamEvent::Text(token.to_string()));
                }
            }

            let parsed_tool_calls =
                parse_tool_calls(message.get("tool_calls").unwrap_or(&Value::Null));
            if !parsed_tool_calls.is_empty() {
                tool_calls = parsed_tool_calls;
            }

            if payload
                .get("done")
                .and_then(Value::as_bool)
                .unwrap_or(false)
            {
                break;
            }
        }

        let token_usage = token_usage.or_else(|| {
            Some(estimated_chat_usage(
                messages,
                opts,
                tools,
                content.as_str(),
            ))
        });
        if let Some(usage) = token_usage.as_ref() {
            emit_usage_if_changed(usage, &mut last_emitted_usage, &mut on_event);
        }

        Ok(ChatCompletion {
            content,
            model: resolved_model,
            provider: self.name.clone(),
            tool_calls,
            token_usage,
        })
    }

    #[allow(dead_code)]
    fn chat_openai_compatible(
        &self,
        messages: &[ChatMessage],
        opts: &ChatRequestOptions,
        tools: &[ChatToolDefinition],
        model: &str,
        base_url: String,
    ) -> Result<ChatCompletion, OperatorError> {
        let api_key = self.require_api_key()?;
        let provider_messages = messages
            .iter()
            .map(message_to_provider_json)
            .collect::<Vec<_>>();
        let all_messages = if let Some(system_prompt) = opts.system_prompt.as_deref() {
            let mut combined =
                vec![json!({ "role": "system", "content": sanitize_for_json(system_prompt) })];
            combined.extend(provider_messages);
            combined
        } else {
            provider_messages
        };

        let body = post_json(
            format!("{}/chat/completions", base_url).as_str(),
            json!({
                "model": model,
                "messages": all_messages,
                "temperature": opts.temperature.unwrap_or(0.7),
                "max_tokens": opts.max_tokens.unwrap_or(2048),
                "tools": build_tools_json(tools),
            }),
            Some(api_key),
            self.timeout_ms,
            &[],
        )?;
        let message = body
            .get("choices")
            .and_then(Value::as_array)
            .and_then(|choices| choices.first())
            .and_then(|choice| choice.get("message"))
            .cloned()
            .unwrap_or(Value::Null);
        Ok(ChatCompletion {
            content: message
                .get("content")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            model: model.to_string(),
            provider: self.name.clone(),
            tool_calls: parse_tool_calls(message.get("tool_calls").unwrap_or(&Value::Null)),
            token_usage: parse_openai_usage(&body).or_else(|| {
                Some(estimated_chat_usage(
                    messages,
                    opts,
                    tools,
                    message
                        .get("content")
                        .and_then(Value::as_str)
                        .unwrap_or_default(),
                ))
            }),
        })
    }

    fn chat_openai_compatible_stream<F>(
        &self,
        messages: &[ChatMessage],
        opts: &ChatRequestOptions,
        tools: &[ChatToolDefinition],
        model: &str,
        base_url: String,
        cancel_flag: Option<&AtomicBool>,
        mut on_event: F,
    ) -> Result<ChatCompletion, OperatorError>
    where
        F: FnMut(ChatStreamEvent),
    {
        ensure_not_cancelled(cancel_flag)?;
        let api_key = self.require_api_key()?;
        let provider_messages = messages
            .iter()
            .map(message_to_provider_json)
            .collect::<Vec<_>>();
        let all_messages = if let Some(system_prompt) = opts.system_prompt.as_deref() {
            let mut combined =
                vec![json!({ "role": "system", "content": sanitize_for_json(system_prompt) })];
            combined.extend(provider_messages);
            combined
        } else {
            provider_messages
        };

        let response = post_response_with_provider(
            format!("{}/chat/completions", base_url).as_str(),
            json!({
                "model": model,
                "messages": all_messages,
                "temperature": opts.temperature.unwrap_or(0.7),
                "max_tokens": opts.max_tokens.unwrap_or(2048),
                "tools": build_tools_json(tools),
                "stream": true,
            }),
            Some(api_key),
            self.timeout_ms,
            &[("Accept", "text/event-stream")],
            Some(self.name.as_str()),
        )?;
        let reader = BufReader::new(response.into_reader());
        let mut content = String::new();
        let mut resolved_model = model.to_string();
        let mut tool_call_accumulators = Vec::new();
        let mut token_usage = None;
        let mut last_emitted_usage = None;

        for line in reader.lines() {
            ensure_not_cancelled(cancel_flag)?;
            let line = line.map_err(|error| {
                OperatorError::Message(format!("invalid provider stream response: {error}"))
            })?;
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            // Skip comment lines (SSE comments start with :)
            if trimmed.starts_with(':') {
                continue;
            }
            let data = trimmed
                .strip_prefix("data:")
                .map(str::trim)
                .unwrap_or(trimmed);
            if data.is_empty() {
                continue;
            }
            if data == "[DONE]" {
                break;
            }
            let payload = serde_json::from_str::<Value>(data).map_err(|error| {
                let preview = if data.len() > 100 {
                    format!("{}...", &data[..100])
                } else {
                    data.to_string()
                };
                OperatorError::Message(format!(
                    "invalid provider stream payload: {} | data: {}",
                    error, preview
                ))
            })?;
            if let Some(stream_model) = payload.get("model").and_then(Value::as_str) {
                resolved_model = stream_model.to_string();
            }
            if let Some(usage) = parse_openai_usage(&payload) {
                emit_usage_if_changed(&usage, &mut last_emitted_usage, &mut on_event);
                token_usage = Some(usage);
            }
            let delta = payload
                .get("choices")
                .and_then(Value::as_array)
                .and_then(|choices| choices.first())
                .and_then(|choice| choice.get("delta"))
                .cloned()
                .unwrap_or(Value::Null);

            if let Some(token) = delta.get("content").and_then(Value::as_str) {
                if !token.is_empty() {
                    ensure_not_cancelled(cancel_flag)?;
                    content.push_str(token);
                    on_event(ChatStreamEvent::Text(token.to_string()));
                }
            }

            if let Some(tool_calls) = delta.get("tool_calls") {
                apply_stream_tool_call_deltas(tool_calls, &mut tool_call_accumulators);
            }
        }

        let token_usage = token_usage.or_else(|| {
            Some(estimated_chat_usage(
                messages,
                opts,
                tools,
                content.as_str(),
            ))
        });
        if let Some(usage) = token_usage.as_ref() {
            emit_usage_if_changed(usage, &mut last_emitted_usage, &mut on_event);
        }

        Ok(ChatCompletion {
            content,
            model: resolved_model,
            provider: self.name.clone(),
            tool_calls: finalize_stream_tool_calls(tool_call_accumulators),
            token_usage,
        })
    }

    fn chat_anthropic(
        &self,
        messages: &[ChatMessage],
        opts: &ChatRequestOptions,
        tools: &[ChatToolDefinition],
        model: &str,
    ) -> Result<ChatCompletion, OperatorError> {
        let api_key = self.api_key.as_deref().ok_or_else(|| {
            OperatorError::Message("anthropic provider missing ANTHROPIC_API_KEY".to_string())
        })?;
        let base_url = self
            .base_url
            .clone()
            .unwrap_or_else(|| "https://api.anthropic.com".to_string());
        let url = format!("{}/v1/messages", base_url.trim_end_matches('/'));
        let max_tokens = opts.max_tokens.unwrap_or(4096);

        let mut payload = json!({
            "model": model,
            "max_tokens": max_tokens,
            "messages": anthropic_messages_json(messages),
        });
        if let Some(system_prompt) = opts.system_prompt.as_deref() {
            payload["system"] = Value::String(sanitize_for_json(system_prompt));
        }
        let anthropic_tools = anthropic_tools_json(tools);
        if !anthropic_tools.is_empty() {
            payload["tools"] = Value::Array(anthropic_tools);
        }
        if let Some(temp) = opts.temperature {
            payload["temperature"] = json!(temp);
        }

        let body = post_json(
            url.as_str(),
            payload,
            None,
            self.timeout_ms,
            &[("x-api-key", api_key), ("anthropic-version", "2023-06-01")],
        )?;

        let (content, tool_calls) = parse_anthropic_content(&body);
        let token_usage = parse_anthropic_usage(&body).or_else(|| {
            Some(estimated_chat_usage(
                messages,
                opts,
                tools,
                content.as_str(),
            ))
        });

        Ok(ChatCompletion {
            content,
            model: body
                .get("model")
                .and_then(Value::as_str)
                .unwrap_or(model)
                .to_string(),
            provider: self.name.clone(),
            tool_calls,
            token_usage,
        })
    }

    fn chat_anthropic_stream<F>(
        &self,
        messages: &[ChatMessage],
        opts: &ChatRequestOptions,
        tools: &[ChatToolDefinition],
        model: &str,
        cancel_flag: Option<&AtomicBool>,
        mut on_event: F,
    ) -> Result<ChatCompletion, OperatorError>
    where
        F: FnMut(ChatStreamEvent),
    {
        ensure_not_cancelled(cancel_flag)?;
        let api_key = self.api_key.as_deref().ok_or_else(|| {
            OperatorError::Message("anthropic provider missing ANTHROPIC_API_KEY".to_string())
        })?;
        let base_url = self
            .base_url
            .clone()
            .unwrap_or_else(|| "https://api.anthropic.com".to_string());
        let url = format!("{}/v1/messages", base_url.trim_end_matches('/'));
        let max_tokens = opts.max_tokens.unwrap_or(4096);

        let mut payload = json!({
            "model": model,
            "max_tokens": max_tokens,
            "stream": true,
            "messages": anthropic_messages_json(messages),
        });
        if let Some(system_prompt) = opts.system_prompt.as_deref() {
            payload["system"] = Value::String(sanitize_for_json(system_prompt));
        }
        let anthropic_tools = anthropic_tools_json(tools);
        if !anthropic_tools.is_empty() {
            payload["tools"] = Value::Array(anthropic_tools);
        }
        if let Some(temp) = opts.temperature {
            payload["temperature"] = json!(temp);
        }

        let response = post_response_with_provider(
            url.as_str(),
            payload,
            None,
            self.timeout_ms,
            &[
                ("x-api-key", api_key),
                ("anthropic-version", "2023-06-01"),
                ("Accept", "text/event-stream"),
            ],
            Some(self.name.as_str()),
        )?;

        let reader = BufReader::new(response.into_reader());
        let mut content = String::new();
        let mut resolved_model = model.to_string();
        let mut tool_call_accumulators: Vec<StreamToolCallAccumulator> = Vec::new();
        let mut current_tool_index: Option<usize> = None;
        let mut token_usage = None;
        let mut last_emitted_usage = None;

        for line in reader.lines() {
            ensure_not_cancelled(cancel_flag)?;
            let line = line.map_err(|error| {
                OperatorError::Message(format!("invalid anthropic stream response: {error}"))
            })?;
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            // SSE event type lines
            if trimmed.starts_with("event:") {
                continue;
            }
            let data = match trimmed.strip_prefix("data:") {
                Some(d) => d.trim(),
                None => continue,
            };
            if data.is_empty() {
                continue;
            }

            let payload = serde_json::from_str::<Value>(data).map_err(|error| {
                OperatorError::Message(format!("invalid anthropic stream payload: {error}"))
            })?;

            let event_type = payload
                .get("type")
                .and_then(Value::as_str)
                .unwrap_or_default();

            match event_type {
                "message_start" => {
                    if let Some(msg) = payload.get("message") {
                        if let Some(m) = msg.get("model").and_then(Value::as_str) {
                            resolved_model = m.to_string();
                        }
                        if let Some(usage) = parse_anthropic_usage(msg) {
                            emit_usage_if_changed(&usage, &mut last_emitted_usage, &mut on_event);
                            token_usage = Some(usage);
                        }
                    }
                }
                "content_block_start" => {
                    if let Some(cb) = payload.get("content_block") {
                        let block_type = cb.get("type").and_then(Value::as_str).unwrap_or_default();
                        if block_type == "tool_use" {
                            let id = cb
                                .get("id")
                                .and_then(Value::as_str)
                                .unwrap_or("call")
                                .to_string();
                            let name = cb
                                .get("name")
                                .and_then(Value::as_str)
                                .unwrap_or_default()
                                .to_string();
                            tool_call_accumulators.push(StreamToolCallAccumulator {
                                id,
                                name,
                                arguments: String::new(),
                            });
                            current_tool_index = Some(tool_call_accumulators.len() - 1);
                        }
                    }
                }
                "content_block_delta" => {
                    if let Some(delta) = payload.get("delta") {
                        let delta_type = delta
                            .get("type")
                            .and_then(Value::as_str)
                            .unwrap_or_default();
                        match delta_type {
                            "text_delta" => {
                                if let Some(text) = delta.get("text").and_then(Value::as_str) {
                                    if !text.is_empty() {
                                        content.push_str(text);
                                        on_event(ChatStreamEvent::Text(text.to_string()));
                                    }
                                }
                            }
                            "input_json_delta" => {
                                if let Some(partial) =
                                    delta.get("partial_json").and_then(Value::as_str)
                                {
                                    if let Some(idx) = current_tool_index {
                                        if let Some(acc) = tool_call_accumulators.get_mut(idx) {
                                            acc.arguments.push_str(partial);
                                        }
                                    }
                                }
                            }
                            _ => {}
                        }
                    }
                }
                "content_block_stop" => {
                    current_tool_index = None;
                }
                "message_delta" => {
                    if let Some(usage_val) = payload.get("usage") {
                        let output_tokens = usage_val
                            .get("output_tokens")
                            .and_then(Value::as_u64)
                            .unwrap_or(0) as u32;
                        if let Some(ref mut u) = token_usage {
                            u.completion_tokens = output_tokens;
                            u.total_tokens = u.prompt_tokens + output_tokens;
                            emit_usage_if_changed(u, &mut last_emitted_usage, &mut on_event);
                        }
                    }
                }
                "message_stop" => break,
                "error" => {
                    let error_msg = payload
                        .get("error")
                        .and_then(|e| e.get("message"))
                        .and_then(Value::as_str)
                        .unwrap_or("unknown anthropic stream error");
                    return Err(OperatorError::Message(format!(
                        "anthropic stream error: {error_msg}"
                    )));
                }
                _ => {}
            }
        }

        let token_usage = token_usage.or_else(|| {
            Some(estimated_chat_usage(
                messages,
                opts,
                tools,
                content.as_str(),
            ))
        });
        if let Some(usage) = token_usage.as_ref() {
            emit_usage_if_changed(usage, &mut last_emitted_usage, &mut on_event);
        }

        Ok(ChatCompletion {
            content,
            model: resolved_model,
            provider: self.name.clone(),
            tool_calls: finalize_stream_tool_calls(tool_call_accumulators),
            token_usage,
        })
    }

    pub fn is_configured(&self) -> bool {
        match self.kind {
            ProviderKind::LocalFallback | ProviderKind::Ollama | ProviderKind::Anthropic => true,
            _ => self
                .api_key
                .as_deref()
                .map(|value| !value.trim().is_empty())
                .unwrap_or(false),
        }
    }

    pub fn name(&self) -> &str {
        &self.name
    }

    pub fn api_key_missing_hint(&self) -> &str {
        &self.api_key_missing_hint
    }

    fn check_availability(&self) -> Result<(), String> {
        match self.kind {
            ProviderKind::LocalFallback => Ok(()),
            ProviderKind::Ollama => {
                let base_url = self
                    .base_url
                    .clone()
                    .unwrap_or_else(|| "http://127.0.0.1:11434".to_string());
                get_json(
                    format!("{}/api/tags", base_url.trim_end_matches('/')).as_str(),
                    None,
                    3000,
                )
                .map(|_| ())
                .map_err(|error| error.to_string())
            }
            ProviderKind::SharedLlm | ProviderKind::DecentralizedLlm => {
                let base_url = self
                    .base_url
                    .as_deref()
                    .ok_or_else(|| "missing base url".to_string())?;
                let api_key = self
                    .api_key
                    .as_deref()
                    .ok_or_else(|| "missing api key".to_string())?;
                get_json(
                    format!("{}/health", base_url.trim_end_matches('/')).as_str(),
                    Some(api_key),
                    3000,
                )
                .map(|_| ())
                .map_err(|error| error.to_string())
            }
            ProviderKind::Minimax | ProviderKind::Deepseek | ProviderKind::Glm => {
                if self.is_configured() {
                    Ok(())
                } else {
                    Err("provider not configured".to_string())
                }
            }
            ProviderKind::Anthropic => {
                if self
                    .api_key
                    .as_deref()
                    .map(|v| !v.trim().is_empty())
                    .unwrap_or(false)
                {
                    Ok(())
                } else {
                    Err("ANTHROPIC_API_KEY not set".to_string())
                }
            }
        }
    }

    fn list_models(&self) -> Vec<String> {
        match self.kind {
            ProviderKind::LocalFallback => vec!["local-fallback-v0".to_string()],
            ProviderKind::SharedLlm => vec![self.default_model.clone()],
            ProviderKind::DecentralizedLlm => vec![self.default_model.clone()],
            ProviderKind::Ollama => self
                .fetch_ollama_models()
                .unwrap_or_else(|_| vec![self.default_model.clone()]),
            ProviderKind::Minimax => vec![
                "MiniMax-M2.7".to_string(),
                "abab5.5-chat".to_string(),
                "abab6-chat".to_string(),
                "abab6.5s-chat".to_string(),
            ],
            ProviderKind::Deepseek => vec![self.default_model.clone()],
            ProviderKind::Glm => vec![
                self.default_model.clone(),
                "glm-4".to_string(),
                "glm-4-plus".to_string(),
                "glm-3-turbo".to_string(),
            ],
            ProviderKind::Anthropic => vec![
                "claude-opus-4-6".to_string(),
                "claude-sonnet-4-6".to_string(),
                "claude-haiku-4-5".to_string(),
            ],
        }
    }

    fn fetch_ollama_models(&self) -> Result<Vec<String>, OperatorError> {
        let base_url = self
            .base_url
            .clone()
            .unwrap_or_else(|| "http://127.0.0.1:11434".to_string());
        let body = get_json(
            format!("{}/api/tags", base_url.trim_end_matches('/')).as_str(),
            None,
            3000,
        )?;
        Ok(body
            .get("models")
            .and_then(Value::as_array)
            .map(|models| {
                models
                    .iter()
                    .filter_map(|model| model.get("name").and_then(Value::as_str))
                    .map(ToString::to_string)
                    .collect::<Vec<_>>()
            })
            .unwrap_or_else(|| vec![self.default_model.clone()]))
    }

    fn model_capability(&self, model: &str) -> ModelCapabilitySummary {
        let normalized = model.to_ascii_lowercase();
        let (context_window_tokens, supports_vision) = match self.kind {
            ProviderKind::LocalFallback => (Some(2048), false),
            ProviderKind::Ollama => (
                Some(8192),
                normalized.contains("llava")
                    || normalized.contains("vision")
                    || normalized.contains("moondream"),
            ),
            ProviderKind::SharedLlm | ProviderKind::DecentralizedLlm => (
                Some(openai_compatible_context_window_tokens(&normalized)),
                openai_compatible_supports_vision(&normalized),
            ),
            ProviderKind::Minimax => (
                Some(minimax_context_window_tokens(&normalized)),
                openai_compatible_supports_vision(&normalized),
            ),
            ProviderKind::Deepseek => (Some(64000), false),
            ProviderKind::Glm => (
                Some(glm_context_window_tokens(&normalized)),
                openai_compatible_supports_vision(&normalized),
            ),
            ProviderKind::Anthropic => (
                Some(anthropic_context_window_tokens(&normalized)),
                normalized.contains("claude-3")
                    || normalized.contains("claude-opus")
                    || normalized.contains("claude-sonnet"),
            ),
        };

        ModelCapabilitySummary {
            model: model.to_string(),
            context_window_tokens,
            supports_streaming: true,
            supports_vision,
        }
    }
}

fn openai_compatible_context_window_tokens(model: &str) -> u32 {
    if model.contains("gpt-4.1")
        || model.contains("gpt-4o")
        || model.contains("o1")
        || model.contains("deepseek")
        || model.contains("glm-4")
    {
        128_000
    } else if model.contains("gpt-3.5") {
        16_385
    } else {
        8_192
    }
}

fn openai_compatible_supports_vision(model: &str) -> bool {
    model.contains("vision")
        || model.contains("gpt-4o")
        || model.contains("omni")
        || model.contains("claude-3")
        || model.contains("llava")
        || model.contains("glm-4v")
}

fn minimax_context_window_tokens(model: &str) -> u32 {
    // MiniMax M2 / M2.7 supports 200k+ context per platform.minimax.chat
    // documentation. The earlier hardcode of 32_000 was from an outdated
    // spec — live M2.7 deployments through MiniMax's OpenAI-compatible
    // endpoint accept the full window. Status bar showed `ctx:32k` while
    // operator's session held >99k tokens without overflowing, which is
    // how the discrepancy was caught (2026-05-08 TUI session).
    //
    // Kept aligned with the TS-side capability matrix entry in
    // src/providers/capability-matrix.ts:201 (204_800 = 200 × 1024).
    if model.contains("m2") {
        204_800
    } else {
        // Older `abab*` series caps around 16k.
        16_384
    }
}

fn anthropic_context_window_tokens(_model: &str) -> u32 {
    200_000
}

fn glm_context_window_tokens(model: &str) -> u32 {
    if model.contains("glm-4-flash") {
        32_000
    } else if model.contains("glm-4") {
        128_000
    } else {
        8_192
    }
}

fn anthropic_messages_json(messages: &[ChatMessage]) -> Vec<Value> {
    messages
        .iter()
        .filter_map(|msg| match msg {
            ChatMessage::System { .. } => None, // system goes as top-level field
            ChatMessage::User { content } => {
                Some(json!({ "role": "user", "content": sanitize_for_json(content) }))
            }
            ChatMessage::Assistant {
                content,
                tool_calls,
            } => {
                let mut blocks = Vec::new();
                if !content.is_empty() {
                    blocks.push(json!({ "type": "text", "text": content }));
                }
                for tc in tool_calls {
                    blocks.push(json!({
                        "type": "tool_use",
                        "id": tc.id,
                        "name": tc.name,
                        "input": tc.arguments,
                    }));
                }
                if blocks.is_empty() {
                    blocks.push(json!({ "type": "text", "text": "" }));
                }
                Some(json!({ "role": "assistant", "content": blocks }))
            }
            ChatMessage::Tool {
                tool_call_id,
                content,
            } => Some(json!({
                "role": "user",
                "content": [{ "type": "tool_result", "tool_use_id": tool_call_id, "content": sanitize_for_json(content) }],
            })),
        })
        .collect()
}

fn anthropic_tools_json(tools: &[ChatToolDefinition]) -> Vec<Value> {
    tools
        .iter()
        .map(|tool| {
            json!({
                "name": tool.name,
                "description": tool.description,
                "input_schema": tool.input_schema,
            })
        })
        .collect()
}

fn parse_anthropic_content(body: &Value) -> (String, Vec<ChatToolCall>) {
    let mut text = String::new();
    let mut tool_calls = Vec::new();
    if let Some(content) = body.get("content").and_then(Value::as_array) {
        for block in content {
            let block_type = block
                .get("type")
                .and_then(Value::as_str)
                .unwrap_or_default();
            match block_type {
                "text" => {
                    if let Some(t) = block.get("text").and_then(Value::as_str) {
                        if !text.is_empty() {
                            text.push('\n');
                        }
                        text.push_str(t);
                    }
                }
                "tool_use" => {
                    let id = block
                        .get("id")
                        .and_then(Value::as_str)
                        .unwrap_or("call")
                        .to_string();
                    let name = block
                        .get("name")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string();
                    let arguments = block.get("input").cloned().unwrap_or(json!({}));
                    tool_calls.push(ChatToolCall {
                        id,
                        name,
                        arguments,
                    });
                }
                _ => {}
            }
        }
    }
    (text, tool_calls)
}

fn parse_anthropic_usage(body: &Value) -> Option<TokenUsageSummary> {
    let usage = body.get("usage")?;
    let prompt_tokens = usage.get("input_tokens").and_then(Value::as_u64)? as u32;
    let completion_tokens = usage
        .get("output_tokens")
        .and_then(Value::as_u64)
        .unwrap_or(0) as u32;
    Some(TokenUsageSummary {
        prompt_tokens,
        completion_tokens,
        total_tokens: prompt_tokens + completion_tokens,
        estimated: false,
    })
}

fn resolve_vault_or_env_api_key(
    config: &OperatorConfig,
    vault_ref_env: &str,
    plaintext_env: &str,
) -> Result<Option<String>, OperatorError> {
    if let Some(vault_key) = config.env(vault_ref_env) {
        if let Some(plaintext) = try_read_vault_secret_plaintext(config, vault_key)? {
            return Ok(Some(plaintext));
        }
    }

    Ok(config.env(plaintext_env).map(ToString::to_string))
}

/// Operator-actionable hint emitted when `resolve_vault_or_env_api_key`
/// returns None. The 2026-04-26 TUI session ("provider minimax missing api
/// key") collapsed three failure modes into one opaque string; this helper
/// distinguishes them so the operator's next move is obvious.
fn diagnose_missing_api_key(
    config: &OperatorConfig,
    vault_ref_env: &str,
    plaintext_env: &str,
) -> String {
    let vault_ref = config.env(vault_ref_env);
    let plaintext = config.env(plaintext_env);
    match (vault_ref, plaintext) {
        (None, None) => format!(
            "neither {vault_ref_env} nor {plaintext_env} is set in env; \
             configure with `memphis vault add --key <provider>_api_key` \
             (which auto-sets {vault_ref_env}) or set {plaintext_env} in .env, \
             then restart memphis"
        ),
        (Some(vault_key), _) => format!(
            "{vault_ref_env}={vault_key} but the vault entry could not be read \
             (entry missing or vault locked); run `memphis vault list` to \
             verify the entry exists, or `memphis vault recovery-unlock` if \
             the vault is locked"
        ),
        (None, Some(_)) => format!(
            "{plaintext_env} is set but resolved to empty after trim; \
             check .env for whitespace/quoting around the value"
        ),
    }
}

/// Convenience wrapper: resolve the api_key and precompute the diagnostic
/// hint in one call. The hint is empty when the key resolved successfully.
fn resolve_api_key_with_diagnostic(
    config: &OperatorConfig,
    vault_ref_env: &str,
    plaintext_env: &str,
) -> Result<(Option<String>, String), OperatorError> {
    let api_key = resolve_vault_or_env_api_key(config, vault_ref_env, plaintext_env)?;
    let hint = if api_key.is_none() {
        diagnose_missing_api_key(config, vault_ref_env, plaintext_env)
    } else {
        String::new()
    };
    Ok((api_key, hint))
}

fn resolve_anthropic_api_key(config: &OperatorConfig) -> Result<Option<String>, OperatorError> {
    if let Some(vault_key) = config.env("ANTHROPIC_VAULT_KEY") {
        if vault_key == "anthropic_oauth_refresh_token" {
            return Err(OperatorError::Message(
                "native rust operator does not support ANTHROPIC_VAULT_KEY=anthropic_oauth_refresh_token; use ANTHROPIC_API_KEY or ANTHROPIC_VAULT_KEY=anthropic_api_key".to_string(),
            ));
        }
    }

    resolve_vault_or_env_api_key(config, "ANTHROPIC_VAULT_KEY", "ANTHROPIC_API_KEY")
}

pub fn resolve_provider(
    config: &OperatorConfig,
    requested: Option<&str>,
) -> Result<ProviderRuntime, OperatorError> {
    let name = requested
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(config.default_provider.as_str());
    let timeout_ms = config
        .env("GEN_TIMEOUT_MS")
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(30_000);
    match name {
        "local-fallback" => Ok(ProviderRuntime {
            kind: ProviderKind::LocalFallback,
            name: "local-fallback".to_string(),
            base_url: None,
            api_key: None,
            api_key_missing_hint: String::new(),
            default_model: "local-fallback-v0".to_string(),
            timeout_ms,
        }),
        "shared-llm" => {
            let api_key = config.env("SHARED_LLM_API_KEY").map(ToString::to_string);
            let api_key_missing_hint = if api_key.is_none() {
                "SHARED_LLM_API_KEY is not set in env; set it in .env and restart memphis"
                    .to_string()
            } else {
                String::new()
            };
            Ok(ProviderRuntime {
                kind: ProviderKind::SharedLlm,
                name: "shared-llm".to_string(),
                base_url: config.env("SHARED_LLM_API_BASE").map(ToString::to_string),
                api_key,
                api_key_missing_hint,
                default_model: config
                    .env("SHARED_LLM_MODEL")
                    .or_else(|| config.env("OPENAI_COMPATIBLE_MODEL"))
                    .unwrap_or("shared-llm")
                    .to_string(),
                timeout_ms,
            })
        }
        "decentralized-llm" => {
            let api_key = config
                .env("DECENTRALIZED_LLM_API_KEY")
                .map(ToString::to_string);
            let api_key_missing_hint = if api_key.is_none() {
                "DECENTRALIZED_LLM_API_KEY is not set in env; set it in .env and restart memphis"
                    .to_string()
            } else {
                String::new()
            };
            Ok(ProviderRuntime {
                kind: ProviderKind::DecentralizedLlm,
                name: "decentralized-llm".to_string(),
                base_url: config
                    .env("DECENTRALIZED_LLM_API_BASE")
                    .map(ToString::to_string),
                api_key,
                api_key_missing_hint,
                default_model: config
                    .env("DECENTRALIZED_LLM_MODEL")
                    .unwrap_or("decentralized-llm")
                    .to_string(),
                timeout_ms,
            })
        }
        "ollama" => Ok(ProviderRuntime {
            kind: ProviderKind::Ollama,
            name: "ollama".to_string(),
            base_url: config
                .env("OLLAMA_URL")
                .map(ToString::to_string)
                .or_else(|| Some("http://127.0.0.1:11434".to_string())),
            api_key: None,
            api_key_missing_hint: String::new(),
            default_model: config
                .env("OLLAMA_MODEL")
                .unwrap_or("qwen2.5-coder:3b")
                .to_string(),
            timeout_ms,
        }),
        "minimax" => {
            let (api_key, api_key_missing_hint) =
                resolve_api_key_with_diagnostic(config, "MINIMAX_VAULT_KEY", "MINIMAX_API_KEY")?;
            Ok(ProviderRuntime {
                kind: ProviderKind::Minimax,
                name: "minimax".to_string(),
                base_url: config
                    .env("MINIMAX_BASE_URL")
                    .map(ToString::to_string)
                    .or_else(|| Some("https://api.minimax.io/v1".to_string())),
                api_key,
                api_key_missing_hint,
                default_model: config
                    .env("MINIMAX_MODEL")
                    .unwrap_or("MiniMax-M2.7")
                    .to_string(),
                timeout_ms,
            })
        }
        "deepseek" => {
            let (api_key, api_key_missing_hint) =
                resolve_api_key_with_diagnostic(config, "DEEPSEEK_VAULT_KEY", "DEEPSEEK_API_KEY")?;
            Ok(ProviderRuntime {
                kind: ProviderKind::Deepseek,
                name: "deepseek".to_string(),
                base_url: config
                    .env("DEEPSEEK_API_BASE")
                    .map(ToString::to_string)
                    .or_else(|| Some("https://api.deepseek.com".to_string())),
                api_key,
                api_key_missing_hint,
                default_model: config
                    .env("DEEPSEEK_MODEL")
                    .unwrap_or("deepseek-chat")
                    .to_string(),
                timeout_ms,
            })
        }
        "glm" => {
            let (api_key, api_key_missing_hint) =
                resolve_api_key_with_diagnostic(config, "GLM_VAULT_KEY", "GLM_API_KEY")?;
            Ok(ProviderRuntime {
                kind: ProviderKind::Glm,
                name: "glm".to_string(),
                base_url: config
                    .env("GLM_BASE_URL")
                    .map(ToString::to_string)
                    .or_else(|| Some("https://open.bigmodel.cn/api/paas/v4".to_string())),
                api_key,
                api_key_missing_hint,
                default_model: config.env("GLM_MODEL").unwrap_or("glm-4-flash").to_string(),
                timeout_ms,
            })
        }
        "anthropic" => {
            let api_key = resolve_anthropic_api_key(config)?;
            let api_key_missing_hint = if api_key.is_none() {
                diagnose_missing_api_key(config, "ANTHROPIC_VAULT_KEY", "ANTHROPIC_API_KEY")
            } else {
                String::new()
            };
            Ok(ProviderRuntime {
                kind: ProviderKind::Anthropic,
                name: "anthropic".to_string(),
                base_url: config
                    .env("ANTHROPIC_BASE_URL")
                    .map(ToString::to_string)
                    .or_else(|| Some("https://api.anthropic.com".to_string())),
                api_key,
                api_key_missing_hint,
                default_model: config
                    .env("ANTHROPIC_MODEL")
                    .unwrap_or("claude-sonnet-4-6")
                    .to_string(),
                timeout_ms,
            })
        }
        other => Err(OperatorError::Message(format!(
            "unsupported provider in rust operator runtime: {other}"
        ))),
    }
}

pub fn configured_provider_statuses(config: &OperatorConfig) -> Vec<ProviderStatus> {
    [
        "local-fallback",
        "shared-llm",
        "decentralized-llm",
        "ollama",
        "minimax",
        "deepseek",
        "glm",
        "anthropic",
    ]
    .into_iter()
    .filter_map(|name| resolve_provider(config, Some(name)).ok())
    .map(|provider| provider.status())
    .collect()
}

fn build_tools_json(tools: &[ChatToolDefinition]) -> Vec<Value> {
    tools
        .iter()
        .map(|tool| {
            json!({
                "type": "function",
                "function": {
                    "name": tool.name,
                    "description": tool.description,
                    "parameters": tool.input_schema,
                }
            })
        })
        .collect()
}

fn message_to_provider_json(message: &ChatMessage) -> Value {
    build_message_json(message, ProviderMessageStyle::OpenAiCompatible)
}

/// Ollama's /api/chat accepts a superset of the OpenAI shape, but with one
/// critical difference: tool-call `arguments` must be a JSON **object**, not
/// a stringified JSON. Sending the OpenAI-style string produces:
///
///   400 {"error":"Value looks like object, but can't find closing '}' symbol"}
///
/// because Ollama's Go parser then tries to parse the string as an object
/// and fails on quote-escape boundaries. Observed on operator WSL 2026-04-21
/// after the previous session left assistant tool_call rows in history.
fn ollama_message_to_json(message: &ChatMessage) -> Value {
    build_message_json(message, ProviderMessageStyle::Ollama)
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum ProviderMessageStyle {
    OpenAiCompatible,
    Ollama,
}

fn build_message_json(message: &ChatMessage, style: ProviderMessageStyle) -> Value {
    match message {
        ChatMessage::System { content } => {
            json!({ "role": "system", "content": sanitize_for_json(content) })
        }
        ChatMessage::User { content } => {
            json!({ "role": "user", "content": sanitize_for_json(content) })
        }
        ChatMessage::Assistant {
            content,
            tool_calls,
        } => {
            if tool_calls.is_empty() {
                json!({ "role": "assistant", "content": sanitize_for_json(content) })
            } else {
                json!({
                    "role": "assistant",
                    "content": if content.is_empty() { Value::Null } else { Value::String(content.clone()) },
                    "tool_calls": tool_calls
                        .iter()
                        .map(|call| {
                            let arguments: Value = match style {
                                ProviderMessageStyle::OpenAiCompatible => Value::String(
                                    serde_json::to_string(&call.arguments)
                                        .unwrap_or_else(|_| "{}".to_string()),
                                ),
                                ProviderMessageStyle::Ollama => call.arguments.clone(),
                            };
                            json!({
                                "id": call.id,
                                "type": "function",
                                "function": {
                                    "name": call.name,
                                    "arguments": arguments,
                                }
                            })
                        })
                        .collect::<Vec<_>>(),
                })
            }
        }
        ChatMessage::Tool {
            tool_call_id,
            content,
        } => json!({
            "role": "tool",
            "tool_call_id": tool_call_id,
            "content": sanitize_for_json(content),
        }),
    }
}

fn serialize_message(message: &ChatMessage) -> String {
    match message {
        ChatMessage::System { content } => format!("SYSTEM: {content}"),
        ChatMessage::User { content } => format!("USER: {content}"),
        ChatMessage::Assistant {
            content,
            tool_calls,
        } => {
            if tool_calls.is_empty() {
                format!("ASSISTANT: {content}")
            } else {
                format!(
                    "ASSISTANT: {content}\nTOOL_CALLS: {}",
                    serde_json::to_string(tool_calls).unwrap_or_else(|_| "[]".to_string())
                )
            }
        }
        ChatMessage::Tool {
            tool_call_id,
            content,
        } => format!("TOOL({tool_call_id}): {content}"),
    }
}

fn build_generate_input_from_chat(
    messages: &[ChatMessage],
    opts: &ChatRequestOptions,
    tools: &[ChatToolDefinition],
) -> String {
    let mut parts = Vec::new();
    if let Some(system_prompt) = opts.system_prompt.as_deref() {
        parts.push(format!("SYSTEM: {system_prompt}"));
    }
    if !tools.is_empty() {
        parts.push(format!(
            "TOOLS: {}",
            tools
                .iter()
                .map(|tool| tool.name.as_str())
                .collect::<Vec<_>>()
                .join(", ")
        ));
    }
    parts.extend(messages.iter().map(serialize_message));
    parts.join("\n\n")
}

fn estimate_tokens(text: &str) -> u32 {
    let chars = text.chars().count();
    chars.div_ceil(4) as u32
}

fn estimated_text_usage(input: &str, output: &str) -> TokenUsageSummary {
    let prompt_tokens = estimate_tokens(input);
    let completion_tokens = estimate_tokens(output);
    TokenUsageSummary {
        prompt_tokens,
        completion_tokens,
        total_tokens: prompt_tokens + completion_tokens,
        estimated: true,
    }
}

fn estimated_chat_usage(
    messages: &[ChatMessage],
    opts: &ChatRequestOptions,
    tools: &[ChatToolDefinition],
    output: &str,
) -> TokenUsageSummary {
    estimated_text_usage(
        build_generate_input_from_chat(messages, opts, tools).as_str(),
        output,
    )
}

fn parse_tool_calls(value: &Value) -> Vec<ChatToolCall> {
    value
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|call| {
            let id = call
                .get("id")
                .and_then(Value::as_str)
                .unwrap_or("call")
                .to_string();
            let function = call.get("function")?;
            let name = function.get("name")?.as_str()?.to_string();
            let arguments = match function.get("arguments") {
                Some(Value::String(raw)) => {
                    serde_json::from_str::<Value>(raw).unwrap_or_else(|_| json!({}))
                }
                Some(value) => value.clone(),
                None => json!({}),
            };
            Some(ChatToolCall {
                id,
                name,
                arguments,
            })
        })
        .collect()
}

#[derive(Default)]
struct StreamToolCallAccumulator {
    id: String,
    name: String,
    arguments: String,
}

fn apply_stream_tool_call_deltas(value: &Value, accumulators: &mut Vec<StreamToolCallAccumulator>) {
    let Some(items) = value.as_array() else {
        return;
    };

    for item in items {
        let index = item
            .get("index")
            .and_then(Value::as_u64)
            .map(|value| value as usize)
            .unwrap_or(accumulators.len());
        if accumulators.len() <= index {
            accumulators.resize_with(index + 1, StreamToolCallAccumulator::default);
        }
        let accumulator = &mut accumulators[index];
        if let Some(id) = item.get("id").and_then(Value::as_str) {
            if accumulator.id.is_empty() {
                accumulator.id = id.to_string();
            }
        }
        if let Some(function) = item.get("function") {
            if let Some(name) = function.get("name").and_then(Value::as_str) {
                accumulator.name.push_str(name);
            }
            if let Some(arguments) = function.get("arguments").and_then(Value::as_str) {
                accumulator.arguments.push_str(arguments);
            }
        }
    }
}

fn finalize_stream_tool_calls(accumulators: Vec<StreamToolCallAccumulator>) -> Vec<ChatToolCall> {
    accumulators
        .into_iter()
        .filter(|item| !item.name.trim().is_empty())
        .map(|item| ChatToolCall {
            id: if item.id.trim().is_empty() {
                "call".to_string()
            } else {
                item.id
            },
            name: item.name,
            arguments: serde_json::from_str(&item.arguments).unwrap_or_else(|_| json!({})),
        })
        .collect()
}

fn emit_usage_if_changed<F>(
    usage: &TokenUsageSummary,
    last_emitted_usage: &mut Option<TokenUsageSummary>,
    on_event: &mut F,
) where
    F: FnMut(ChatStreamEvent),
{
    if last_emitted_usage.as_ref() == Some(usage) {
        return;
    }
    *last_emitted_usage = Some(usage.clone());
    on_event(ChatStreamEvent::Usage(usage.clone()));
}

fn emit_text_chunks<F>(
    value: &str,
    cancel_flag: Option<&AtomicBool>,
    per_chunk_delay: Option<Duration>,
    on_event: &mut F,
) -> Result<(), OperatorError>
where
    F: FnMut(ChatStreamEvent),
{
    let mut start = 0usize;
    for (idx, ch) in value.char_indices() {
        if ch.is_whitespace() {
            let end = idx + ch.len_utf8();
            ensure_not_cancelled(cancel_flag)?;
            on_event(ChatStreamEvent::Text(value[start..end].to_string()));
            if let Some(delay) = per_chunk_delay {
                thread::sleep(delay);
            }
            start = end;
        }
    }

    if start < value.len() {
        ensure_not_cancelled(cancel_flag)?;
        on_event(ChatStreamEvent::Text(value[start..].to_string()));
        if let Some(delay) = per_chunk_delay {
            thread::sleep(delay);
        }
    }

    Ok(())
}

fn parse_generate_provider_response(
    body: Value,
    model: &str,
    provider_name: &str,
) -> ChatCompletion {
    let output = body
        .get("output")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let resolved_model = body
        .get("model")
        .and_then(Value::as_str)
        .unwrap_or(model)
        .to_string();
    ChatCompletion {
        content: output,
        model: resolved_model,
        provider: provider_name.to_string(),
        tool_calls: Vec::new(),
        token_usage: parse_generate_provider_usage(&body),
    }
}

fn parse_generate_provider_usage(body: &Value) -> Option<TokenUsageSummary> {
    let usage = body.get("usage")?;
    let prompt_tokens = usage
        .get("inputTokens")
        .or_else(|| usage.get("promptTokens"))
        .and_then(Value::as_u64)? as u32;
    let completion_tokens = usage
        .get("outputTokens")
        .or_else(|| usage.get("completionTokens"))
        .and_then(Value::as_u64)? as u32;
    Some(TokenUsageSummary {
        prompt_tokens,
        completion_tokens,
        total_tokens: prompt_tokens + completion_tokens,
        estimated: false,
    })
}

fn parse_openai_usage(body: &Value) -> Option<TokenUsageSummary> {
    let usage = body.get("usage")?;
    let prompt_tokens = usage.get("prompt_tokens").and_then(Value::as_u64)? as u32;
    let completion_tokens = usage.get("completion_tokens").and_then(Value::as_u64)? as u32;
    let total_tokens = usage
        .get("total_tokens")
        .and_then(Value::as_u64)
        .map(|value| value as u32)
        .unwrap_or(prompt_tokens + completion_tokens);
    Some(TokenUsageSummary {
        prompt_tokens,
        completion_tokens,
        total_tokens,
        estimated: false,
    })
}

fn parse_ollama_usage(body: &Value) -> Option<TokenUsageSummary> {
    let prompt_tokens = body.get("prompt_eval_count").and_then(Value::as_u64)? as u32;
    let completion_tokens = body.get("eval_count").and_then(Value::as_u64)? as u32;
    Some(TokenUsageSummary {
        prompt_tokens,
        completion_tokens,
        total_tokens: prompt_tokens + completion_tokens,
        estimated: false,
    })
}

// Blocking JSON requests in ureq do not expose a cooperative abort handle. This wrapper lets
// the operator path return `Cancelled` promptly while the underlying request completes in a
// detached worker thread.
fn run_blocking_with_cancel<T, F>(cancel_flag: &AtomicBool, work: F) -> Result<T, OperatorError>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, OperatorError> + Send + 'static,
{
    ensure_not_cancelled(Some(cancel_flag))?;
    let (sender, receiver) = mpsc::channel();
    thread::spawn(move || {
        let _ = sender.send(work());
    });

    loop {
        ensure_not_cancelled(Some(cancel_flag))?;
        match receiver.recv_timeout(Duration::from_millis(20)) {
            Ok(result) => return result,
            Err(mpsc::RecvTimeoutError::Timeout) => continue,
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                return Err(OperatorError::Message(
                    "provider request worker disconnected".to_string(),
                ));
            }
        }
    }
}

fn ensure_not_cancelled(cancel_flag: Option<&AtomicBool>) -> Result<(), OperatorError> {
    if cancel_flag
        .map(|flag| flag.load(Ordering::Relaxed))
        .unwrap_or(false)
    {
        Err(OperatorError::Cancelled)
    } else {
        Ok(())
    }
}

fn post_response(
    url: &str,
    payload: Value,
    bearer_token: Option<&str>,
    timeout_ms: u64,
    extra_headers: &[(&str, &str)],
) -> Result<ureq::Response, OperatorError> {
    post_response_with_provider(url, payload, bearer_token, timeout_ms, extra_headers, None)
}

/// Same as `post_response` but threads an optional `provider_name` through
/// so context-too-long errors can be surfaced as
/// `OperatorError::ContextOverflow` with the provider attribution. When the
/// hint is omitted, falls back to generic `Message` mapping.
fn post_response_with_provider(
    url: &str,
    payload: Value,
    bearer_token: Option<&str>,
    timeout_ms: u64,
    extra_headers: &[(&str, &str)],
    provider_name: Option<&str>,
) -> Result<ureq::Response, OperatorError> {
    let mut request = ureq::post(url)
        .timeout(Duration::from_millis(timeout_ms))
        .set("Content-Type", "application/json");
    if let Some(token) = bearer_token {
        request = request.set("Authorization", &format!("Bearer {token}"));
    }
    for (key, value) in extra_headers {
        request = request.set(key, value);
    }
    request.send_json(payload).map_err(|error| match error {
        // Without this branch the caller only sees "status code 400" — ureq
        // drops the response body that contains the provider's actual
        // reason (e.g. Anthropic `{"type":"error","error":{...}}`).
        // Surfacing that body turns an opaque 400 into an actionable one.
        ureq::Error::Status(code, response) => {
            let body = response.into_string().unwrap_or_default();
            // Phase E1 (v1.7.1): detect context-too-long shapes upstream
            // providers return on 400/413 so the TUI can render a
            // `/clear`-actionable hint instead of the generic
            // "provider X failed: status code 400" string.
            if (code == 400 || code == 413) && is_context_overflow_body(body.as_str()) {
                let (tokens_used, context_window) = parse_context_overflow_numbers(body.as_str());
                // Only emit ContextOverflow when we have either an explicit
                // provider-specific code (already accepted by the heuristic)
                // *and* at least one token-adjacent number, OR we still
                // matched a high-confidence marker. When the heuristic
                // matches but the parser finds nothing token-adjacent, the
                // body almost certainly belongs to a non-overflow 400 with
                // overlapping vocabulary (rate-limit, auth, session TTL),
                // so we fall through to the generic error path so the
                // operator sees the real reason from `extract_provider_error_hint`.
                if tokens_used.is_some()
                    || context_window.is_some()
                    || has_explicit_overflow_marker(body.as_str())
                {
                    let provider = provider_name.unwrap_or("unknown").to_string();
                    return OperatorError::ContextOverflow {
                        provider,
                        tokens_used,
                        context_window,
                    };
                }
            }
            let hint = extract_provider_error_hint(body.as_str());
            OperatorError::Message(format!(
                "provider request failed: {url}: status code {code}: {hint}"
            ))
        }
        other => OperatorError::Message(format!("provider request failed: {url}: {other}")),
    })
}

/// Heuristic detection of "context window exceeded" upstream errors.
/// Covers OpenAI-compatible (`context_length_exceeded`, `maximum context
/// length`), Anthropic (`prompt is too long`, `messages: tokens too high`),
/// and Minimax (similar shape to OpenAI).
fn is_context_overflow_body(body: &str) -> bool {
    if has_explicit_overflow_marker(body) {
        return true;
    }
    // Soft fallback for shapes we haven't catalogued. Requires the *triple*
    // of (token mention, context/prompt mention, overflow verb) — the prior
    // `(token AND exceed)` was too permissive: rate-limit responses
    // ("token quota exceeded — retry after 60s") and session-TTL responses
    // ("session token expired, exceeded TTL") tripped it falsely.
    let lower = body.to_ascii_lowercase();
    let has_tokens = lower.contains("tokens") || lower.contains("token count");
    let has_subject = lower.contains("context") || lower.contains("prompt");
    let has_overflow = lower.contains("exceed")
        || lower.contains("too long")
        || lower.contains("too high")
        || lower.contains("too large");
    has_tokens && has_subject && has_overflow
}

/// Returns true only when the body contains a provider-specific phrase
/// that we know means "context window exceeded" with no ambiguity.
fn has_explicit_overflow_marker(body: &str) -> bool {
    let lower = body.to_ascii_lowercase();
    lower.contains("context_length_exceeded")
        || lower.contains("maximum context length")
        || lower.contains("prompt is too long")
        || lower.contains("tokens too high")
        || lower.contains("context window exceeded")
        // Live MiniMax M2.7 variant observed 2026-05-08:
        //   "bad_request_error: invalid params, context window exceeds limit (2013)"
        // Note "exceeds" (no -ed) and the parenthesised remaining-budget
        // figure. The earlier markers all expected past tense.
        || lower.contains("context window exceeds")
        || (lower.contains("invalid params") && lower.contains("exceeds limit"))
}

/// Best-effort number extraction from a context-overflow body. OpenAI and
/// Minimax tend to format like "Maximum context length is 32768 tokens,
/// however your messages resulted in 38538 tokens." Returns (used, window)
/// when both numbers are present in plausible order.
///
/// Only counts numbers that appear within ±48 characters of the word `token`
/// — without that adjacency check unrelated digit runs (HTTP error codes,
/// session ids, request ids) leak through the >=1024 filter and produce
/// nonsense like `Some(2013) / None tokens` when the upstream body has no
/// real token counts at all.
fn parse_context_overflow_numbers(body: &str) -> (Option<u32>, Option<u32>) {
    let lower = body.to_ascii_lowercase();
    let bytes = body.as_bytes();
    let mut nums: Vec<u32> = Vec::new();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i].is_ascii_digit() {
            let start = i;
            while i < bytes.len() && bytes[i].is_ascii_digit() {
                i += 1;
            }
            if let Ok(n) = body[start..i].parse::<u32>() {
                if n >= 1024 {
                    let win_start = start.saturating_sub(48);
                    let win_end = (i + 48).min(lower.len());
                    if lower[win_start..win_end].contains("token") {
                        nums.push(n);
                    }
                }
            }
        } else {
            i += 1;
        }
    }
    if nums.len() < 2 {
        return (nums.first().copied(), None);
    }
    // Heuristic: window first, used second (OpenAI's wording). Swap if
    // they're in the opposite order.
    let (a, b) = (nums[0], nums[1]);
    if a < b {
        (Some(b), Some(a))
    } else {
        (Some(a), Some(b))
    }
}

/// Best-effort extraction of a human-readable reason from a provider error
/// body. Supports the Anthropic shape (`{"type":"error","error":{"type","message"}}`)
/// and the OpenAI-compatible shape (`{"error":{"message"}}`). Falls back to
/// the first 200 characters of the raw body when the JSON is unexpected —
/// an imperfect hint still beats a bare status code.
fn extract_provider_error_hint(body: &str) -> String {
    let trimmed = body.trim();
    if trimmed.is_empty() {
        return "<empty body>".to_string();
    }
    if let Ok(parsed) = serde_json::from_str::<Value>(trimmed) {
        if let Some(err) = parsed.get("error") {
            let message = err
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let kind = err.get("type").and_then(Value::as_str).unwrap_or_default();
            if !message.is_empty() || !kind.is_empty() {
                return match (kind, message) {
                    ("", m) => m.to_string(),
                    (k, "") => k.to_string(),
                    (k, m) => format!("{k}: {m}"),
                };
            }
        }
        if let Some(msg) = parsed.get("message").and_then(Value::as_str) {
            return msg.to_string();
        }
    }
    let snippet: String = trimmed.chars().take(200).collect();
    if snippet.len() < trimmed.len() {
        format!("{snippet}…")
    } else {
        snippet
    }
}

fn post_json(
    url: &str,
    payload: Value,
    bearer_token: Option<&str>,
    timeout_ms: u64,
    extra_headers: &[(&str, &str)],
) -> Result<Value, OperatorError> {
    post_response(url, payload, bearer_token, timeout_ms, extra_headers)?
        .into_json::<Value>()
        .map_err(|error| OperatorError::Message(format!("invalid provider response: {error}")))
}

fn get_json(
    url: &str,
    bearer_token: Option<&str>,
    timeout_ms: u64,
) -> Result<Value, OperatorError> {
    let mut request = ureq::get(url).timeout(Duration::from_millis(timeout_ms));
    if let Some(token) = bearer_token {
        request = request.set("Authorization", &format!("Bearer {token}"));
    }
    let response = request.call().map_err(|error| {
        OperatorError::Message(format!("provider health request failed: {error}"))
    })?;
    response
        .into_json::<Value>()
        .map_err(|error| OperatorError::Message(format!("invalid provider response: {error}")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        fs,
        io::{Read, Write},
        net::TcpListener,
        path::{Path, PathBuf},
        sync::{
            atomic::{AtomicBool, Ordering},
            Arc, Mutex, OnceLock,
        },
        time::{Duration, Instant, SystemTime, UNIX_EPOCH},
    };

    use base64::{engine::general_purpose::STANDARD, Engine as _};
    use memphis_vault::Vault;
    use sha2::{Digest, Sha256};

    fn config_from(vars: &[(&str, &str)]) -> OperatorConfig {
        OperatorConfig::from_iter(
            [
                ("HOME", "/tmp"),
                ("MEMPHIS_DATA_DIR", "/tmp/memphis-operator-provider-test"),
            ]
            .into_iter()
            .chain(vars.iter().copied()),
        )
    }

    struct TestProviderDir {
        path: PathBuf,
    }

    impl TestProviderDir {
        fn new(label: &str) -> Self {
            let unique = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("system time before unix epoch")
                .as_nanos();
            let path =
                std::env::temp_dir().join(format!("memphis-operator-provider-{label}-{unique}"));
            fs::create_dir_all(&path).expect("create provider temp dir");
            Self { path }
        }

        fn path(&self) -> &Path {
            &self.path
        }

        fn vault_state_path(&self) -> PathBuf {
            self.path.join("vault-state.json")
        }

        fn vault_entries_path(&self) -> PathBuf {
            self.path.join("vault-entries.json")
        }

        fn config(&self, vars: &[(&str, &str)]) -> OperatorConfig {
            let mut all_vars = vec![
                ("HOME".to_string(), "/tmp".to_string()),
                (
                    "MEMPHIS_DATA_DIR".to_string(),
                    self.path().to_string_lossy().into_owned(),
                ),
                (
                    "MEMPHIS_VAULT_STATE_PATH".to_string(),
                    self.vault_state_path().to_string_lossy().into_owned(),
                ),
                (
                    "MEMPHIS_VAULT_ENTRIES_PATH".to_string(),
                    self.vault_entries_path().to_string_lossy().into_owned(),
                ),
            ];
            all_vars.extend(
                vars.iter()
                    .map(|(key, value)| ((*key).to_string(), (*value).to_string())),
            );
            OperatorConfig::from_iter(all_vars)
        }
    }

    impl Drop for TestProviderDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.path);
        }
    }

    struct EnvVarGuard {
        key: &'static str,
        previous: Option<String>,
    }

    impl EnvVarGuard {
        fn set(key: &'static str, value: &str) -> Self {
            let previous = std::env::var(key).ok();
            std::env::set_var(key, value);
            Self { key, previous }
        }

        fn unset(key: &'static str) -> Self {
            let previous = std::env::var(key).ok();
            std::env::remove_var(key);
            Self { key, previous }
        }
    }

    impl Drop for EnvVarGuard {
        fn drop(&mut self) {
            match &self.previous {
                Some(value) => std::env::set_var(self.key, value),
                None => std::env::remove_var(self.key),
            }
        }
    }

    fn vault_env_lock() -> &'static Mutex<()> {
        static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        LOCK.get_or_init(|| Mutex::new(()))
    }

    fn fingerprint_for_entry(key: &str, encrypted: &str, iv: &str) -> String {
        // Must match TypeScript JSON.stringify({key, encrypted, iv}) insertion order
        let payload = format!(
            r#"{{"key":"{}","encrypted":"{}","iv":"{}"}}"#,
            key, encrypted, iv
        );
        let digest = Sha256::digest(payload.as_bytes());
        format!("{digest:x}")
    }

    fn write_vault_files(dir: &TestProviderDir, state: Value, entries: Vec<Value>) {
        fs::write(
            dir.vault_state_path(),
            serde_json::to_vec(&state).expect("serialize vault state"),
        )
        .expect("write vault state");
        fs::write(
            dir.vault_entries_path(),
            serde_json::to_vec(&entries).expect("serialize vault entries"),
        )
        .expect("write vault entries");
    }

    fn write_v1_vault_secret(dir: &TestProviderDir, key: &str, value: &str) {
        let salt = [17_u8; 32];
        let master_key = [29_u8; 32];
        let vault = Vault::from_parts(salt, master_key);
        let entry = vault.store(key, value.as_bytes()).expect("store v1 secret");
        let encrypted = STANDARD.encode(entry.ciphertext.as_slice());
        let iv = STANDARD.encode(entry.nonce.as_slice());
        let tag = STANDARD.encode(entry.tag.as_slice());
        write_vault_files(
            dir,
            json!({
                "salt": STANDARD.encode(salt),
                "masterKey": STANDARD.encode(master_key),
            }),
            vec![json!({
                "key": key,
                "encrypted": encrypted,
                "iv": iv,
                "tag": tag,
                "id": entry.id,
                "createdAt": entry.created_at.to_rfc3339(),
                "fingerprint": fingerprint_for_entry(key, encrypted.as_str(), iv.as_str()),
            })],
        );
    }

    fn write_v1_vault_secret_with_invalid_fingerprint(
        dir: &TestProviderDir,
        key: &str,
        value: &str,
    ) {
        let salt = [73_u8; 32];
        let master_key = [89_u8; 32];
        let vault = Vault::from_parts(salt, master_key);
        let entry = vault
            .store(key, value.as_bytes())
            .expect("store invalid fingerprint secret");
        write_vault_files(
            dir,
            json!({
                "salt": STANDARD.encode(salt),
                "masterKey": STANDARD.encode(master_key),
            }),
            vec![json!({
                "key": key,
                "encrypted": STANDARD.encode(entry.ciphertext.as_slice()),
                "iv": STANDARD.encode(entry.nonce.as_slice()),
                "tag": STANDARD.encode(entry.tag.as_slice()),
                "id": entry.id,
                "createdAt": entry.created_at.to_rfc3339(),
                "fingerprint": "invalid-fingerprint",
            })],
        );
    }

    fn write_empty_v1_vault(dir: &TestProviderDir) {
        let salt = [41_u8; 32];
        let master_key = [53_u8; 32];
        write_vault_files(
            dir,
            json!({
                "salt": STANDARD.encode(salt),
                "masterKey": STANDARD.encode(master_key),
            }),
            Vec::new(),
        );
    }

    fn write_v2_vault_secret(dir: &TestProviderDir, key: &str, value: &str, pepper: &str) {
        use aes_gcm::{
            aead::{Aead, KeyInit},
            Aes256Gcm, Nonce,
        };
        use scrypt::{scrypt, Params as ScryptParams};

        let salt = [61_u8; 32];
        let master_key = [71_u8; 32];
        let iv = [7_u8; 12];
        let params = ScryptParams::new(14, 8, 1, 32).expect("scrypt params");
        let mut derived = [0_u8; 32];
        scrypt(
            pepper.as_bytes(),
            b"memphis-vault-state-v2",
            &params,
            &mut derived,
        )
        .expect("derive vault state key");
        let cipher = Aes256Gcm::new_from_slice(derived.as_slice()).expect("build aes");
        let encrypted_master_key_with_tag = cipher
            .encrypt(Nonce::from_slice(&iv), master_key.as_slice())
            .expect("encrypt master key");
        let split = encrypted_master_key_with_tag.len() - 16;
        let encrypted_master_key = &encrypted_master_key_with_tag[..split];
        let tag = &encrypted_master_key_with_tag[split..];

        let vault = Vault::from_parts(salt, master_key);
        let entry = vault.store(key, value.as_bytes()).expect("store v2 secret");
        let encrypted = STANDARD.encode(entry.ciphertext.as_slice());
        let entry_iv = STANDARD.encode(entry.nonce.as_slice());
        let entry_tag = STANDARD.encode(entry.tag.as_slice());

        write_vault_files(
            dir,
            json!({
                "version": 2,
                "salt": STANDARD.encode(salt),
                "encryptedMasterKey": STANDARD.encode(encrypted_master_key),
                "iv": STANDARD.encode(iv),
                "tag": STANDARD.encode(tag),
            }),
            vec![json!({
                "key": key,
                "encrypted": encrypted,
                "iv": entry_iv,
                "tag": entry_tag,
                "id": entry.id,
                "createdAt": entry.created_at.to_rfc3339(),
                "fingerprint": fingerprint_for_entry(key, encrypted.as_str(), entry_iv.as_str()),
            })],
        );
    }

    #[test]
    fn resolve_provider_supports_full_v1_set() {
        let config = config_from(&[
            ("DEFAULT_PROVIDER", "local-fallback"),
            ("SHARED_LLM_API_BASE", "https://shared.example.test"),
            ("SHARED_LLM_API_KEY", "shared-key"),
            (
                "DECENTRALIZED_LLM_API_BASE",
                "https://decentralized.example.test",
            ),
            ("DECENTRALIZED_LLM_API_KEY", "decentralized-key"),
            ("MINIMAX_API_KEY", "minimax-key"),
            ("DEEPSEEK_API_KEY", "deepseek-key"),
            ("GLM_API_KEY", "glm-key"),
            ("ANTHROPIC_API_KEY", "anthropic-key"),
        ]);

        for name in [
            "local-fallback",
            "ollama",
            "shared-llm",
            "decentralized-llm",
            "minimax",
            "deepseek",
            "glm",
            "anthropic",
        ] {
            let runtime = resolve_provider(&config, Some(name)).expect("provider runtime");
            assert_eq!(runtime.name, name);
            assert!(!runtime.default_model().trim().is_empty());
        }
    }

    #[test]
    fn resolve_provider_uses_minimax_vault_ref_value_before_plaintext_key() {
        let dir = TestProviderDir::new("minimax-vault-ref");
        write_v1_vault_secret(&dir, "team_minimax_api", "vault-minimax-key");

        let config = dir.config(&[
            ("DEFAULT_PROVIDER", "minimax"),
            ("MINIMAX_VAULT_KEY", "team_minimax_api"),
            ("MINIMAX_API_KEY", "env-minimax-key"),
        ]);
        let runtime = resolve_provider(&config, Some("minimax")).expect("provider runtime");

        assert_eq!(runtime.api_key.as_deref(), Some("vault-minimax-key"));
        assert!(runtime.is_configured());
    }

    #[test]
    fn resolve_provider_falls_back_to_minimax_plaintext_when_vault_entry_missing() {
        let dir = TestProviderDir::new("minimax-plaintext-fallback");
        write_empty_v1_vault(&dir);

        let config = dir.config(&[
            ("DEFAULT_PROVIDER", "minimax"),
            ("MINIMAX_VAULT_KEY", "missing_minimax_api"),
            ("MINIMAX_API_KEY", "env-minimax-key"),
        ]);
        let runtime = resolve_provider(&config, Some("minimax")).expect("provider runtime");

        assert_eq!(runtime.api_key.as_deref(), Some("env-minimax-key"));
        assert!(runtime.is_configured());
    }

    #[test]
    fn resolve_provider_uses_deepseek_v2_vault_ref_and_reports_configured() {
        let _env_lock = vault_env_lock().lock().expect("lock vault env");
        let _pepper = EnvVarGuard::set("MEMPHIS_VAULT_PEPPER", "provider-test-pepper");
        let dir = TestProviderDir::new("deepseek-v2-vault-ref");
        write_v2_vault_secret(
            &dir,
            "deepseek_api_key",
            "vault-deepseek-key",
            "provider-test-pepper",
        );

        let config = dir.config(&[
            ("DEFAULT_PROVIDER", "deepseek"),
            ("DEEPSEEK_VAULT_KEY", "deepseek_api_key"),
        ]);
        let runtime = resolve_provider(&config, Some("deepseek")).expect("provider runtime");

        assert_eq!(runtime.api_key.as_deref(), Some("vault-deepseek-key"));
        assert!(runtime.status().configured);

        let status = configured_provider_statuses(&config)
            .into_iter()
            .find(|status| status.name == "deepseek")
            .expect("deepseek status");
        assert!(status.configured);
    }

    #[test]
    fn resolve_provider_errors_when_deepseek_vault_secret_fails_integrity() {
        let dir = TestProviderDir::new("deepseek-vault-integrity-error");
        write_v1_vault_secret_with_invalid_fingerprint(
            &dir,
            "deepseek_api_key",
            "vault-deepseek-key",
        );

        let config = dir.config(&[
            ("DEFAULT_PROVIDER", "deepseek"),
            ("DEEPSEEK_VAULT_KEY", "deepseek_api_key"),
            ("DEEPSEEK_API_KEY", "env-deepseek-key"),
        ]);
        let error = resolve_provider(&config, Some("deepseek")).expect_err("provider error");

        assert!(error
            .to_string()
            .contains("vault entry failed integrity check"));
    }

    #[test]
    fn resolve_provider_errors_when_deepseek_vault_cannot_decrypt() {
        let _env_lock = vault_env_lock().lock().expect("lock vault env");
        let _pepper = EnvVarGuard::unset("MEMPHIS_VAULT_PEPPER");
        let dir = TestProviderDir::new("deepseek-vault-error");
        write_v2_vault_secret(
            &dir,
            "deepseek_api_key",
            "vault-deepseek-key",
            "provider-test-pepper",
        );

        let config = dir.config(&[
            ("DEFAULT_PROVIDER", "deepseek"),
            ("DEEPSEEK_VAULT_KEY", "deepseek_api_key"),
            ("DEEPSEEK_API_KEY", "env-deepseek-key"),
        ]);
        let error = resolve_provider(&config, Some("deepseek")).expect_err("provider error");

        assert!(error.to_string().contains("MEMPHIS_VAULT_PEPPER missing"));
    }

    #[test]
    fn resolve_provider_uses_glm_vault_ref_before_plaintext_key() {
        let dir = TestProviderDir::new("glm-vault-ref");
        write_v1_vault_secret(&dir, "glm_api_key", "vault-glm-key");

        let config = dir.config(&[
            ("DEFAULT_PROVIDER", "glm"),
            ("GLM_VAULT_KEY", "glm_api_key"),
            ("GLM_API_KEY", "env-glm-key"),
        ]);
        let runtime = resolve_provider(&config, Some("glm")).expect("provider runtime");

        assert_eq!(runtime.api_key.as_deref(), Some("vault-glm-key"));
        assert!(runtime.is_configured());
    }

    #[test]
    fn resolve_provider_uses_anthropic_vault_ref_before_plaintext_key() {
        let dir = TestProviderDir::new("anthropic-vault-ref");
        write_v1_vault_secret(&dir, "anthropic_api_key", "vault-anthropic-key");

        let config = dir.config(&[
            ("DEFAULT_PROVIDER", "anthropic"),
            ("ANTHROPIC_VAULT_KEY", "anthropic_api_key"),
            ("ANTHROPIC_API_KEY", "env-anthropic-key"),
        ]);
        let runtime = resolve_provider(&config, Some("anthropic")).expect("provider runtime");

        assert_eq!(runtime.api_key.as_deref(), Some("vault-anthropic-key"));
        assert!(runtime.is_configured());
    }

    #[test]
    fn resolve_provider_rejects_anthropic_oauth_refresh_token_vault_refs() {
        let config = config_from(&[
            ("DEFAULT_PROVIDER", "anthropic"),
            ("ANTHROPIC_VAULT_KEY", "anthropic_oauth_refresh_token"),
        ]);

        let error = resolve_provider(&config, Some("anthropic")).expect_err("provider error");
        assert!(error
            .to_string()
            .contains("native rust operator does not support ANTHROPIC_VAULT_KEY=anthropic_oauth_refresh_token"));
    }

    #[test]
    fn build_generate_input_preserves_system_and_tool_manifest() {
        let input = build_generate_input_from_chat(
            &[
                ChatMessage::User {
                    content: "hello memphis".to_string(),
                },
                ChatMessage::Assistant {
                    content: "working on it".to_string(),
                    tool_calls: vec![ChatToolCall {
                        id: "call-1".to_string(),
                        name: "memphis_search".to_string(),
                        arguments: json!({ "query": "hello" }),
                    }],
                },
            ],
            &ChatRequestOptions {
                system_prompt: Some("native rust operator".to_string()),
                ..ChatRequestOptions::default()
            },
            &[ChatToolDefinition {
                name: "memphis_search".to_string(),
                description: "Exact search".to_string(),
                input_schema: json!({ "type": "object" }),
            }],
        );

        assert!(input.contains("SYSTEM: native rust operator"));
        assert!(input.contains("TOOLS: memphis_search"));
        assert!(input.contains("USER: hello memphis"));
        assert!(input.contains("TOOL_CALLS:"));
    }

    #[test]
    fn emit_text_chunks_preserves_text_without_duplicates() {
        let mut chunks = Vec::new();
        emit_text_chunks("hello world", None, None, &mut |event| {
            if let ChatStreamEvent::Text(chunk) = event {
                chunks.push(chunk);
            }
        })
        .expect("chunk emission");

        assert_eq!(chunks, vec!["hello ".to_string(), "world".to_string()]);
        assert_eq!(chunks.join(""), "hello world");
    }

    #[test]
    fn emit_usage_if_changed_skips_duplicate_updates() {
        let usage = TokenUsageSummary {
            prompt_tokens: 10,
            completion_tokens: 2,
            total_tokens: 12,
            estimated: false,
        };
        let mut events = Vec::new();
        let mut last_emitted = None;

        emit_usage_if_changed(&usage, &mut last_emitted, &mut |event| events.push(event));
        emit_usage_if_changed(&usage, &mut last_emitted, &mut |event| events.push(event));

        assert_eq!(events.len(), 1);
        assert_eq!(events[0], ChatStreamEvent::Usage(usage));
    }

    #[test]
    fn provider_status_includes_model_capabilities() {
        let config = config_from(&[
            ("DEFAULT_PROVIDER", "ollama"),
            ("OLLAMA_MODEL", "qwen2.5-coder:3b"),
        ]);
        let runtime = resolve_provider(&config, Some("ollama")).expect("ollama runtime");

        let status = runtime.status();
        let default_model = status
            .model_capabilities
            .iter()
            .find(|capability| capability.model == status.default_model)
            .expect("default model capability");

        assert_eq!(default_model.context_window_tokens, Some(8192));
        assert!(default_model.supports_streaming);
        assert!(!default_model.supports_vision);
    }

    #[test]
    fn minimax_m2_context_window_matches_platform_doc() {
        // Live bug 2026-05-08: TUI status bar showed `ctx:32k` while
        // operator's MiniMax M2.7 session held >99k tokens without
        // overflowing. Hardcode was stale — bumped to 204_800 to match
        // both the platform docs and the TS capability matrix entry.
        assert_eq!(super::minimax_context_window_tokens("minimax-m2.7"), 204_800);
        assert_eq!(super::minimax_context_window_tokens("MiniMax-M2"), 16_384,
            "uppercase input is not lowercased here — caller normalises before");
        assert_eq!(super::minimax_context_window_tokens("minimax-m2"), 204_800);
        assert_eq!(super::minimax_context_window_tokens("abab6.5s-chat"), 16_384);
    }

    #[test]
    fn shared_llm_stream_returns_cancelled_without_waiting_for_full_response() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind test listener");
        let address = listener.local_addr().expect("listener addr");
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept request");
            let mut buffer = [0_u8; 4096];
            let _ = stream.read(&mut buffer);
            std::thread::sleep(Duration::from_millis(400));
            let body = r#"{"output":"slow response","model":"shared-test"}"#;
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            );
            stream
                .write_all(response.as_bytes())
                .expect("write response");
            stream.flush().expect("flush response");
        });

        let base_url = format!("http://{address}");
        let config = config_from(&[
            ("DEFAULT_PROVIDER", "shared-llm"),
            ("SHARED_LLM_API_BASE", base_url.as_str()),
            ("SHARED_LLM_API_KEY", "shared-key"),
            ("GEN_TIMEOUT_MS", "2000"),
        ]);
        let runtime = resolve_provider(&config, Some("shared-llm")).expect("provider runtime");
        let cancel_flag = Arc::new(AtomicBool::new(false));
        let cancel_writer = Arc::clone(&cancel_flag);
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(50));
            cancel_writer.store(true, Ordering::Relaxed);
        });

        let started_at = Instant::now();
        let result = runtime.chat_stream_with_cancel(
            &[ChatMessage::User {
                content: "cancel the blocking provider".to_string(),
            }],
            &ChatRequestOptions::default(),
            &[],
            Some(cancel_flag.as_ref()),
            |_| {},
        );
        let elapsed = started_at.elapsed();

        assert!(matches!(result, Err(OperatorError::Cancelled)));
        assert!(
            elapsed < Duration::from_millis(250),
            "shared-llm cancel took too long: {elapsed:?}"
        );

        server.join().expect("server thread");
    }

    #[test]
    fn extract_provider_error_hint_parses_anthropic_shape() {
        let body = r#"{"type":"error","error":{"type":"invalid_request_error","message":"messages: at least one message is required"}}"#;
        let hint = extract_provider_error_hint(body);
        assert!(hint.contains("invalid_request_error"), "hint was {hint:?}");
        assert!(
            hint.contains("at least one message is required"),
            "hint was {hint:?}"
        );
    }

    #[test]
    fn extract_provider_error_hint_parses_openai_shape() {
        let body = r#"{"error":{"message":"model not found","type":"invalid_request_error","code":"model_not_found"}}"#;
        let hint = extract_provider_error_hint(body);
        assert!(hint.contains("model not found"), "hint was {hint:?}");
    }

    #[test]
    fn extract_provider_error_hint_falls_back_to_snippet_on_non_json() {
        let body = "<html><body>503 gateway timeout</body></html>";
        let hint = extract_provider_error_hint(body);
        assert!(hint.starts_with("<html>"), "hint was {hint:?}");
        assert!(hint.contains("503 gateway timeout"), "hint was {hint:?}");
    }

    #[test]
    fn extract_provider_error_hint_truncates_long_bodies() {
        let body = "x".repeat(500);
        let hint = extract_provider_error_hint(&body);
        assert!(hint.ends_with('…'), "hint was {hint:?}");
        assert!(
            hint.chars().count() <= 201,
            "hint length was {}",
            hint.chars().count()
        );
    }

    #[test]
    fn extract_provider_error_hint_handles_empty_body() {
        assert_eq!(extract_provider_error_hint(""), "<empty body>");
        assert_eq!(extract_provider_error_hint("   "), "<empty body>");
    }

    #[test]
    fn openai_compatible_serializes_tool_call_arguments_as_string() {
        let msg = ChatMessage::Assistant {
            content: String::new(),
            tool_calls: vec![ChatToolCall {
                id: "call_1".to_string(),
                name: "memphis_recall".to_string(),
                arguments: json!({"query": "hello"}),
            }],
        };
        let out = message_to_provider_json(&msg);
        let args = out
            .pointer("/tool_calls/0/function/arguments")
            .expect("arguments present");
        assert!(
            args.is_string(),
            "OpenAI style expects stringified args; got {args:?}"
        );
        assert_eq!(args.as_str().unwrap(), r#"{"query":"hello"}"#);
    }

    #[test]
    fn ollama_serializes_tool_call_arguments_as_object() {
        let msg = ChatMessage::Assistant {
            content: String::new(),
            tool_calls: vec![ChatToolCall {
                id: "call_1".to_string(),
                name: "memphis_recall".to_string(),
                arguments: json!({"query": "hello"}),
            }],
        };
        let out = ollama_message_to_json(&msg);
        let args = out
            .pointer("/tool_calls/0/function/arguments")
            .expect("arguments present");
        assert!(args.is_object(), "Ollama expects object args; got {args:?}");
        assert_eq!(args.get("query").and_then(Value::as_str), Some("hello"));
    }

    #[test]
    fn sanitize_for_json_preserves_polish_multibyte_chars() {
        // Regression: `ę`=0xC4 0x99 used to become `Ä` + `\u{0099}` because
        // the loop did `bytes[i] as char` for non-ASCII bytes.
        let input = "Języki polski: ąćęłńóśźż";
        assert_eq!(sanitize_for_json(input), input);
    }

    #[test]
    fn sanitize_for_json_preserves_assorted_utf8() {
        for input in ["hello", "日本語テスト", "🦀 rust crab", "Ω²√∫ math"] {
            assert_eq!(sanitize_for_json(input), input, "failed for {input:?}");
        }
    }

    #[test]
    fn sanitize_for_json_preserves_valid_u_escapes() {
        assert_eq!(sanitize_for_json(r"\u0119"), r"\u0119");
    }

    #[test]
    fn sanitize_for_json_replaces_short_u_escapes_with_replacement() {
        assert_eq!(sanitize_for_json(r"\u12"), "\u{FFFD}12");
    }

    #[test]
    fn sanitize_for_json_drops_c0_controls_but_keeps_whitespace() {
        assert_eq!(sanitize_for_json("a\tb\nc\rd\x01e"), "a\tb\nc\rde");
    }

    #[test]
    fn ollama_and_openai_agree_on_non_tool_messages() {
        for msg in [
            ChatMessage::System {
                content: "hi".to_string(),
            },
            ChatMessage::User {
                content: "yo".to_string(),
            },
            ChatMessage::Tool {
                tool_call_id: "call_x".to_string(),
                content: "ok".to_string(),
            },
        ] {
            let oai = message_to_provider_json(&msg);
            let oll = ollama_message_to_json(&msg);
            assert_eq!(
                oai, oll,
                "non-tool-call messages must be identical across styles"
            );
        }
    }

    // ─── Phase E1: ContextOverflow detection ─────────────────────────────

    #[test]
    fn detects_openai_compatible_context_length_exceeded() {
        let body = r#"{"error":{"message":"This model's maximum context length is 32768 tokens. However, your messages resulted in 38538 tokens. Please reduce the length of the messages.","type":"invalid_request_error","code":"context_length_exceeded"}}"#;
        assert!(super::is_context_overflow_body(body));
        let (used, window) = super::parse_context_overflow_numbers(body);
        assert_eq!(window, Some(32768));
        assert_eq!(used, Some(38538));
    }

    #[test]
    fn detects_anthropic_prompt_too_long() {
        let body = r#"{"type":"error","error":{"type":"invalid_request_error","message":"prompt is too long: 200000 tokens > 100000 maximum"}}"#;
        assert!(super::is_context_overflow_body(body));
    }

    #[test]
    fn detects_minimax_tokens_too_high() {
        let body = r#"{"error":{"message":"messages: tokens too high (40000 > 32768)"}}"#;
        assert!(super::is_context_overflow_body(body));
    }

    #[test]
    fn does_not_misclassify_unrelated_errors() {
        assert!(!super::is_context_overflow_body(
            r#"{"error":{"message":"unauthorized","code":"auth_failed"}}"#
        ));
        assert!(!super::is_context_overflow_body(
            r#"{"error":{"message":"rate limit exceeded - retry after 60s"}}"#
        ));
        assert!(!super::is_context_overflow_body(""));
    }

    #[test]
    fn parse_returns_none_when_no_plausible_numbers() {
        let body = r#"{"error":{"message":"context window exceeded"}}"#;
        assert!(super::is_context_overflow_body(body));
        let (used, window) = super::parse_context_overflow_numbers(body);
        // Body has no plausible (>= 1024) number pair
        assert_eq!(used, None);
        assert_eq!(window, None);
    }

    // ─── Live-bug regressions (2026-05-08) ───────────────────────────────
    //
    // Operator saw `(Some(2013) / None tokens)` for a Minimax error whose
    // body contained "2013" only as an internal code/id. The old heuristic
    // matched on (token AND exceed) generously and the parser accepted any
    // >=1024 number anywhere — making non-overflow 400s look like overflow.

    #[test]
    fn does_not_misclassify_rate_limit_token_quota() {
        // Common rate-limit shape mentions "token" + "exceed" + a 4-digit
        // number that has nothing to do with prompt size.
        let body =
            r#"{"error":{"message":"token quota exceeded — retry after 1500ms","code":2013}}"#;
        // No "context"/"prompt" word, so the soft fallback should NOT fire
        // and there's no explicit marker either. → not overflow.
        assert!(!super::is_context_overflow_body(body));
    }

    #[test]
    fn does_not_misclassify_session_token_ttl() {
        let body = r#"{"error":{"message":"session token TTL exceeded after 10800 seconds"}}"#;
        // Same: "token"+"exceed" but no context/prompt subject. Not overflow.
        assert!(!super::is_context_overflow_body(body));
    }

    #[test]
    fn parser_rejects_non_token_adjacent_numbers() {
        // "2013" is far from any "token" keyword, "10800" too — must not
        // be picked up as token counts.
        let body = r#"{"error":{"code":2013,"message":"unauthorized","session_age":10800}}"#;
        let (used, window) = super::parse_context_overflow_numbers(body);
        assert_eq!(used, None, "code=2013 is not a token count");
        assert_eq!(window, None, "session_age=10800 is not a token count");
    }

    #[test]
    fn parser_accepts_token_adjacent_numbers() {
        // Verify the adjacency window still catches real overflow numbers.
        let body = r#"{"error":{"message":"context length 32768 tokens, your messages resulted in 38538 tokens"}}"#;
        let (used, window) = super::parse_context_overflow_numbers(body);
        assert_eq!(window, Some(32768));
        assert_eq!(used, Some(38538));
    }

    #[test]
    fn detects_minimax_m27_exceeds_limit_variant() {
        // Live operator 2026-05-08: MiniMax M2.7 returns
        //   "bad_request_error: invalid params, context window exceeds limit (2013)"
        // which uses "exceeds" (no -ed) and pairs the parenthesised
        // remaining-budget figure. Earlier marker list only matched the
        // past-tense forms and missed this; live operator saw raw 400
        // bubble through to the chat surface.
        let body =
            r#"{"error":{"message":"bad_request_error: invalid params, context window exceeds limit (2013)"}}"#;
        assert!(super::is_context_overflow_body(body));
        assert!(super::has_explicit_overflow_marker(body));
    }

    #[test]
    fn detects_invalid_params_exceeds_limit_pattern() {
        // Companion to the above — a body that omits "context window"
        // but still uses MiniMax's "invalid params … exceeds limit"
        // shape. Both clauses must be present.
        let body = r#"{"error":{"code":40001,"message":"invalid params, max_tokens exceeds limit"}}"#;
        assert!(super::has_explicit_overflow_marker(body));
    }
}
