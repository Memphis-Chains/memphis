use std::{
    io::{BufRead, BufReader, ErrorKind},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc,
    },
    thread,
    time::Duration,
};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::{
    openai_codex::CodexBridge, runtime::try_read_vault_secret_plaintext, OperatorConfig,
    OperatorError,
};

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
        /// Opaque MiniMax M3.1 Flash interleaved-thinking state. This stays
        /// in memory for the next tool round and is never rendered to users.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        reasoning_content: Option<String>,
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
    /// MiniMax-M3.1-Flash-specific override from operator configuration.
    pub minimax_reasoning_effort: Option<String>,
    /// Modern MiniMax output limit; includes hidden thinking tokens.
    pub minimax_max_completion_tokens: Option<u32>,
}

#[derive(Debug, Clone)]
pub struct ChatCompletion {
    pub content: String,
    /// Opaque reasoning state returned separately by MiniMax M3.1 Flash.
    pub reasoning_content: Option<String>,
    pub model: String,
    pub provider: String,
    pub tool_calls: Vec<ChatToolCall>,
    pub token_usage: Option<TokenUsageSummary>,
    /// Context window the Codex account granted, when stricter than the
    /// model's declared capability. Mirrors the TypeScript provider so both
    /// surfaces trim history against the same account limit.
    pub effective_context_window: Option<u64>,
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
    OpenAiCodex,
    LocalFallback,
    SharedLlm,
    DecentralizedLlm,
    Ollama,
    Minimax,
    Deepseek,
    Glm,
    Anthropic,
}

#[derive(Clone)]
pub struct ProviderRuntime {
    codex: Option<CodexBridge>,
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

impl std::fmt::Debug for ProviderRuntime {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("ProviderRuntime")
            .field("kind", &self.kind)
            .field("name", &self.name)
            .field("configured", &self.is_configured())
            .finish_non_exhaustive()
    }
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
        let requested_model = opts
            .model
            .as_deref()
            .filter(|value| !value.trim().is_empty())
            .unwrap_or(self.default_model());
        let normalized_model = if self.kind == ProviderKind::Minimax {
            normalize_minimax_model_id(requested_model)
        } else {
            requested_model.to_string()
        };
        let model = normalized_model.as_str();

