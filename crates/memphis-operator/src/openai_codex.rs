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
        Mutex, OnceLock,
    },
    thread,
    time::{Duration, Instant, SystemTime},
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

/// One model the logged-in ChatGPT account may use, as recorded in the account
/// catalog the Codex CLI keeps under CODEX_HOME.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct CodexAccountModel {
    /// Official model id, e.g. `gpt-6.1-sol`.
    pub(crate) slug: String,
    /// Human-readable name from the catalog.
    pub(crate) display_name: String,
    /// Context window the account was granted for this model, if any.
    pub(crate) account_context_window: Option<u64>,
    /// False for models the CLI keeps out of its own picker.
    pub(crate) visible: bool,
}

/// Cached catalog read: (path, size, mtime, models).
type CatalogCache = (PathBuf, u64, u64, Vec<CodexAccountModel>);

fn catalog_cache() -> &'static Mutex<Option<CatalogCache>> {
    static CACHE: OnceLock<Mutex<Option<CatalogCache>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(None))
}

/// Lock the catalog cache, recovering from a poisoned lock: a panic in one
/// reader must not turn every later catalog read into a panic.
fn lock_catalog_cache() -> std::sync::MutexGuard<'static, Option<CatalogCache>> {
    match catalog_cache().lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    }
}

/// The account's Codex model catalog: which models this workspace may use and
/// how much context each one gets.
///
/// The catalog is account-specific and maintained by the Codex CLI itself, so
/// it is the only place that knows about models released after Memphis was
/// built. It is cached on the file's (size, mtime) so a CLI refresh is picked
/// up without re-reading the catalog on every call. A missing or unreadable
/// catalog is not an error: callers fall back to the documented API ceiling.
pub(crate) fn read_account_model_catalog(
    config: &OperatorConfig,
) -> Option<Vec<CodexAccountModel>> {
    read_account_model_catalog_at(&codex_home_dir(config)?)
}

/// The Codex home directory the CLI keeps its account catalog in.
fn codex_home_dir(config: &OperatorConfig) -> Option<PathBuf> {
    config.env("CODEX_HOME").map(PathBuf::from).or_else(|| {
        config
            .env("HOME")
            .map(|home| PathBuf::from(home).join(".codex"))
    })
}

/// Catalog read for a known Codex home. Every caller goes through this one
/// function, so the model list and the context window can never disagree.
fn read_account_model_catalog_at(codex_home: &Path) -> Option<Vec<CodexAccountModel>> {
    let path = codex_home.join("models_cache.json");
    let metadata = std::fs::metadata(&path).ok()?;
    let size = metadata.len();
    let modified = metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(SystemTime::UNIX_EPOCH).ok())
        .map(|delta| delta.as_nanos() as u64)
        .unwrap_or(0);
    {
        let cache = lock_catalog_cache();
        if let Some((cached_path, cached_size, cached_modified, models)) = cache.as_ref() {
            if cached_path == &path && *cached_size == size && *cached_modified == modified {
                return Some(models.clone());
            }
        }
    }
    let raw = std::fs::read_to_string(&path).ok()?;
    let parsed: Value = serde_json::from_str(&raw).ok()?;
    let entries = parsed.get("models")?.as_array()?;
    let models: Vec<CodexAccountModel> = entries
        .iter()
        .filter_map(|entry| {
            let record = entry.as_object()?;
            let slug = record.get("slug").and_then(Value::as_str)?.trim().to_string();
            if slug.is_empty() {
                return None;
            }
            let pool = record
                .get("context_window")
                .and_then(Value::as_u64)
                .filter(|pool| *pool > 0);
            let share = record
                .get("effective_context_window_percent")
                .and_then(Value::as_f64)
                .filter(|percent| percent.is_finite() && *percent > 0.0)
                .map(|percent| percent / 100.0)
                .unwrap_or(1.0);
            let account_context_window = pool
                .map(|pool| ((pool as f64) * share).floor() as u64)
                .filter(|window| *window > 0);
            Some(CodexAccountModel {
                slug,
                display_name: record
                    .get("display_name")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
                account_context_window,
                visible: record.get("visibility").and_then(Value::as_str) != Some("hide"),
            })
        })
        .collect();
    *lock_catalog_cache() = Some((path, size, modified, models.clone()));
    Some(models)
}

#[derive(Clone)]
pub(crate) struct CodexBridge {
    runtime_root: PathBuf,
    bridge_path: PathBuf,
    child_env: HashMap<String, String>,
    timeout_ms: u64,
    /// Directory the Codex CLI keeps its account catalog in.
    codex_home: Option<PathBuf>,
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
            codex_home: codex_home_dir(config),
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

    /// Models the logged-in account may run, from the Codex CLI catalog.
    pub(crate) fn account_models(&self) -> Vec<CodexAccountModel> {
        self.codex_home
            .as_deref()
            .and_then(read_account_model_catalog_at)
            .unwrap_or_default()
    }

    /// Slugs of the models the account may run, in catalog order.
    pub(crate) fn account_model_slugs(&self) -> Vec<String> {
        self.account_models()
            .into_iter()
            .filter(|model| model.visible)
            .map(|model| model.slug)
            .collect()
    }

