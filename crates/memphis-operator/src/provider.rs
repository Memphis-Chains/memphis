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

use crate::{OperatorConfig, OperatorError};

/// Sanitize a string for JSON serialization.
/// JSON only supports \\uXXXX and \\\\ escapes. Invalid \\xNN (1-digit hex) or
/// incomplete \\x escapes must be converted/removed or serde_json will produce
/// invalid JSON that DeepSeek and other providers reject.
fn sanitize_for_json(content: &str) -> String {
    let mut result = String::with_capacity(content.len());
    let bytes = content.as_bytes();
    let mut i = 0;

    while i < bytes.len() {
        let b = bytes[i];
        if b == b'\\' && i + 1 < bytes.len() {
            let next = bytes[i + 1];
            if next == b'\\' {
                // Double backslash \\ -> keep as \\
                result.push_str("\\\\");
                i += 2;
            } else if next == b'u' {
                // Valid \\uXXXX - keep it
                if i + 5 < bytes.len() && bytes[i + 2..i + 6].iter().all(|c| c.is_ascii_hexdigit()) {
                    result.push_str(&content[i..i + 6]);
                    i += 6;
                } else {
                    // Invalid \\u without 4 hex digits - replace with unicode replacement
                    result.push('\u{FFFD}');
                    i += 2;
                }
            } else if next.is_ascii_hexdigit() {
                // Could be \\xNN (2-digit hex) or \\xN (1-digit hex)
                let mut hex_len = 0;
                let mut j = i + 2;
                while j < bytes.len() && bytes[j].is_ascii_hexdigit() && hex_len < 2 {
                    hex_len += 1;
                    j += 1;
                }
                if hex_len == 2 {
                    // Valid \\xNN - convert to \\u00NN
                    result.push_str("\\u00");
                    result.push(bytes[i + 2] as char);
                    result.push(bytes[i + 3] as char);
                    i += 4;
                } else if hex_len == 1 {
                    // Invalid \\xN (1-digit hex) - replace with unicode replacement
                    result.push('\u{FFFD}');
                    i += 3;
                } else {
                    // Incomplete \\x at end of string - replace with unicode replacement
                    result.push('\u{FFFD}');
                    i += 1;
                }
            } else {
                // Unknown escape like \n \t \" - keep as-is (serde handles these)
                result.push(b as char);
                i += 1;
            }
        } else if b < 0x20 || b == 0x7F {
            // Control characters - skip tabs, newlines, carriage returns only
            if b == 0x09 || b == 0x0A || b == 0x0D {
                result.push(b as char);
            }
            i += 1;
        } else {
            result.push(b as char);
            i += 1;
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
}

#[derive(Debug, Clone)]
pub struct ProviderRuntime {
    kind: ProviderKind,
    name: String,
    base_url: Option<String>,
    api_key: Option<String>,
    default_model: String,
    timeout_ms: u64,
}

impl ProviderRuntime {
    pub fn default_model(&self) -> &str {
        self.default_model.as_str()
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
                let content = format!("Fallback response: {input}");
                let token_usage = estimated_text_usage(input.as_str(), content.as_str());
                on_event(ChatStreamEvent::Usage(token_usage.clone()));
                emit_text_chunks(
                    content.as_str(),
                    cancel_flag,
                    Some(Duration::from_millis(50)),
                    &mut on_event,
                )?;
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
        let api_key = self.api_key.as_deref().ok_or_else(|| {
            OperatorError::Message(format!("provider {} missing api key", self.name))
        })?;
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
            .map(message_to_provider_json)
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
                Some(estimated_chat_usage(messages, opts, tools, message
                    .get("content")
                    .and_then(Value::as_str)
                    .unwrap_or_default()))
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
            .map(message_to_provider_json)
            .collect::<Vec<_>>();
        let all_messages = if let Some(system_prompt) = opts.system_prompt.as_deref() {
            let mut combined = vec![json!({ "role": "system", "content": system_prompt })];
            combined.extend(ollama_messages);
            combined
        } else {
            ollama_messages
        };

        let response = post_response(
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

        let token_usage =
            token_usage.or_else(|| Some(estimated_chat_usage(messages, opts, tools, content.as_str())));
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
        let api_key = self.api_key.as_deref().ok_or_else(|| {
            OperatorError::Message(format!("provider {} missing api key", self.name))
        })?;
        let provider_messages = messages
            .iter()
            .map(message_to_provider_json)
            .collect::<Vec<_>>();
        let all_messages = if let Some(system_prompt) = opts.system_prompt.as_deref() {
            let mut combined = vec![json!({ "role": "system", "content": sanitize_for_json(system_prompt) })];
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
                Some(estimated_chat_usage(messages, opts, tools, message
                    .get("content")
                    .and_then(Value::as_str)
                    .unwrap_or_default()))
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
        let api_key = self.api_key.as_deref().ok_or_else(|| {
            OperatorError::Message(format!("provider {} missing api key", self.name))
        })?;
        let provider_messages = messages
            .iter()
            .map(message_to_provider_json)
            .collect::<Vec<_>>();
        let all_messages = if let Some(system_prompt) = opts.system_prompt.as_deref() {
            let mut combined = vec![json!({ "role": "system", "content": sanitize_for_json(system_prompt) })];
            combined.extend(provider_messages);
            combined
        } else {
            provider_messages
        };

        let response = post_response(
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
                let preview = if data.len() > 100 { format!("{}...", &data[..100]) } else { data.to_string() };
                OperatorError::Message(format!("invalid provider stream payload: {} | data: {}", error, preview))
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

        let token_usage =
            token_usage.or_else(|| Some(estimated_chat_usage(messages, opts, tools, content.as_str())));
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

    fn is_configured(&self) -> bool {
        match self.kind {
            ProviderKind::LocalFallback | ProviderKind::Ollama => true,
            _ => self
                .api_key
                .as_deref()
                .map(|value| !value.trim().is_empty())
                .unwrap_or(false),
        }
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
    if model.contains("m2") {
        32_000
    } else {
        16_384
    }
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
            default_model: "local-fallback-v0".to_string(),
            timeout_ms,
        }),
        "shared-llm" => Ok(ProviderRuntime {
            kind: ProviderKind::SharedLlm,
            name: "shared-llm".to_string(),
            base_url: config.env("SHARED_LLM_API_BASE").map(ToString::to_string),
            api_key: config.env("SHARED_LLM_API_KEY").map(ToString::to_string),
            default_model: config
                .env("SHARED_LLM_MODEL")
                .or_else(|| config.env("OPENAI_COMPATIBLE_MODEL"))
                .unwrap_or("shared-llm")
                .to_string(),
            timeout_ms,
        }),
        "decentralized-llm" => Ok(ProviderRuntime {
            kind: ProviderKind::DecentralizedLlm,
            name: "decentralized-llm".to_string(),
            base_url: config
                .env("DECENTRALIZED_LLM_API_BASE")
                .map(ToString::to_string),
            api_key: config
                .env("DECENTRALIZED_LLM_API_KEY")
                .map(ToString::to_string),
            default_model: config
                .env("DECENTRALIZED_LLM_MODEL")
                .unwrap_or("decentralized-llm")
                .to_string(),
            timeout_ms,
        }),
        "ollama" => Ok(ProviderRuntime {
            kind: ProviderKind::Ollama,
            name: "ollama".to_string(),
            base_url: config
                .env("OLLAMA_URL")
                .map(ToString::to_string)
                .or_else(|| Some("http://127.0.0.1:11434".to_string())),
            api_key: None,
            default_model: config
                .env("OLLAMA_MODEL")
                .unwrap_or("qwen2.5-coder:3b")
                .to_string(),
            timeout_ms,
        }),
        "minimax" => Ok(ProviderRuntime {
            kind: ProviderKind::Minimax,
            name: "minimax".to_string(),
            base_url: config
                .env("MINIMAX_BASE_URL")
                .map(ToString::to_string)
                .or_else(|| Some("https://api.minimax.io/v1".to_string())),
            api_key: config.env("MINIMAX_API_KEY").map(ToString::to_string),
            default_model: config
                .env("MINIMAX_MODEL")
                .unwrap_or("MiniMax-M2.7")
                .to_string(),
            timeout_ms,
        }),
        "deepseek" => Ok(ProviderRuntime {
            kind: ProviderKind::Deepseek,
            name: "deepseek".to_string(),
            base_url: config
                .env("DEEPSEEK_API_BASE")
                .map(ToString::to_string)
                .or_else(|| Some("https://api.deepseek.com".to_string())),
            api_key: config.env("DEEPSEEK_API_KEY").map(ToString::to_string),
            default_model: config
                .env("DEEPSEEK_MODEL")
                .unwrap_or("deepseek-chat")
                .to_string(),
            timeout_ms,
        }),
        "glm" => Ok(ProviderRuntime {
            kind: ProviderKind::Glm,
            name: "glm".to_string(),
            base_url: config
                .env("GLM_BASE_URL")
                .map(ToString::to_string)
                .or_else(|| Some("https://open.bigmodel.cn/api/paas/v4".to_string())),
            api_key: config.env("GLM_API_KEY").map(ToString::to_string),
            default_model: config.env("GLM_MODEL").unwrap_or("glm-4-flash").to_string(),
            timeout_ms,
        }),
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
    match message {
        ChatMessage::System { content } => json!({ "role": "system", "content": sanitize_for_json(content) }),
        ChatMessage::User { content } => json!({ "role": "user", "content": sanitize_for_json(content) }),
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
                        .map(|call| json!({
                            "id": call.id,
                            "type": "function",
                            "function": {
                                "name": call.name,
                                "arguments": serde_json::to_string(&call.arguments).unwrap_or_else(|_| "{}".to_string()),
                            }
                        }))
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

fn parse_generate_provider_response(body: Value, model: &str, provider_name: &str) -> ChatCompletion {
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
fn run_blocking_with_cancel<T, F>(
    cancel_flag: &AtomicBool,
    work: F,
) -> Result<T, OperatorError>
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
    let mut request = ureq::post(url)
        .timeout(Duration::from_millis(timeout_ms))
        .set("Content-Type", "application/json");
    if let Some(token) = bearer_token {
        request = request.set("Authorization", &format!("Bearer {token}"));
    }
    for (key, value) in extra_headers {
        request = request.set(key, value);
    }
    request
        .send_json(payload)
        .map_err(|error| OperatorError::Message(format!("provider request failed: {error}")))
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
        io::{Read, Write},
        net::TcpListener,
        sync::{
            atomic::{AtomicBool, Ordering},
            Arc,
        },
        time::{Duration, Instant},
    };

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
        ]);

        for name in [
            "local-fallback",
            "ollama",
            "shared-llm",
            "decentralized-llm",
            "minimax",
            "deepseek",
            "glm",
        ] {
            let runtime = resolve_provider(&config, Some(name)).expect("provider runtime");
            assert_eq!(runtime.name, name);
            assert!(!runtime.default_model().trim().is_empty());
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
}
