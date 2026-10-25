//! Adapter to the shared Codex app-server client. Authentication remains owned
//! by Codex; Memphis never reads, copies, or passes its account tokens.

use std::{
    collections::HashMap,
    io::{BufRead, BufReader, Read, Write},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc::{self, RecvTimeoutError},
    },
    thread,
    time::{Duration, Instant},
};

use serde::Deserialize;
use serde_json::{json, Value};

use crate::{
    provider::{
        ChatCompletion, ChatMessage, ChatRequestOptions, ChatStreamEvent, ChatToolCall,
        ChatToolDefinition, TokenUsageSummary,
    },
    OperatorConfig, OperatorError,
};

const MAX_INPUT_BYTES: usize = 16 * 1024 * 1024;
const MAX_FRAME_BYTES: usize = 8 * 1024 * 1024;
const MAX_OUTPUT_BYTES: usize = 32 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS: u64 = 180_000;

// Only transport/configuration variables cross into the Codex child. In
// particular, the Memphis vault pepper, API tokens and provider keys do not.
const CHILD_ENV_KEYS: &[&str] = &[
    "PATH",
    "PATHEXT",
    "HOME",
    "USER",
    "LOGNAME",
    "USERPROFILE",
    "SYSTEMROOT",
    "APPDATA",
    "LOCALAPPDATA",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "XDG_RUNTIME_DIR",
    "DBUS_SESSION_BUS_ADDRESS",
    "XDG_CACHE_HOME",
    "TMPDIR",
    "TEMP",
    "TMP",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "NO_PROXY",
    "http_proxy",
    "https_proxy",
    "all_proxy",
    "no_proxy",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
    "NODE_EXTRA_CA_CERTS",
    "CODEX_HOME",
    "CODEX_BIN",
    "OPENAI_AUTH_MODE",
    "OPENAI_MODEL",
    "OPENAI_CODEX_TIMEOUT_MS",
];

#[derive(Clone)]
pub(crate) struct CodexBridge {
    runtime_root: PathBuf,
    bridge_path: PathBuf,
    child_env: HashMap<String, String>,
    timeout_ms: u64,
}

impl CodexBridge {
    pub(crate) fn from_config(config: &OperatorConfig) -> Result<Self, OperatorError> {
        if config.env("OPENAI_AUTH_MODE").unwrap_or("codex") != "codex" {
            return Err(error(
                "OpenAI provider requires OPENAI_AUTH_MODE=codex; run codex login for ChatGPT authentication",
            ));
        }
        let mut bridge = Self {
            runtime_root: config.runtime_root.clone(),
            bridge_path: config
                .runtime_root
                .join("dist/providers/openai-codex/bridge.js"),
            child_env: CHILD_ENV_KEYS
                .iter()
                .filter_map(|key| {
                    config
                        .raw_env
                        .get(*key)
                        .map(|value| ((*key).to_string(), value.clone()))
                })
                .collect(),
            timeout_ms: config
                .env("OPENAI_CODEX_TIMEOUT_MS")
                .and_then(|value| value.parse().ok())
                .unwrap_or(DEFAULT_TIMEOUT_MS)
                .clamp(1_000, 3_600_000),
        };
        // Resolve before Node switches to the private app-server cwd.
        let binary = bridge
            .child_env
            .get("CODEX_BIN")
            .map(String::as_str)
            .unwrap_or("codex");
        if let Some(path) = bridge.executable(binary) {
            bridge
                .child_env
                .insert("CODEX_BIN".into(), path.to_string_lossy().into_owned());
        }
        Ok(bridge)
    }

    /// Local readiness only. Codex verifies the logged-in account and model
    /// when a request starts; status refreshes must not make remote requests.
    pub(crate) fn check_availability(&self) -> Result<(), String> {
        if !self.bridge_path.is_file() {
            return Err("OpenAI Codex bridge is missing; build Memphis TypeScript first".into());
        }
        if self.executable(node_binary()).is_none() {
            return Err("OpenAI Codex bridge requires Node.js on PATH".into());
        }
        let codex_binary = self
            .child_env
            .get("CODEX_BIN")
            .map(String::as_str)
            .filter(|value| !value.trim().is_empty())
            .unwrap_or("codex");
        if self.executable(codex_binary).is_none() {
            return Err(
                "Codex CLI is unavailable; install Codex or set CODEX_BIN, then run codex login"
                    .into(),
            );
        }
        Ok(())
    }

