use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::{OperatorConfig, OperatorError};

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
}

#[derive(Debug, Clone)]
pub struct ProviderStatus {
    pub name: String,
    pub configured: bool,
    pub available: bool,
    pub default_model: String,
    pub models: Vec<String>,
    pub error: Option<String>,
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
        ProviderStatus {
            name: self.name.clone(),
            configured,
            available: availability.is_ok(),
            default_model: self.default_model.clone(),
            models: self.list_models(),
            error: availability.err(),
        }
    }

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
                Ok(ChatCompletion {
                    content: format!("Fallback response: {input}"),
                    model: model.to_string(),
                    provider: self.name.clone(),
                    tool_calls: Vec::new(),
                })
            }
            ProviderKind::SharedLlm | ProviderKind::DecentralizedLlm => {
                let base_url = self.base_url.as_deref().ok_or_else(|| {
                    OperatorError::Message(format!("provider {} missing base url", self.name))
                })?;
                let api_key = self.api_key.as_deref().ok_or_else(|| {
                    OperatorError::Message(format!("provider {} missing api key", self.name))
                })?;
                let payload = json!({
                    "input": build_generate_input_from_chat(messages, opts, tools),
                    "model": model,
                    "options": {
                        "temperature": opts.temperature.unwrap_or(0.7),
                        "maxTokens": opts.max_tokens.unwrap_or(2048),
                        "timeoutMs": self.timeout_ms,
                    }
                });
                let body = post_json(
                    format!("{}/v1/generate", base_url.trim_end_matches('/')).as_str(),
                    payload,
                    Some(api_key),
                    self.timeout_ms,
                    &[],
                )?;
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
                Ok(ChatCompletion {
                    content: output,
                    model: resolved_model,
                    provider: self.name.clone(),
                    tool_calls: Vec::new(),
                })
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
        })
    }

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
            let mut combined = vec![json!({ "role": "system", "content": system_prompt })];
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
        ChatMessage::System { content } => json!({ "role": "system", "content": content }),
        ChatMessage::User { content } => json!({ "role": "user", "content": content }),
        ChatMessage::Assistant {
            content,
            tool_calls,
        } => {
            if tool_calls.is_empty() {
                json!({ "role": "assistant", "content": content })
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
            "content": content,
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

fn post_json(
    url: &str,
    payload: Value,
    bearer_token: Option<&str>,
    timeout_ms: u64,
    extra_headers: &[(&str, &str)],
) -> Result<Value, OperatorError> {
    let mut request = ureq::post(url)
        .timeout(Duration::from_millis(timeout_ms))
        .set("Content-Type", "application/json");
    if let Some(token) = bearer_token {
        request = request.set("Authorization", &format!("Bearer {token}"));
    }
    for (key, value) in extra_headers {
        request = request.set(key, value);
    }
    let response = request
        .send_json(payload)
        .map_err(|error| OperatorError::Message(format!("provider request failed: {error}")))?;
    response
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
}