        match self.kind {
            ProviderKind::OpenAiCodex => {
                self.codex_bridge()?
                    .chat(messages, opts, tools, model, None, |_| {})
            }
            ProviderKind::LocalFallback => {
                let input = build_generate_input_from_chat(messages, opts, tools);
                let content = format!("Fallback response: {input}");
                Ok(ChatCompletion {
                    content: content.clone(),
                    reasoning_content: None,
                    model: model.to_string(),
                    provider: self.name.clone(),
                    tool_calls: Vec::new(),
                    token_usage: Some(estimated_text_usage(input.as_str(), content.as_str())),
                    effective_context_window: None,
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
        let requested_model = opts
            .model
            .as_deref()
            .filter(|value| !value.trim().is_empty())
            .unwrap_or(self.default_model());
        let normalized_model = if self.kind == ProviderKind::Minimax {
            normalize_minimax_model_id(requested_model)
        } else {
            requested_model.to_string()
        };
        let model = normalized_model.as_str();

        match self.kind {
            ProviderKind::OpenAiCodex => {
                self.codex_bridge()?
                    .chat(messages, opts, tools, model, cancel_flag, on_event)
            }
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
                    reasoning_content: None,
                    model: model.to_string(),
                    provider: self.name.clone(),
                    tool_calls: Vec::new(),
                    token_usage: Some(token_usage),
                    effective_context_window: None,
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
            reasoning_content: None,
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
            effective_context_window: None,
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
            let line = line.map_err(|error| match error.kind() {
                ErrorKind::TimedOut => OperatorError::Message(
                    "ollama stream timeout: timed out reading response".to_string(),
                ),
                _ => OperatorError::Message(format!("invalid ollama stream response: {error}")),
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
            reasoning_content: None,
            model: resolved_model,
            provider: self.name.clone(),
            tool_calls,
            token_usage,
            effective_context_window: None,
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
            .map(|message| {
                if self.kind == ProviderKind::Minimax {
                    minimax_message_to_provider_json(message)
                } else {
                    message_to_provider_json(message)
                }
            })
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
            openai_compatible_request_body(self.kind, model, all_messages, opts, tools, false),
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
            reasoning_content: message
                .get("reasoning_content")
                .and_then(Value::as_str)
                .map(ToString::to_string),
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
            effective_context_window: None,
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
            .map(|message| {
                if self.kind == ProviderKind::Minimax {
                    minimax_message_to_provider_json(message)
                } else {
                    message_to_provider_json(message)
                }
            })
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
            openai_compatible_request_body(self.kind, model, all_messages, opts, tools, true),
            Some(api_key),
            self.timeout_ms,
            &[("Accept", "text/event-stream")],
            Some(self.name.as_str()),
        )?;
        let reader = BufReader::new(response.into_reader());
        let mut content = String::new();
        let mut reasoning_content = String::new();
        let mut resolved_model = model.to_string();
        let mut tool_call_accumulators = Vec::new();
        let mut token_usage = None;
        let mut last_emitted_usage = None;

        for line in reader.lines() {
            ensure_not_cancelled(cancel_flag)?;
            let line = line.map_err(|error| match error.kind() {
                ErrorKind::TimedOut => OperatorError::Message(
                    "provider stream timeout: timed out reading response".to_string(),
                ),
                _ => OperatorError::Message(format!("invalid provider stream response: {error}")),
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

            if let Some(token) = delta.get("reasoning_content").and_then(Value::as_str) {
                reasoning_content.push_str(token);
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
            reasoning_content: (!reasoning_content.is_empty()).then_some(reasoning_content),
            model: resolved_model,
            provider: self.name.clone(),
            tool_calls: finalize_stream_tool_calls(tool_call_accumulators),
            token_usage,
            effective_context_window: None,
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
            reasoning_content: None,
            model: body
                .get("model")
                .and_then(Value::as_str)
                .unwrap_or(model)
                .to_string(),
            provider: self.name.clone(),
            tool_calls,
            token_usage,
            effective_context_window: None,
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
            let line = line.map_err(|error| match error.kind() {
                ErrorKind::TimedOut => OperatorError::Message(
                    "anthropic stream timeout: timed out reading response".to_string(),
                ),
                _ => OperatorError::Message(format!("invalid anthropic stream response: {error}")),
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
            reasoning_content: None,
            model: resolved_model,
            provider: self.name.clone(),
            tool_calls: finalize_stream_tool_calls(tool_call_accumulators),
            token_usage,
            effective_context_window: None,
        })
    }

    fn codex_bridge(&self) -> Result<&CodexBridge, OperatorError> {
        self.codex
            .as_ref()
            .ok_or_else(|| OperatorError::Message("OpenAI Codex bridge is not configured".into()))
    }

    pub fn is_configured(&self) -> bool {
        match self.kind {
            // Resolve local prerequisites before chat. A selected Codex
            // provider fails explicitly instead of silently switching models.
            ProviderKind::OpenAiCodex => self.codex.is_some(),
            ProviderKind::LocalFallback | ProviderKind::Ollama => true,
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
            ProviderKind::OpenAiCodex => self
                .codex_bridge()
                .map_err(|e| e.to_string())?
                .check_availability(),
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
            ProviderKind::OpenAiCodex => vec![
                "astra-gtp6-max".into(),
                "gpt-6-astra".into(),
                "gpt-5.6-sol-max".into(),
                "gpt-5.6-sol".into(),
            ],
            ProviderKind::LocalFallback => vec!["local-fallback-v0".to_string()],
            ProviderKind::SharedLlm => vec![self.default_model.clone()],
            ProviderKind::DecentralizedLlm => vec![self.default_model.clone()],
            ProviderKind::Ollama => self
                .fetch_ollama_models()
                .unwrap_or_else(|_| vec![self.default_model.clone()]),
            ProviderKind::Minimax => vec![
                // Officially available LLMs as of 2026-10-24. Retired M2.x
                // ids remain usable only when explicitly configured.
                MINIMAX_M31_FLASH_MODEL.to_string(),
                "MiniMax-M3".to_string(),
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
            ProviderKind::OpenAiCodex => (
                if matches!(
                    normalized.as_str(),
                    "gpt-6-astra"
                        | "astra-gtp6-max"
                        | "astra-gpt6-max"
                        | "gpt-6-astra-max"
                        | "gpt-5.6-sol"
                        | "gpt-5.6-sol-max"
                        | "gpt-5.6-sol max"
                ) {
                    Some(1_050_000)
                } else {
                    None
                },
                false,
            ),
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
                minimax_supports_vision(&normalized),
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

/// MiniMax M3 family is natively multimodal (text, image and video input
/// through the OpenAI-compatible endpoint). Source:
/// platform.minimax.io/docs/api-reference/text-openai-api.md — "Chat
/// Completions support text, image, and video input for MiniMax-M3.1-Flash
/// and MiniMax-M3".
///
/// This is deliberately a MiniMax-specific predicate rather than an
/// addition to `openai_compatible_supports_vision`: that helper is shared
/// with the shared/decentralized LLM and GLM providers, where a stray "m3"
/// substring would mean something unrelated. The legacy M2 family and the
/// abab* series are text-only.
fn minimax_supports_vision(model: &str) -> bool {
    // Normalise inside the predicate rather than relying on the caller.
    // The configured model arrives from .env as "MiniMax-M3.1-Flash"
    // (capitalised), so a case-sensitive `contains("m3")` would miss it —
    // exactly the class of bug that left the M3 family on the 16k branch.
    model.to_ascii_lowercase().contains("m3")
}

fn minimax_context_window_tokens(model: &str) -> u32 {
    // MiniMax ships three distinct context tiers, and the model name is
    // the only thing that distinguishes them:
    //
    //   - M3 family (M3, M3.1, M3.1-Flash, -Preview suffix): 1_000_000.
    //     Source: platform.minimax.io/docs/api-reference/text-openai-api.md
    //     ("MiniMax-M3.1-Flash | 1,000,000"), confirmed live on
    //     2026-10-24 — a 999_209-token prompt was accepted (HTTP 200),
    //     a 1_530_000-token prompt was rejected with
    //     "invalid params, context window exceeds limit (2013)".
    //   - M2 family (M2, M2.5, M2.7, -highspeed): 204_800.
    //   - Legacy abab* series: 16_384.
    //
    // The earlier `if model.contains("m2")` test was a substring check,
    // which is wrong twice over: it missed the whole M3 family (so
    // `minimax-m3.1-flash` fell through to the 16k legacy branch and the
    // TUI status bar read `ctx:16k` for a 1M-token model), and it would
    // have matched a hypothetical "m2" anywhere in an unrelated name.
    // Family matching is prefix-based, mirroring the TS-side
    // `minimaxCapabilities` in src/providers/model-capabilities.ts, so
    // point releases and preview suffixes inherit the family's window
    // without needing a table update for every release.
    let normalized = model.to_ascii_lowercase();
    if normalized.contains("m3") {
        1_000_000
    } else if normalized.contains("m2") {
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
                ..
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
        if let Some(plaintext) = try_read_vault_secret_plaintext(config, vault_key.trim())? {
            return Ok(Some(plaintext));
        }
        if config.env(plaintext_env).is_some() {
            return Err(OperatorError::Vault(
                "PROVIDER_CREDENTIAL_CONFLICT: configured vault entry is unavailable; repair the vault reference or remove it to select the plaintext credential".into(),
            ));
        }
        return Ok(None);
    }

    Ok(config
        .env(plaintext_env)
        .map(|value| value.trim().to_string()))
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
        if vault_key.trim() == "anthropic_oauth_refresh_token" {
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
        "openai" => Ok(ProviderRuntime {
            codex: Some(CodexBridge::from_config(config)?),
            kind: ProviderKind::OpenAiCodex,
            name: "openai".into(),
            base_url: None,
            api_key: None,
            api_key_missing_hint: String::new(),
            default_model: config
                .env("OPENAI_MODEL")
                .unwrap_or("astra-gtp6-max")
                .into(),
            timeout_ms,
        }),
        "local-fallback" => Ok(ProviderRuntime {
            codex: None,
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
                codex: None,
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
                codex: None,
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
            codex: None,
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
            let minimax_timeout_ms = config
                .env("MINIMAX_REQUEST_TIMEOUT_MS")
                .and_then(|value| value.parse::<u64>().ok())
                .filter(|value| (1_000..=86_400_000).contains(value))
                .unwrap_or(timeout_ms);
            Ok(ProviderRuntime {
                codex: None,
                kind: ProviderKind::Minimax,
                name: "minimax".to_string(),
                base_url: config
                    .env("MINIMAX_BASE_URL")
                    .map(ToString::to_string)
                    .or_else(|| Some("https://api.minimax.io/v1".to_string())),
                api_key,
                api_key_missing_hint,
                default_model: normalize_minimax_model_id(
                    config.env("MINIMAX_MODEL").unwrap_or(MINIMAX_M31_FLASH_MODEL),
                ),
                timeout_ms: minimax_timeout_ms,
            })
        }
        "deepseek" => {
            let (api_key, api_key_missing_hint) =
                resolve_api_key_with_diagnostic(config, "DEEPSEEK_VAULT_KEY", "DEEPSEEK_API_KEY")?;
            Ok(ProviderRuntime {
                codex: None,
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
                codex: None,
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
                codex: None,
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
        "openai",
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

const MINIMAX_M31_FLASH_MODEL: &str = "MiniMax-M3.1-Flash";
const MINIMAX_M3_RECOMMENDED_COMPLETION_TOKENS: u32 = 131_072;
const MINIMAX_M3_MAX_COMPLETION_TOKENS: u32 = 524_288;

fn normalize_minimax_model_id(model: &str) -> String {
    let trimmed = model.trim();
    if trimmed.eq_ignore_ascii_case("MiniMax-M3.1-Flash-Preview") {
        MINIMAX_M31_FLASH_MODEL.to_string()
    } else {
        trimmed.to_string()
    }
}

fn is_minimax_m31_flash(model: &str) -> bool {
    normalize_minimax_model_id(model).eq_ignore_ascii_case(MINIMAX_M31_FLASH_MODEL)
}

fn minimax_reasoning_effort(opts: &ChatRequestOptions) -> &str {
    match opts.minimax_reasoning_effort.as_deref().map(str::trim) {
        Some(value @ ("low" | "medium" | "high" | "xhigh" | "max")) => value,
        _ => "max",
    }
}

fn openai_compatible_request_body(
    kind: ProviderKind,
    model: &str,
    messages: Vec<Value>,
    opts: &ChatRequestOptions,
    tools: &[ChatToolDefinition],
    stream: bool,
) -> Value {
    let mut payload = json!({
        "model": model,
        "messages": messages,
        "tools": build_tools_json(tools),
    });

    if kind == ProviderKind::Minimax && is_minimax_m31_flash(model) {
        let max_completion_tokens = opts
            .minimax_max_completion_tokens
            .or(opts.max_tokens)
            .unwrap_or(MINIMAX_M3_RECOMMENDED_COMPLETION_TOKENS)
            .clamp(1, MINIMAX_M3_MAX_COMPLETION_TOKENS);
        payload["max_completion_tokens"] = json!(max_completion_tokens);
        payload["reasoning_effort"] = json!(minimax_reasoning_effort(opts));
        payload["reasoning_split"] = Value::Bool(true);
        payload["thinking"] = json!({ "type": "adaptive" });
        if stream {
            payload["stream_options"] = json!({ "include_usage": true });
        }
    } else {
        payload["temperature"] = json!(opts.temperature.unwrap_or(0.7));
        payload["max_tokens"] = json!(opts.max_tokens.unwrap_or(2048));
    }

    if stream {
        payload["stream"] = Value::Bool(true);
    }
    payload
}

fn message_to_provider_json(message: &ChatMessage) -> Value {
    build_message_json(message, ProviderMessageStyle::OpenAiCompatible)
}

fn minimax_message_to_provider_json(message: &ChatMessage) -> Value {
    build_message_json(message, ProviderMessageStyle::Minimax)
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
    Minimax,
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
            reasoning_content,
        } => {
            let mut output = if tool_calls.is_empty() {
                json!({ "role": "assistant", "content": sanitize_for_json(content) })
            } else {
                json!({
                    "role": "assistant",
                    "content": if content.is_empty() { Value::Null } else { Value::String(content.clone()) },
                    "tool_calls": tool_calls
                        .iter()
                        .map(|call| {
                            let arguments: Value = match style {
                                ProviderMessageStyle::OpenAiCompatible
                                | ProviderMessageStyle::Minimax => Value::String(
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
            };
            if style == ProviderMessageStyle::Minimax {
                if let Some(reasoning_content) = reasoning_content
                    .as_deref()
                    .filter(|value| !value.is_empty())
                {
                    output["reasoning_content"] =
                        Value::String(sanitize_for_json(reasoning_content));
                }
            }
            output
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
            ..
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
        reasoning_content: None,
        model: resolved_model,
        provider: provider_name.to_string(),
        tool_calls: Vec::new(),
        token_usage: parse_generate_provider_usage(&body),
        effective_context_window: None,
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
///
/// Codex Round 1 #536: a body like "invalid params, max_tokens exceeds
/// limit" was matching the "invalid params + exceeds limit" branch and
/// emitting `ContextOverflow` (which advises `/clear`), but `/clear`
/// doesn't help when the operator's `MEMPHIS_GEN_MAX_TOKENS` is over
/// the provider's per-request OUTPUT cap. We now distinguish the two:
///   - `context window exceeds`           → context overflow, `/clear` ok
///   - `max_tokens` (or `output` etc) close to "exceeds limit" → param
///     cap, NOT a context-overflow case (caller should fall through to
///     generic error so the operator gets the real provider hint, e.g.
///     "lower MEMPHIS_GEN_MAX_TOKENS").
fn has_explicit_overflow_marker(body: &str) -> bool {
    let lower = body.to_ascii_lowercase();
    if lower.contains("context_length_exceeded")
        || lower.contains("maximum context length")
        || lower.contains("prompt is too long")
        || lower.contains("tokens too high")
        || lower.contains("context window exceeded")
        // Live MiniMax M2.7 variant observed 2026-05-08:
        //   "bad_request_error: invalid params, context window exceeds limit (2013)"
        // Note "exceeds" (no -ed) and the parenthesised remaining-budget
        // figure. The earlier markers all expected past tense.
        || lower.contains("context window exceeds")
    {
        return true;
    }
    // Generic "invalid params … exceeds limit" — only counts as
    // context-overflow when "max_tokens" / "output" / "completion_tokens"
    // are NOT mentioned (those denote a parameter cap, separate concern).
    if lower.contains("invalid params") && lower.contains("exceeds limit") {
        let is_param_cap = lower.contains("max_tokens")
            || lower.contains("output_tokens")
            || lower.contains("completion_tokens")
            || lower.contains("output limit");
        return !is_param_cap;
    }
    false
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

    /// Like `write_v2_vault_secret`, but APPENDS to an existing entries file
    /// instead of replacing it, so several secrets can share one vault.
    ///
    /// `write_v2_vault_secret` overwrites the whole entries file each call,
    /// which is fine when a test needs one secret and silently wrong when
    /// it needs three: the second call erases the first. The cache test
    /// that failed on exactly this wrote three secrets and got None for
    /// the first one.
    fn append_v2_vault_secret(dir: &TestProviderDir, key: &str, value: &str, pepper: &str) {
        use aes_gcm::{
            aead::{Aead, KeyInit},
            Aes256Gcm, Nonce,
        };
        use scrypt::{scrypt, Params as ScryptParams};

        let salt = [61_u8; 32];
        let master_key = [71_u8; 32];
        let iv = [7_u8; 12];

        // Write the state file only if this is the first secret, so the
        // state bytes stay stable across appends.
        if !dir.vault_state_path().exists() {
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
            fs::write(
                dir.vault_state_path(),
                serde_json::to_vec(&json!({
                    "version": 2,
                    "salt": STANDARD.encode(salt),
                    "encryptedMasterKey": STANDARD.encode(&encrypted_master_key_with_tag[..split]),
                    "iv": STANDARD.encode(iv),
                    "tag": STANDARD.encode(&encrypted_master_key_with_tag[split..]),
                }))
                .expect("serialize vault state"),
            )
            .expect("write vault state");
        }

        let vault = Vault::from_parts(salt, master_key);
        let entry = vault.store(key, value.as_bytes()).expect("store v2 secret");
        let encrypted = STANDARD.encode(entry.ciphertext.as_slice());
        let entry_iv = STANDARD.encode(entry.nonce.as_slice());
        let entry_tag = STANDARD.encode(entry.tag.as_slice());

        let mut existing: Vec<Value> = std::fs::read(dir.vault_entries_path())
            .ok()
            .and_then(|raw| serde_json::from_slice(&raw).ok())
            .unwrap_or_default();
        existing.push(json!({
            "key": key,
            "encrypted": encrypted,
            "iv": entry_iv,
            "tag": entry_tag,
            "id": entry.id,
            "createdAt": entry.created_at.to_rfc3339(),
            "fingerprint": fingerprint_for_entry(key, encrypted.as_str(), entry_iv.as_str()),
        }));
        fs::write(
            dir.vault_entries_path(),
            serde_json::to_vec(&existing).expect("serialize vault entries"),
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

    // ── Vault derivation cache (2026-09-30) ───────────────────────────────
    //
    // `load_vault` runs scrypt(N=16384, r=8, p=1) - measured at ~4 s on
    // this operator's hardware, deliberately, because the parameter is the
    // vault's brute-force defence. It was being paid once per provider
    // lookup, so `configured_provider_statuses` cost 12.3 s of pure KDF
    // and `memphis-tui --check-only` hit 15.6 s against a 15 s test
    // timeout. The fix memoises the derived handle on (path, state bytes,
    // pepper).
    //
    // A cache in the credential path is the kind of thing that has to be
    // proven, not assumed. Every test below was mutation-verified: each
    // one dies when the corresponding line of `load_vault_cached` is
    // removed.

    #[test]
    fn vault_derivation_cache_evicts_replaced_and_failed_generations() {
        let _env_lock = vault_env_lock().lock().expect("lock vault env");
        crate::runtime::clear_vault_derivation_cache();
        let dir = TestProviderDir::new("vault-cache-lifecycle");
        write_v1_vault_secret(&dir, "minimax_api_key", "synthetic-cache-secret");
        let mut config = dir.config(&[("MINIMAX_VAULT_KEY", "minimax_api_key")]);
        let state = fs::read(dir.vault_state_path()).unwrap();
        let (before, _) = crate::runtime::vault_derivation_count();
        for generation in [1, 2, 1] {
            config.config_generation = generation;
            let provider = resolve_provider(&config, Some("minimax")).unwrap();
            assert_eq!(provider.api_key.as_deref(), Some("synthetic-cache-secret"));
        }
        let (after, _) = crate::runtime::vault_derivation_count();
        assert_eq!(
            after - before,
            3,
            "only the current generation may remain cached"
        );

        for failure in ["malformed", "missing"] {
            if failure == "missing" {
                fs::remove_file(dir.vault_state_path()).unwrap();
            } else {
                fs::write(dir.vault_state_path(), "{synthetic-invalid-state").unwrap();
            }
            assert!(resolve_provider(&config, Some("minimax")).is_err());
            let (failed, _) = crate::runtime::vault_derivation_count();
            fs::write(dir.vault_state_path(), &state).unwrap();
            resolve_provider(&config, Some("minimax")).unwrap();
            let (restored, _) = crate::runtime::vault_derivation_count();
            assert_eq!(restored - failed, 1, "{failure} must evict the old key");
        }
        crate::runtime::clear_vault_derivation_cache();
    }

    #[test]
    fn vault_derivation_cache_does_not_retain_prior_state_bytes() {
        let _env_lock = vault_env_lock().lock().expect("lock vault env");
        crate::runtime::clear_vault_derivation_cache();
        let dir = TestProviderDir::new("vault-cache-old-state");
        write_v1_vault_secret(&dir, "minimax_api_key", "synthetic-cache-secret");
        let config = dir.config(&[("MINIMAX_VAULT_KEY", "minimax_api_key")]);
        let original = fs::read(dir.vault_state_path()).unwrap();
        let mut replaced: Value = serde_json::from_slice(&original).unwrap();
        replaced["salt"] = json!(STANDARD.encode([9_u8; 32]));
        let (before, _) = crate::runtime::vault_derivation_count();
        for bytes in [
            &original,
            &serde_json::to_vec(&replaced).unwrap(),
            &original,
        ] {
            fs::write(dir.vault_state_path(), bytes).unwrap();
            resolve_provider(&config, Some("minimax")).unwrap();
        }
        let (after, _) = crate::runtime::vault_derivation_count();
        assert_eq!(after - before, 3, "replaced key material must be evicted");
        crate::runtime::clear_vault_derivation_cache();
    }

    #[test]
    fn vault_derivation_cache_observes_entry_replacement_and_removal_without_another_kdf() {
        let _env_lock = vault_env_lock().lock().expect("lock vault env");
        crate::runtime::clear_vault_derivation_cache();
        let dir = TestProviderDir::new("vault-cache-entry-lifecycle");
        let config = dir.config(&[("MINIMAX_VAULT_KEY", "minimax_api_key")]);
        let (before, _) = crate::runtime::vault_derivation_count();
        let mut original_state = None;
        for value in ["synthetic-first", "synthetic-second"] {
            write_v1_vault_secret(&dir, "minimax_api_key", value);
            let state = fs::read(dir.vault_state_path()).unwrap();
            if let Some(previous) = &original_state {
                assert_eq!(&state, previous, "only the entry changes");
            }
            original_state = Some(state);
            let provider = resolve_provider(&config, Some("minimax")).unwrap();
            assert_eq!(provider.api_key.as_deref(), Some(value));
        }
        fs::write(dir.vault_entries_path(), "[]").unwrap();
        let provider = resolve_provider(&config, Some("minimax")).unwrap();
        assert!(
            !provider.is_configured(),
            "a removed entry cannot remain usable"
        );
        let (after, _) = crate::runtime::vault_derivation_count();
        assert_eq!(
            after - before,
            1,
            "entry changes do not require another KDF"
        );
        crate::runtime::clear_vault_derivation_cache();
    }

    #[test]
    fn vault_derivation_cache_clear_forces_a_fresh_load() {
        let _env_lock = vault_env_lock().lock().expect("lock vault env");
        crate::runtime::clear_vault_derivation_cache();
        let dir = TestProviderDir::new("vault-cache-explicit-clear");
        write_v1_vault_secret(&dir, "minimax_api_key", "synthetic-cache-secret");
        let config = dir.config(&[("MINIMAX_VAULT_KEY", "minimax_api_key")]);
        let (before, hits_before) = crate::runtime::vault_derivation_count();
        for _ in 0..2 {
            let provider = resolve_provider(&config, Some("minimax")).expect("resolve fixture");
            assert_eq!(provider.api_key.as_deref(), Some("synthetic-cache-secret"));
        }
        let (loaded, hits) = crate::runtime::vault_derivation_count();
        assert_eq!(loaded - before, 1);
        assert_eq!(hits - hits_before, 1);

        crate::runtime::clear_vault_derivation_cache();
        let provider = resolve_provider(&config, Some("minimax")).expect("resolve after clear");
        assert_eq!(provider.api_key.as_deref(), Some("synthetic-cache-secret"));
        let (reloaded, hits_after_clear) = crate::runtime::vault_derivation_count();
        assert_eq!(
            reloaded - loaded,
            1,
            "clear must evict the reader's cached handle"
        );
        assert_eq!(
            hits_after_clear, hits,
            "the first read after clear must miss"
        );
        crate::runtime::clear_vault_derivation_cache();
    }

    /// Derive the same secret repeatedly. If the cache works this is one
    /// KDF, not three; the assertion is on the RESULT, not the clock, so
    /// it cannot flake under load. A timing assertion here would be
    /// exactly the flaky-timeout mistake this whole change removes.
    #[test]
    fn vault_derivation_cache_returns_the_same_secret_for_every_provider() {
        let _env_lock = vault_env_lock().lock().expect("lock vault env");
        let _pepper = EnvVarGuard::set("MEMPHIS_VAULT_PEPPER", "provider-test-pepper");
        crate::runtime::clear_vault_derivation_cache();

        let dir = TestProviderDir::new("vault-cache-three-providers");
        // One vault, three entries - the shape that used to pay the KDF
        // three times.
        append_v2_vault_secret(&dir, "minimax_api_key", "k-minimax", "provider-test-pepper");
        append_v2_vault_secret(
            &dir,
            "deepseek_api_key",
            "k-deepseek",
            "provider-test-pepper",
        );
        append_v2_vault_secret(&dir, "glm_api_key", "k-glm", "provider-test-pepper");

        let config = dir.config(&[
            ("DEFAULT_PROVIDER", "minimax"),
            ("MINIMAX_VAULT_KEY", "minimax_api_key"),
            ("DEEPSEEK_VAULT_KEY", "deepseek_api_key"),
            ("GLM_VAULT_KEY", "glm_api_key"),
        ]);

        for (name, expected) in [
            ("minimax", "k-minimax"),
            ("deepseek", "k-deepseek"),
            ("glm", "k-glm"),
        ] {
            let runtime = resolve_provider(&config, Some(name)).expect("provider runtime");
            assert_eq!(
                runtime.api_key.as_deref(),
                Some(expected),
                "{name} must resolve its own secret"
            );
        }

        crate::runtime::clear_vault_derivation_cache();
    }

    /// The three correctness tests above all pass even if the cache is
    /// never read or never written - both mutants return the same decrypted
    /// secret, just slower. So assert the KDF ran ONCE for three provider
    /// lookups. That is the property the 12-second startup cost lived in,
    /// and it is checkable without a clock.
    #[test]
    fn vault_derivation_cache_runs_the_kdf_once_for_three_providers() {
        let _env_lock = vault_env_lock().lock().expect("lock vault env");
        let _pepper = EnvVarGuard::set("MEMPHIS_VAULT_PEPPER", "provider-test-pepper");
        crate::runtime::clear_vault_derivation_cache();

        let dir = TestProviderDir::new("vault-cache-derivation-count");
        append_v2_vault_secret(&dir, "minimax_api_key", "k-minimax", "provider-test-pepper");
        append_v2_vault_secret(
            &dir,
            "deepseek_api_key",
            "k-deepseek",
            "provider-test-pepper",
        );
        append_v2_vault_secret(&dir, "glm_api_key", "k-glm", "provider-test-pepper");

        let config = dir.config(&[
            ("DEFAULT_PROVIDER", "minimax"),
            ("MINIMAX_VAULT_KEY", "minimax_api_key"),
            ("DEEPSEEK_VAULT_KEY", "deepseek_api_key"),
            ("GLM_VAULT_KEY", "glm_api_key"),
        ]);

        let (before, _) = crate::runtime::vault_derivation_count();
        for name in ["minimax", "deepseek", "glm"] {
            resolve_provider(&config, Some(name)).expect("provider runtime");
        }
        let (after, hits) = crate::runtime::vault_derivation_count();

        assert_eq!(
            after - before,
            1,
            "three provider lookups must derive the master key once, not three times"
        );
        assert!(
            hits >= 2,
            "at least two lookups must be served from the cache"
        );

        crate::runtime::clear_vault_derivation_cache();
    }

    /// The cache key includes the state file's contents, so a rewritten
    /// state must not be served from the previous one. Removing the state
    /// digest from the fingerprint makes this fail - that is the mutant
    /// this test exists for.
    #[test]
    fn vault_derivation_cache_does_not_survive_a_state_rewrite() {
        let _env_lock = vault_env_lock().lock().expect("lock vault env");
        let _pepper = EnvVarGuard::set("MEMPHIS_VAULT_PEPPER", "provider-test-pepper");
        crate::runtime::clear_vault_derivation_cache();

        let dir = TestProviderDir::new("vault-cache-state-rewrite");
        write_v2_vault_secret(
            &dir,
            "minimax_api_key",
            "first-value",
            "provider-test-pepper",
        );
        let config = dir.config(&[
            ("DEFAULT_PROVIDER", "minimax"),
            ("MINIMAX_VAULT_KEY", "minimax_api_key"),
        ]);

        let first = resolve_provider(&config, Some("minimax")).expect("first resolve");
        assert_eq!(first.api_key.as_deref(), Some("first-value"));

        // Rewrite the vault in place with a different secret.
        write_v2_vault_secret(
            &dir,
            "minimax_api_key",
            "second-value",
            "provider-test-pepper",
        );

        // `write_v2_vault_secret` reuses a fixed salt / master key / iv, so
        // the STATE file is byte-identical between the two writes - only the
        // entry changed. That made this test pass against a mutant that
        // dropped the state digest from the cache key, because the entries
        // are re-read from disk every call and the memoised VAULT was
        // legitimately still correct. Re-randomise the state bytes so the
        // key it produces actually differs.
        let state_path = dir.vault_state_path();
        let mut state: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&state_path).expect("read state"))
                .expect("parse state");
        let rotated = STANDARD.encode([222_u8; 32]);
        state["salt"] = serde_json::Value::String(rotated);
        std::fs::write(&state_path, serde_json::to_vec(&state).expect("serialize"))
            .expect("write rotated state");

        let second = resolve_provider(&config, Some("minimax")).expect("second resolve");

        assert_eq!(
            second.api_key.as_deref(),
            Some("second-value"),
            "a rewritten vault state must not be served from the derivation cache"
        );

        crate::runtime::clear_vault_derivation_cache();
    }

    /// The cache key includes the pepper. Two different peppers of the SAME
    /// LENGTH must not collide - the first version of the fingerprint used
    /// `pepper.len()`, so they did. Removing the pepper from the
    /// fingerprint makes this fail.
    #[test]
    fn vault_derivation_cache_separates_equal_length_peppers() {
        let _env_lock = vault_env_lock().lock().expect("lock vault env");
        crate::runtime::clear_vault_derivation_cache();

        let dir = TestProviderDir::new("vault-cache-pepper-collision");
        write_v2_vault_secret(&dir, "minimax_api_key", "k-minimax", "aaaaaaaaaaaa");
        let config = dir.config(&[
            ("DEFAULT_PROVIDER", "minimax"),
            ("MINIMAX_VAULT_KEY", "minimax_api_key"),
        ]);

        // Right pepper: resolves.
        let _pepper = EnvVarGuard::set("MEMPHIS_VAULT_PEPPER", "aaaaaaaaaaaa");
        let ok = resolve_provider(&config, Some("minimax")).expect("correct pepper resolves");
        assert_eq!(ok.api_key.as_deref(), Some("k-minimax"));

        // Different pepper, same length: must FAIL to decrypt, not be
        // served the previous vault from cache.
        let _pepper2 = EnvVarGuard::set("MEMPHIS_VAULT_PEPPER", "bbbbbbbbbbbb");
        let err = resolve_provider(&config, Some("minimax"))
            .expect_err("wrong pepper must not hit the cache");
        assert!(
            err.to_string().to_lowercase().contains("decrypt")
                || err.to_string().to_lowercase().contains("vault"),
            "expected a vault/decrypt error, got: {err}"
        );

        crate::runtime::clear_vault_derivation_cache();
    }

    #[test]
    fn provider_debug_does_not_serialize_credential_material() {
        let config = config_from(&[("MINIMAX_API_KEY", "synthetic-private-provider-value")]);
        let provider = resolve_provider(&config, Some("minimax")).unwrap();
        let diagnostic = format!("{provider:?}");
        assert!(!diagnostic.contains("synthetic-private-provider-value"));
        assert!(diagnostic.contains("Minimax"));
    }

    #[test]
    fn resolve_openai_codex_without_vault_or_api_key() {
        let config = config_from(&[
            ("DEFAULT_PROVIDER", "openai"),
            ("OPENAI_API_KEY", "synthetic-unused-api-key"),
        ]);
        let provider = resolve_provider(&config, Some("openai")).unwrap();
        assert_eq!(provider.default_model(), "astra-gtp6-max");
        assert!(provider.is_configured());
        assert!(provider.api_key.is_none());
        assert!(provider.list_models().contains(&"astra-gtp6-max".into()));
        assert!(provider.list_models().contains(&"gpt-5.6-sol-max".into()));
        assert_eq!(
            provider
                .model_capability("astra-gtp6-max")
                .context_window_tokens,
            Some(1_050_000)
        );
        assert_eq!(
            provider
                .model_capability("gpt-5.6-sol-max")
                .context_window_tokens,
            Some(1_050_000)
        );
        assert!(!format!("{provider:?}").contains("synthetic-unused-api-key"));
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
    fn resolve_provider_rejects_plaintext_when_explicit_vault_entry_is_missing() {
        let dir = TestProviderDir::new("minimax-plaintext-fallback");
        write_empty_v1_vault(&dir);

        let config = dir.config(&[
            ("DEFAULT_PROVIDER", "minimax"),
            ("MINIMAX_VAULT_KEY", "missing_minimax_api"),
            ("MINIMAX_API_KEY", "env-minimax-key"),
        ]);
        let error = resolve_provider(&config, Some("minimax")).expect_err("credential conflict");
        assert!(error.to_string().contains("PROVIDER_CREDENTIAL_CONFLICT"));
        assert!(!error.to_string().contains("env-minimax-key"));
    }

    #[test]
    fn resolve_provider_alias_lifecycle_matches_the_shared_fixture() {
        let _env_lock = vault_env_lock().lock().expect("lock vault env");
        let cases: Vec<Value> = serde_json::from_str(include_str!(
            "../../../tests/fixtures/provider-vault-alias.synthetic.json"
        ))
        .unwrap();
        for case in cases {
            let provider = case["provider"].as_str().unwrap();
            let reference = case["referenceEnv"].as_str().unwrap();
            let plaintext = case["plaintextEnv"].as_str().unwrap();
            let default_key = case["defaultKey"].as_str().unwrap();
            let custom_key = case["customKey"].as_str().unwrap();
            let dir = TestProviderDir::new("shared-alias-lifecycle");
            write_v1_vault_secret(&dir, default_key, "synthetic-default");
            let default_entries: Vec<Value> =
                serde_json::from_slice(&fs::read(dir.vault_entries_path()).unwrap()).unwrap();
            write_v1_vault_secret(&dir, custom_key, "synthetic-custom");
            let custom_entries: Vec<Value> =
                serde_json::from_slice(&fs::read(dir.vault_entries_path()).unwrap()).unwrap();
            let mut entries = default_entries.clone();
            entries.extend(custom_entries);
            fs::write(
                dir.vault_entries_path(),
                serde_json::to_vec(&entries).unwrap(),
            )
            .unwrap();
            let config = dir.config(&[
                (reference, default_key),
                (plaintext, "synthetic-plaintext-shadow"),
            ]);
            assert_eq!(
                resolve_provider(&config, Some(provider))
                    .unwrap()
                    .api_key
                    .as_deref(),
                Some("synthetic-default")
            );
            let padded = format!(" {custom_key} ");
            let config = dir.config(&[
                (reference, &padded),
                (plaintext, "synthetic-plaintext-shadow"),
            ]);
            assert_eq!(
                resolve_provider(&config, Some(provider))
                    .unwrap()
                    .api_key
                    .as_deref(),
                Some("synthetic-custom")
            );
            write_v1_vault_secret(&dir, custom_key, "synthetic-replacement");
            let replacement: Vec<Value> =
                serde_json::from_slice(&fs::read(dir.vault_entries_path()).unwrap()).unwrap();
            entries.extend(replacement.clone());
            fs::write(
                dir.vault_entries_path(),
                serde_json::to_vec(&entries).unwrap(),
            )
            .unwrap();
            assert_eq!(
                resolve_provider(&config, Some(provider))
                    .unwrap()
                    .api_key
                    .as_deref(),
                Some("synthetic-replacement")
            );
            fs::write(
                dir.vault_entries_path(),
                serde_json::to_vec(&default_entries).unwrap(),
            )
            .unwrap();
            let error = resolve_provider(&config, Some(provider))
                .expect_err("explicit reference cannot fall back");
            assert!(error.to_string().contains("PROVIDER_CREDENTIAL_CONFLICT"));
            assert!(!error.to_string().contains("synthetic-plaintext-shadow"));
            let missing = dir.config(&[(reference, custom_key)]);
            assert!(!resolve_provider(&missing, Some(provider))
                .unwrap()
                .is_configured());
            let mut corrupt = replacement[0].clone();
            corrupt["fingerprint"] = json!("synthetic-invalid-fingerprint");
            entries.push(corrupt);
            fs::write(
                dir.vault_entries_path(),
                serde_json::to_vec(&entries).unwrap(),
            )
            .unwrap();
            let error = resolve_provider(&config, Some(provider))
                .expect_err("corrupt latest entry cannot fall back");
            assert!(error.to_string().contains("VAULT_ENTRY_INTEGRITY_FAILED"));
            let plain = dir.config(&[
                (reference, "  "),
                (plaintext, " synthetic-plaintext-shadow "),
            ]);
            assert_eq!(
                resolve_provider(&plain, Some(provider))
                    .unwrap()
                    .api_key
                    .as_deref(),
                Some("synthetic-plaintext-shadow")
            );
        }
        crate::runtime::clear_vault_derivation_cache();
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

        assert!(error.to_string().contains("VAULT_ENTRY_INTEGRITY_FAILED"));
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
        for reference in [
            "anthropic_oauth_refresh_token",
            "  anthropic_oauth_refresh_token  ",
        ] {
            let config = config_from(&[
                ("DEFAULT_PROVIDER", "anthropic"),
                ("ANTHROPIC_VAULT_KEY", reference),
            ]);
            let error = resolve_provider(&config, Some("anthropic")).expect_err("provider error");
            assert!(error.to_string().contains("native rust operator does not support ANTHROPIC_VAULT_KEY=anthropic_oauth_refresh_token"));
        }
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
                    reasoning_content: None,
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
        assert_eq!(
            super::minimax_context_window_tokens("minimax-m2.7"),
            204_800
        );
        // 2026-10-24: this used to assert 16_384 with the note "uppercase
        // input is not lowercased here — caller normalises before". That
        // documented a real defect: the function was case-sensitive, so a
        // capitalised model name fell through to the legacy branch. The
        // predicate now normalises internally, and the family test below
        // covers the M3 side of the same bug.
        assert_eq!(
            super::minimax_context_window_tokens("MiniMax-M2"),
            204_800,
            "capitalised model names must resolve to the same family window"
        );
        assert_eq!(super::minimax_context_window_tokens("minimax-m2"), 204_800);
        assert_eq!(
            super::minimax_context_window_tokens("abab6.5s-chat"),
            16_384
        );
    }

    #[test]
    fn minimax_m3_context_window_is_one_million() {
        // Live bug 2026-10-24: the TUI status bar showed `ctx:16k` for
        // the then-configured Preview alias of the 1M-token M3.1 model.
        // The runtime now uses the GA `MiniMax-M3.1-Flash` id. The old
        // predicate was `if model.contains("m2")`, a case-sensitive
        // substring test that matched neither "MiniMax-M3.1-Flash" nor
        // its lowercase form, so the whole M3 family fell through to the
        // legacy abab* branch.
        //
        // Bracketed live against the real endpoint on 2026-10-24:
        // 999_209 prompt tokens → HTTP 200, 1_530_000 → HTTP 400
        // "invalid params, context window exceeds limit (2013)".
        for model in [
            "MiniMax-M3.1-Flash",
            "MiniMax-M3.1-Flash-Preview",
            "minimax-m3.1-flash",
            "MiniMax-M3",
            "minimax-m3",
        ] {
            assert_eq!(
                super::minimax_context_window_tokens(model),
                1_000_000,
                "{model} must inherit the M3 family window"
            );
        }
    }

    #[test]
    fn minimax_m3_family_is_multimodal() {
        // M3.1-Flash accepts text, image and video input through the
        // OpenAI-compatible endpoint. The legacy M2 family is text-only.
        for model in ["minimax-m3.1-flash", "MiniMax-M3.1-Flash-Preview", "minimax-m3"] {
            assert!(super::minimax_supports_vision(model), "{model} must be multimodal");
        }
        for model in ["minimax-m2.7", "MiniMax-M2.7", "abab6.5s-chat"] {
            assert!(
                !super::minimax_supports_vision(model),
                "{model} must stay text-only"
            );
        }
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
            reasoning_content: None,
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
    fn minimax_m31_payload_uses_ga_thinking_contract() {
        let opts = ChatRequestOptions {
            temperature: Some(0.2),
            max_tokens: Some(4_096),
            minimax_reasoning_effort: Some("xhigh".to_string()),
            minimax_max_completion_tokens: Some(131_072),
            ..ChatRequestOptions::default()
        };
        let payload = openai_compatible_request_body(
            ProviderKind::Minimax,
            MINIMAX_M31_FLASH_MODEL,
            vec![json!({ "role": "user", "content": "test" })],
            &opts,
            &[],
            true,
        );

        assert_eq!(payload["max_completion_tokens"], json!(131_072));
        assert_eq!(payload["reasoning_effort"], json!("xhigh"));
        assert_eq!(payload["thinking"], json!({ "type": "adaptive" }));
        assert_eq!(payload["reasoning_split"], json!(true));
        assert_eq!(payload["stream_options"], json!({ "include_usage": true }));
        assert!(payload.get("temperature").is_none());
        assert!(payload.get("max_tokens").is_none());
    }

    #[test]
    fn minimax_m31_payload_clamps_limit_and_rejects_none_effort() {
        let opts = ChatRequestOptions {
            minimax_reasoning_effort: Some("none".to_string()),
            minimax_max_completion_tokens: Some(u32::MAX),
            ..ChatRequestOptions::default()
        };
        let payload = openai_compatible_request_body(
            ProviderKind::Minimax,
            MINIMAX_M31_FLASH_MODEL,
            Vec::new(),
            &opts,
            &[],
            false,
        );

        assert_eq!(payload["max_completion_tokens"], json!(524_288));
        assert_eq!(payload["reasoning_effort"], json!("max"));
    }

    #[test]
    fn minimax_replays_reasoning_only_on_minimax_messages() {
        let msg = ChatMessage::Assistant {
            content: String::new(),
            tool_calls: Vec::new(),
            reasoning_content: Some("opaque state".to_string()),
        };

        assert_eq!(
            minimax_message_to_provider_json(&msg)["reasoning_content"],
            json!("opaque state")
        );
        assert!(message_to_provider_json(&msg)
            .get("reasoning_content")
            .is_none());
        assert!(ollama_message_to_json(&msg)
            .get("reasoning_content")
            .is_none());
    }

    #[test]
    fn minimax_preview_alias_normalizes_to_ga_model() {
        assert_eq!(
            normalize_minimax_model_id("MiniMax-M3.1-Flash-Preview"),
            MINIMAX_M31_FLASH_MODEL
        );
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
            reasoning_content: None,
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
        let body = r#"{"error":{"message":"bad_request_error: invalid params, context window exceeds limit (2013)"}}"#;
        assert!(super::is_context_overflow_body(body));
        assert!(super::has_explicit_overflow_marker(body));
    }

    #[test]
    fn invalid_params_exceeds_limit_only_when_no_param_cap() {
        // Codex Round 1 #536: split parameter-cap errors from
        // context-overflow cases. /clear doesn't help when the
        // operator's MEMPHIS_GEN_MAX_TOKENS overshoots the server's
        // per-request output cap; that case must fall through to the
        // generic error path so the operator sees the real hint.
        let context_body = r#"{"error":{"code":40001,"message":"invalid params, exceeds limit"}}"#;
        assert!(
            super::has_explicit_overflow_marker(context_body),
            "generic invalid-params + exceeds-limit still treated as context overflow when no param-cap keywords",
        );

        let max_tokens_body =
            r#"{"error":{"code":40001,"message":"invalid params, max_tokens exceeds limit"}}"#;
        assert!(
            !super::has_explicit_overflow_marker(max_tokens_body),
            "max_tokens-cap rejection should NOT match overflow marker — operator needs provider hint, not /clear advice",
        );

        let output_tokens_body =
            r#"{"error":{"code":40001,"message":"invalid params: output_tokens exceeds limit"}}"#;
        assert!(
            !super::has_explicit_overflow_marker(output_tokens_body),
            "output_tokens-cap rejection should NOT match overflow marker",
        );

        let completion_tokens_body = r#"{"error":{"code":40001,"message":"invalid params, completion_tokens exceeds limit (4096)"}}"#;
        assert!(
            !super::has_explicit_overflow_marker(completion_tokens_body),
            "completion_tokens-cap rejection should NOT match overflow marker",
        );
    }
}