    fn executable(&self, name: &str) -> Option<PathBuf> {
        let candidate = Path::new(name);
        if candidate.is_absolute() || candidate.components().count() > 1 {
            let path = if candidate.is_absolute() {
                candidate.to_path_buf()
            } else {
                self.runtime_root.join(candidate)
            };
            return executable_file(&path).then_some(path);
        }
        self.child_env.get("PATH").and_then(|path| {
            std::env::split_paths(path)
                .map(|directory| {
                    let directory = if directory.is_absolute() {
                        directory
                    } else {
                        self.runtime_root.join(directory)
                    };
                    directory.join(name)
                })
                .find(|path| executable_file(path))
        })
    }

    pub(crate) fn chat<F>(
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
        self.check_availability().map_err(error)?;
        let payload = serde_json::to_vec(&request_payload(
            messages,
            opts,
            tools,
            model,
            self.timeout_ms,
        ))
        .map_err(|_| error("failed to encode OpenAI Codex request"))?;
        if payload.len() > MAX_INPUT_BYTES {
            return Err(error(
                "OpenAI Codex request exceeded the bridge input limit",
            ));
        }
        let node = self
            .executable(node_binary())
            .ok_or_else(|| error("OpenAI Codex bridge requires Node.js on PATH"))?;
        let mut command = Command::new(node);
        command
            .arg(&self.bridge_path)
            .current_dir(&self.runtime_root)
            .env_clear()
            .envs(&self.child_env)
            .env("MEMPHIS_CODEX_BRIDGE", "1")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            // Child diagnostics may contain auth/provider details. The JSONL
            // protocol carries a fixed public error code instead.
            .stderr(Stdio::null());
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            command.process_group(0);
        }

        let deadline = Instant::now() + Duration::from_millis(self.timeout_ms);
        let mut child = ChildGuard(
            command
                .spawn()
                .map_err(|_| error("could not start OpenAI Codex bridge"))?,
        );
        let stdout = child
            .0
            .stdout
            .take()
            .ok_or_else(|| error("OpenAI Codex bridge has no output pipe"))?;
        let mut stdin = child
            .0
            .stdin
            .take()
            .ok_or_else(|| error("OpenAI Codex bridge has no input pipe"))?;
        let (sender, receiver) = mpsc::sync_channel(8);
        let input_sender = sender.clone();
        thread::spawn(move || {
            // Writing on a separate thread keeps cancellation/timeout effective
            // even when a failed child never consumes its input.
            if stdin
                .write_all(&payload)
                .and_then(|_| stdin.write_all(b"\n"))
                .is_err()
            {
                let _ = input_sender.send(PipeEvent::Failed);
            }
        });
        thread::spawn(move || read_frames(stdout, sender, MAX_FRAME_BYTES, MAX_OUTPUT_BYTES));