    /// Context window the account granted for a model, when the catalog knows
    /// it. The account may narrow a model's window, never widen it.
    pub(crate) fn account_context_window(&self, model: &str) -> Option<u64> {
        let slug = resolve_codex_model_slug(model);
        self.account_models()
            .into_iter()
            .find(|entry| entry.slug == slug)?
            .account_context_window
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
    // GPT-6.1 Sol follows the same shape: the preset carries the reasoning
    // effort, the official id carries the model.
    if normalized.eq_ignore_ascii_case("gpt-6.1-sol-max")
        || normalized.eq_ignore_ascii_case("gpt-6.1-sol max")
        || normalized.eq_ignore_ascii_case("gpt-6.1-sol")
    {
        return "gpt-6.1-sol";
    }
    normalized
}

/// Official model ids of the Codex family Memphis recognises without an
/// account catalog. The catalog is authoritative whenever it exists; this set
/// only covers the case where the Codex CLI has never run on this machine.
pub(crate) const CODEX_FAMILY_MODELS: &[&str] = &["gpt-6-astra", "gpt-5.6-sol", "gpt-6.1-sol"];

/// Documented context window of the Codex model family. It only bounds the
/// account grant from above, because the account grant is what the server
/// actually enforces.
pub(crate) const CODEX_FAMILY_CONTEXT_WINDOW: u64 = 1_050_000;

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
    let slug = resolve_codex_model_slug(model);
    read_account_model_catalog(config)?
        .into_iter()
        .find(|entry| entry.slug == slug)?
        .account_context_window
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
        assert_eq!(resolve_codex_model_slug("gpt-6.1-sol-max"), "gpt-6.1-sol");
        assert_eq!(resolve_codex_model_slug("gpt-6.1-sol max"), "gpt-6.1-sol");
        assert_eq!(resolve_codex_model_slug("GPT-6.1-SOL"), "gpt-6.1-sol");
        assert_eq!(resolve_codex_model_slug("gpt-6-astra"), "gpt-6-astra");
        assert_eq!(resolve_codex_model_slug("custom-model"), "custom-model");
    }

    /// The account catalog is the only source that knows about models
    /// released after Memphis was built, so it must name them and record the
    /// window each one was granted.
    #[test]
    fn codex_account_catalog_names_models_and_their_windows() {
        let root = std::env::temp_dir().join(format!(
            "memphis-native-codex-models-{}-{}",
            std::process::id(),
            NEXT_ID.fetch_add(1, Ordering::SeqCst)
        ));
        fs::create_dir_all(&root).unwrap();
        fs::write(
            root.join("models_cache.json"),
            r#"{"models":[
                {"slug":"gpt-6.1-sol","display_name":"GPT-6.1-Sol","visibility":"list","context_window":500000,"effective_context_window_percent":95},
                {"slug":"gpt-6-astra","display_name":"GPT-6-Astra","visibility":"list","context_window":272000,"effective_context_window_percent":95},
                {"slug":"gpt-reserve","display_name":"GPT-Reserve","visibility":"hide","context_window":272000,"effective_context_window_percent":95}
            ]}"#,
        )
        .unwrap();
        let config = OperatorConfig::from_iter([
            ("MEMPHIS_RUNTIME_ROOT", root.to_string_lossy().into_owned()),
            ("CODEX_HOME", root.to_string_lossy().into_owned()),
            ("HOME", root.to_string_lossy().into_owned()),
        ]);

        let models = read_account_model_catalog(&config).expect("catalog");
        assert_eq!(
            models.iter().map(|model| model.slug.as_str()).collect::<Vec<_>>(),
            vec!["gpt-6.1-sol", "gpt-6-astra", "gpt-reserve"]
        );
        // 500000 granted pool * 95% share = 475000 usable tokens.
        assert_eq!(
            read_account_context_window(&config, "gpt-6.1-sol"),
            Some(475_000)
        );
        assert_eq!(
            read_account_context_window(&config, "gpt-6.1-sol-max"),
            Some(475_000)
        );
        assert_eq!(
            read_account_context_window(&config, "gpt-6-astra"),
            Some(258_400)
        );
        // A hidden model is still in the catalog, but it is not offered.
        assert_eq!(
            read_account_context_window(&config, "gpt-reserve"),
            Some(258_400)
        );
        assert_eq!(read_account_context_window(&config, "unknown-model"), None);

        let bridge = CodexBridge::from_config(&config).unwrap();
        assert_eq!(
            bridge.account_model_slugs(),
            vec!["gpt-6.1-sol".to_string(), "gpt-6-astra".to_string()]
        );
        fs::remove_dir_all(&root).ok();
    }

    /// A model the catalog does not know must not silently inherit another
    /// model's window.
    #[test]
    fn codex_account_catalog_absent_leaves_the_window_unknown() {
        let root = std::env::temp_dir().join(format!(
            "memphis-native-codex-nocatalog-{}-{}",
            std::process::id(),
            NEXT_ID.fetch_add(1, Ordering::SeqCst)
        ));
        fs::create_dir_all(&root).unwrap();
        let config = OperatorConfig::from_iter([
            ("MEMPHIS_RUNTIME_ROOT", root.to_string_lossy().into_owned()),
            ("CODEX_HOME", root.to_string_lossy().into_owned()),
            ("HOME", root.to_string_lossy().into_owned()),
        ]);
        assert!(read_account_model_catalog(&config).is_none());
        assert_eq!(read_account_context_window(&config, "gpt-6.1-sol"), None);
        fs::remove_dir_all(&root).ok();
    }
}