        let mut streamed = String::new();
        loop {
            ensure_not_cancelled(cancel_flag)?;
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Err(public_bridge_error("CODEX_TIMEOUT"));
            }
            let event = match receiver.recv_timeout(remaining.min(Duration::from_millis(25))) {
                Ok(event) => event,
                Err(RecvTimeoutError::Timeout) => continue,
                Err(RecvTimeoutError::Disconnected) => {
                    return Err(error(
                        "OpenAI Codex bridge ended without a completed response",
                    ));
                }
            };
            match event {
                PipeEvent::Frame(bytes) => {
                    let event: BridgeEvent = serde_json::from_slice(&bytes)
                        .map_err(|_| public_bridge_error("CODEX_PROTOCOL_ERROR"))?;
                    match event {
                        BridgeEvent::Text { text } => {
                            if streamed.len().saturating_add(text.len()) > MAX_OUTPUT_BYTES {
                                return Err(public_bridge_error("CODEX_OUTPUT_LIMIT"));
                            }
                            streamed.push_str(&text);
                            if !text.is_empty() {
                                on_event(ChatStreamEvent::Text(text));
                            }
                        }
                        BridgeEvent::Done { response } => {
                            let expected_model = resolve_codex_model_slug(model);
                            if response.provider != "openai"
                                || response.model != expected_model
                                || response.tool_calls.iter().any(|call| {
                                    call.id.trim().is_empty()
                                        || !tools.iter().any(|tool| tool.name == call.name)
                                        || !call.arguments.is_object()
                                })
                                || (!streamed.is_empty() && streamed != response.content)
                            {
                                return Err(public_bridge_error("CODEX_PROTOCOL_ERROR"));
                            }
                            if streamed.is_empty() && !response.content.is_empty() {
                                on_event(ChatStreamEvent::Text(response.content.clone()));
                            }
                            let token_usage = response.tokens.map(|tokens| TokenUsageSummary {
                                prompt_tokens: tokens.prompt,
                                completion_tokens: tokens.completion,
                                total_tokens: tokens.total,
                                estimated: false,
                            });
                            if let Some(usage) = &token_usage {
                                on_event(ChatStreamEvent::Usage(usage.clone()));
                            }
                            return Ok(ChatCompletion {
                                content: response.content,
                                reasoning_content: None,
                                model: response.model,
                                provider: "openai".into(),
                                tool_calls: response.tool_calls,
                                token_usage,
                                effective_context_window: response.effective_context_window,
                            });
                        }
                        BridgeEvent::Error { error } => {
                            return Err(public_bridge_error(&error.code));
                        }
                    }
                }
                PipeEvent::Limit => return Err(public_bridge_error("CODEX_OUTPUT_LIMIT")),
                PipeEvent::Failed => {
                    return Err(error("OpenAI Codex bridge connection failed"));
                }
                PipeEvent::End => {
                    return Err(error(
                        "OpenAI Codex bridge ended without a completed response",
                    ));
                }
            }
        }
    }
}

fn node_binary() -> &'static str {
    if cfg!(windows) {
        "node.exe"
    } else {
        "node"
    }
}

fn executable_file(path: &Path) -> bool {
    let Ok(metadata) = path.metadata() else {
        return false;
    };
    if !metadata.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        metadata.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        true
    }
}

/// Reap the bridge on every path, including successful tool-call handoff.
/// On Unix Codex belongs to the same new process group, so a timed-out or
/// cancelled request cannot leave the model/tool process running.
struct ChildGuard(Child);

impl Drop for ChildGuard {
    fn drop(&mut self) {
        #[cfg(unix)]
        if let Ok(pid) = i32::try_from(self.0.id()) {
            // SAFETY: CommandExt::process_group(0) created this child-owned
            // group. The child has not been reaped, so the PID cannot be reused.
            unsafe {
                libc::kill(-pid, libc::SIGKILL);
            }
        }
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

enum PipeEvent {
    Frame(Vec<u8>),
    Failed,
    Limit,
    End,
}

fn read_frames(
    reader: impl Read,
    sender: mpsc::SyncSender<PipeEvent>,
    max_frame: usize,
    max_total: usize,
) {
    let mut reader = BufReader::new(reader);
    let mut total = 0usize;
    loop {
        let mut frame = Vec::new();
        let result = reader
            .by_ref()
            .take((max_frame + 1) as u64)
            .read_until(b'\n', &mut frame);
        match result {
            Ok(0) => {
                let _ = sender.send(PipeEvent::End);
                return;
            }
            Ok(read) => {
                total = total.saturating_add(read);
                if frame.len() > max_frame || total > max_total {
                    let _ = sender.send(PipeEvent::Limit);
                    return;
                }
                if sender.send(PipeEvent::Frame(frame)).is_err() {
                    return;
                }
            }
            Err(_) => {
                let _ = sender.send(PipeEvent::Failed);
                return;
            }
        }
    }
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
enum BridgeEvent {
    Text { text: String },
    Done { response: BridgeResponse },
    Error { error: BridgeError },
}

#[derive(Deserialize)]
struct BridgeResponse {
    content: String,
    model: String,
    provider: String,
    #[serde(default)]
    tool_calls: Vec<ChatToolCall>,
    tokens: Option<BridgeTokens>,
    /// Account-granted context window, absent when the account did not report
    /// a stricter limit than the model declares. The wire name is camelCase;
    /// serde maps it explicitly so the field keeps Rust naming conventions.
    #[serde(default, rename = "effectiveContextWindow")]
    effective_context_window: Option<u64>,
}

#[derive(Deserialize)]
struct BridgeTokens {
    prompt: u32,
    completion: u32,
    total: u32,
}

#[derive(Deserialize)]
struct BridgeError {
    code: String,
}

fn request_payload(
    messages: &[ChatMessage],
    opts: &ChatRequestOptions,
    tools: &[ChatToolDefinition],
    model: &str,
    timeout_ms: u64,
) -> Value {
    let messages: Vec<Value> = messages
        .iter()
        .map(|message| match message {
            ChatMessage::System { content } => json!({"role":"system", "content":content}),
            ChatMessage::User { content } => json!({"role":"user", "content":content}),
            ChatMessage::Assistant {
                content,
                tool_calls,
                ..
            } => json!({"role":"assistant", "content":content, "tool_calls":tool_calls}),
            ChatMessage::Tool {
                tool_call_id,
                content,
            } => json!({"role":"tool", "content":content, "tool_call_id":tool_call_id}),
        })
        .collect();
    let tools: Vec<Value> = tools
        .iter()
        .map(|tool| {
            json!({
                "name":tool.name,
                "description":tool.description,
                "inputSchema":tool.input_schema,
            })
        })
        .collect();
    json!({
        "messages":messages,
        "model":model,
        "systemPrompt":opts.system_prompt,
        "tools":tools,
        "timeoutMs":timeout_ms,
    })
}

/// Canonical Codex model id for a Memphis preset — the slug the account
/// catalog records. Mirrors `resolveCodexModel` in the TypeScript client, so
/// both surfaces read the same catalog entry.
pub(crate) fn resolve_codex_model_slug(model: &str) -> &str {
    let normalized = model.trim();
    if matches!(
        normalized.to_ascii_lowercase().as_str(),
        "astra-gtp6-max" | "astra-gpt6-max" | "gpt-6-astra-max"
    ) {
        return "gpt-6-astra";
    }
    if normalized.eq_ignore_ascii_case("gpt-5.6-sol-max")
        || normalized.eq_ignore_ascii_case("gpt-5.6-sol max")
        || normalized.eq_ignore_ascii_case("gpt-5.6-sol")
    {
        return "gpt-5.6-sol";
    }
    normalized
}

/// Context window the logged-in account is granted, read from the Codex model
/// catalog the CLI keeps under CODEX_HOME.
///
/// The catalog is account-specific and records both the granted pool and the
/// share of it the model may actually use. The server also reports the
/// effective value with every turn, but only after that turn has been sent —
/// reading it here lets Memphis trim the FIRST request of a conversation
/// instead of the second. A missing or unreadable catalog is not an error:
/// the declared window still applies.
pub(crate) fn read_account_context_window(config: &OperatorConfig, model: &str) -> Option<u64> {
    let codex_home = config.env("CODEX_HOME").map(PathBuf::from).or_else(|| {
        config
            .env("HOME")
            .map(|home| PathBuf::from(home).join(".codex"))
    })?;
    let raw = std::fs::read_to_string(codex_home.join("models_cache.json")).ok()?;
    let parsed: Value = serde_json::from_str(&raw).ok()?;
    let models = parsed.get("models")?.as_array()?;
    let slug = resolve_codex_model_slug(model);
    for entry in models {
        let Some(record) = entry.as_object() else {
            continue;
        };
        if record.get("slug").and_then(Value::as_str) != Some(slug) {
            continue;
        }
        let Some(pool) = record.get("context_window").and_then(Value::as_u64) else {
            return None;
        };
        if pool == 0 {
            return None;
        }
        let share = record
            .get("effective_context_window_percent")
            .and_then(Value::as_f64)
            .filter(|percent| percent.is_finite() && *percent > 0.0)
            .map(|percent| percent / 100.0)
            .unwrap_or(1.0);
        let effective = ((pool as f64) * share).floor() as u64;
        return if effective > 0 { Some(effective) } else { None };
    }
    None
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

fn error(message: impl Into<String>) -> OperatorError {
    OperatorError::Message(message.into())
}

fn public_bridge_error(code: &str) -> OperatorError {
    match code {
        "CODEX_CANCELLED" => OperatorError::Cancelled,
        "CODEX_NOT_AUTHENTICATED" => {
            error("OpenAI Codex account is not authenticated; run codex login and retry")
        }
        "CODEX_BINARY_UNAVAILABLE" => {
            error("Codex CLI is unavailable; install Codex or set CODEX_BIN")
        }
        "CODEX_MODEL_UNAVAILABLE" => {
            error("the requested OpenAI model is unavailable for the logged-in Codex account")
        }
        "CODEX_TIMEOUT" => {
            error("OpenAI Codex request timed out; retry or raise OPENAI_CODEX_TIMEOUT_MS")
        }
        "CODEX_OUTPUT_LIMIT" => error("OpenAI Codex response exceeded the bridge output limit"),
        "CODEX_PROTOCOL_ERROR" => error("OpenAI Codex bridge returned an invalid response"),
        _ => error("OpenAI Codex request failed; check Codex login and account limits"),
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::{fs, sync::atomic::AtomicUsize};

    static NEXT_ID: AtomicUsize = AtomicUsize::new(0);
    struct Fixture {
        root: PathBuf,
        bridge: CodexBridge,
    }
    impl Fixture {
        fn new(body: &str) -> Self {
            let root = std::env::temp_dir().join(format!(
                "memphis-native-codex-{}-{}",
                std::process::id(),
                NEXT_ID.fetch_add(1, Ordering::SeqCst)
            ));
            fs::create_dir_all(root.join("dist/providers/openai-codex")).unwrap();
            let config = OperatorConfig::from_iter([
                ("MEMPHIS_RUNTIME_ROOT", root.to_string_lossy().into_owned()),
                ("PATH", std::env::var("PATH").unwrap()),
                ("CODEX_BIN", "node".into()),
                ("HOME", root.to_string_lossy().into_owned()),
                ("OPENAI_API_KEY", "synthetic-private-key".into()),
                ("MEMPHIS_VAULT_PEPPER", "synthetic-private-pepper".into()),
            ]);
            let bridge = CodexBridge::from_config(&config).unwrap();
            // The bridge fixture is local only and never invokes Codex/network.
            fs::write(&bridge.bridge_path, format!(
                "let input='';process.stdin.on('data',b=>input+=b);process.stdin.on('end',()=>{{const request=JSON.parse(input);const emit=x=>process.stdout.write(JSON.stringify(x)+'\\n');{body}}});"
            )).unwrap();
            Self { root, bridge }
        }
        fn chat(&self) -> Result<ChatCompletion, OperatorError> {
            self.bridge.chat(
                &[ChatMessage::User {
                    content: "synthetic question".into(),
                }],
                &ChatRequestOptions::default(),
                &[],
                "astra-gtp6-max",
                None,
                |_| {},
            )
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    #[test]
    fn codex_native_stream_and_request_preserve_contract_without_secrets() {
        let fixture = Fixture::new(
            r#"
            if(process.env.OPENAI_API_KEY || process.env.MEMPHIS_VAULT_PEPPER) process.exit(91);
            if(request.model!=='astra-gtp6-max' || request.messages[0].content!=='synthetic question') process.exit(92);
            emit({type:'text',text:'fixture answer'});
            emit({type:'done',response:{provider:'openai',model:'gpt-6-astra',content:'fixture answer',tokens:{prompt:10,completion:5,total:15}}});
        "#,
        );
        let mut events = Vec::new();
        let completion = fixture
            .bridge
            .chat(
                &[ChatMessage::User {
                    content: "synthetic question".into(),
                }],
                &ChatRequestOptions::default(),
                &[],
                "astra-gtp6-max",
                None,
                |event| events.push(event),
            )
            .unwrap();
        assert_eq!(completion.content, "fixture answer");
        assert_eq!(completion.model, "gpt-6-astra");
        assert_eq!(completion.token_usage.unwrap().total_tokens, 15);
        assert_eq!(events.len(), 2);
    }

    #[test]
    fn codex_native_accepts_gpt_56_sol_max_canonical_response() {
        let fixture = Fixture::new(
            r#"emit({type:'done',response:{provider:'openai',model:'gpt-5.6-sol',content:'fixture answer'}});"#,
        );
        let completion = fixture
            .bridge
            .chat(
                &[ChatMessage::User {
                    content: "synthetic question".into(),
                }],
                &ChatRequestOptions::default(),
                &[],
                "gpt-5.6-sol-max",
                None,
                |_| {},
            )
            .unwrap();
        assert_eq!(completion.model, "gpt-5.6-sol");
        assert_eq!(completion.content, "fixture answer");
    }

    #[test]
    fn codex_native_surfaces_account_context_window() {
        // The bridge reports the account limit; the native path must forward it
        // so the TUI reads the same ceiling the account enforces.
        let fixture = Fixture::new(
            r#"emit({type:'done',response:{provider:'openai',model:'gpt-6-astra',content:'fixture answer',tokens:{prompt:10,completion:5,total:15},effectiveContextWindow:272000}});"#,
        );
        let completion = fixture
            .bridge
            .chat(
                &[ChatMessage::User {
                    content: "synthetic question".into(),
                }],
                &ChatRequestOptions::default(),
                &[],
                "astra-gtp6-max",
                None,
                |_| {},
            )
            .unwrap();
        assert_eq!(completion.effective_context_window, Some(272_000));
    }

    #[test]
    fn codex_native_omits_context_window_when_account_does_not_report_one() {
        let fixture = Fixture::new(
            r#"emit({type:'done',response:{provider:'openai',model:'gpt-6-astra',content:'fixture answer',tokens:{prompt:10,completion:5,total:15}}});"#,
        );
        let completion = fixture
            .bridge
            .chat(
                &[ChatMessage::User {
                    content: "synthetic question".into(),
                }],
                &ChatRequestOptions::default(),
                &[],
                "astra-gtp6-max",
                None,
                |_| {},
            )
            .unwrap();
        assert_eq!(completion.effective_context_window, None);
    }

    #[test]
    fn codex_native_hands_registered_tool_back_to_memphis() {
        let fixture = Fixture::new(
            r#"emit({type:'done',response:{provider:'openai',model:'gpt-6-astra',content:'',tool_calls:[{id:'call-1',name:'memphis_recall',arguments:{query:'fixture'}}]}});"#,
        );
        let tool: ChatToolDefinition = serde_json::from_value(json!({"name":"memphis_recall", "description":"memory", "input_schema":{"type":"object"}})).unwrap();
        let result = fixture
            .bridge
            .chat(
                &[],
                &ChatRequestOptions::default(),
                &[tool],
                "astra-gtp6-max",
                None,
                |_| {},
            )
            .unwrap();
        assert_eq!(result.tool_calls[0].name, "memphis_recall");
    }

    #[test]
    fn codex_native_rejects_substitution_unknown_tools_and_partial_output() {
        for body in [
            r#"emit({type:'done',response:{provider:'openai',model:'another-model',content:'wrong'}});"#,
            r#"emit({type:'done',response:{provider:'openai',model:'gpt-6-astra',content:'',tool_calls:[{id:'x',name:'unknown',arguments:{}}]}});"#,
            r#"emit({type:'text',text:'partial'});"#,
            r#"emit({type:'text',text:'partial'});emit({type:'done',response:{provider:'openai',model:'gpt-6-astra',content:'different'}});"#,
        ] {
            assert!(Fixture::new(body).chat().is_err());
        }
    }

    #[test]
    fn codex_native_errors_do_not_publish_child_diagnostics() {
        let fixture = Fixture::new(
            r#"console.error('synthetic-private-detail');emit({type:'error',error:{code:'unknown synthetic-private-detail',message:'synthetic-private-detail'}});"#,
        );
        let error = fixture.chat().unwrap_err().to_string();
        assert!(!error.contains("synthetic-private-detail"));
        assert!(error.contains("account limits"));
    }

    #[test]
    fn codex_native_timeout_kills_unresponsive_bridge() {
        let mut fixture = Fixture::new("setInterval(()=>{},1000);");
        fixture.bridge.timeout_ms = 150;
        let start = Instant::now();
        assert!(fixture
            .chat()
            .unwrap_err()
            .to_string()
            .contains("timed out"));
        assert!(start.elapsed() < Duration::from_secs(3));
    }

    #[test]
    fn codex_native_cancels_active_bridge() {
        let fixture = Fixture::new("setInterval(()=>{},1000);");
        let cancelled = AtomicBool::new(false);
        thread::scope(|scope| {
            scope.spawn(|| {
                thread::sleep(Duration::from_millis(100));
                cancelled.store(true, Ordering::Relaxed);
            });
            let result = fixture.bridge.chat(
                &[],
                &ChatRequestOptions::default(),
                &[],
                "astra-gtp6-max",
                Some(&cancelled),
                |_| {},
            );
            assert!(matches!(result, Err(OperatorError::Cancelled)));
        });
    }

    #[test]
    fn codex_native_frame_reader_bounds_unterminated_output() {
        let (sender, receiver) = mpsc::sync_channel(8);
        read_frames(&b"123456789"[..], sender, 4, 16);
        assert!(matches!(receiver.recv().unwrap(), PipeEvent::Limit));
    }

    #[test]
    fn codex_account_context_window_reads_the_local_catalog() {
        let root = std::env::temp_dir().join(format!(
            "memphis-native-codex-catalog-{}-{}",
            std::process::id(),
            NEXT_ID.fetch_add(1, Ordering::SeqCst)
        ));
        fs::create_dir_all(&root).unwrap();
        fs::write(
            root.join("models_cache.json"),
            r#"{"models":[{"slug":"gpt-6-astra","context_window":272000,"effective_context_window_percent":95}]}"#,
        )
        .unwrap();
        let config = OperatorConfig::from_iter([
            ("MEMPHIS_RUNTIME_ROOT", root.to_string_lossy().into_owned()),
            ("CODEX_HOME", root.to_string_lossy().into_owned()),
            ("HOME", root.to_string_lossy().into_owned()),
        ]);
        // 272000 granted pool * 95% share = 258400 usable tokens.
        assert_eq!(
            read_account_context_window(&config, "astra-gtp6-max"),
            Some(258_400)
        );
        assert_eq!(
            read_account_context_window(&config, "gpt-6-astra"),
            Some(258_400)
        );
        assert_eq!(read_account_context_window(&config, "unknown-model"), None);
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn codex_account_context_window_is_absent_without_a_catalog() {
        let root = std::env::temp_dir().join(format!(
            "memphis-native-codex-empty-{}-{}",
            std::process::id(),
            NEXT_ID.fetch_add(1, Ordering::SeqCst)
        ));
        fs::create_dir_all(&root).unwrap();
        let config = OperatorConfig::from_iter([
            ("MEMPHIS_RUNTIME_ROOT", root.to_string_lossy().into_owned()),
            ("HOME", root.to_string_lossy().into_owned()),
        ]);
        assert_eq!(read_account_context_window(&config, "gpt-6-astra"), None);
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn codex_model_slug_resolves_memphis_presets() {
        assert_eq!(resolve_codex_model_slug("astra-gtp6-max"), "gpt-6-astra");
        assert_eq!(resolve_codex_model_slug("ASTRA-GTP6-MAX"), "gpt-6-astra");
        assert_eq!(resolve_codex_model_slug("gpt-6-astra-max"), "gpt-6-astra");
        assert_eq!(resolve_codex_model_slug("gpt-5.6-sol-max"), "gpt-5.6-sol");
        assert_eq!(resolve_codex_model_slug("gpt-5.6-sol max"), "gpt-5.6-sol");
        assert_eq!(resolve_codex_model_slug("gpt-6-astra"), "gpt-6-astra");
        assert_eq!(resolve_codex_model_slug("custom-model"), "custom-model");
    }
}
