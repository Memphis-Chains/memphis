use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStderr, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    mpsc::{self, Receiver, RecvTimeoutError, Sender},
    Arc, Mutex,
};
use std::{
    fmt, thread,
    time::{Duration, Instant},
};

use memphis_operator::{
    ChatExchange, ChatSessionView, ChatStreamEvent, MemoryQueryResult, OperatorError,
    OperatorRuntime, OperatorSnapshot, ProviderStatus, VaultSecretView,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub type AppSnapshot = OperatorSnapshot;

const HOST_POLL_INTERVAL: Duration = Duration::from_millis(50);
const HOST_HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(10);
const HOST_REQUEST_START_TIMEOUT: Duration = Duration::from_secs(10);
const HOST_REQUEST_IDLE_TIMEOUT: Duration = Duration::from_secs(30);
const HOST_CANCEL_TIMEOUT: Duration = Duration::from_secs(2);

#[derive(Debug, Clone)]
pub struct CliBridgeResult {
    pub command_label: String,
    pub stdout: String,
    pub json: Option<Value>,
}

#[derive(Debug, Clone)]
pub struct ExtensionHostCommand {
    pub label: String,
    pub command: String,
    pub args: Value,
}

#[derive(Debug, Clone)]
pub struct ExtensionHostResult {
    pub command: String,
    pub data: Value,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BridgeLineLevel {
    Info,
    Warning,
    Error,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BridgeLine {
    pub level: BridgeLineLevel,
    pub text: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ClientCommandError {
    Message(String),
    Cancelled,
}

impl fmt::Display for ClientCommandError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Message(message) => write!(f, "{message}"),
            Self::Cancelled => write!(f, "cancelled"),
        }
    }
}

#[derive(Debug, Clone)]
pub struct MemphisClient {
    runtime: OperatorRuntime,
    extension_host: Arc<Mutex<ExtensionHostManager>>,
}

impl MemphisClient {
    pub fn new() -> Self {
        Self {
            runtime: OperatorRuntime::from_env(),
            extension_host: Arc::new(Mutex::new(ExtensionHostManager::default())),
        }
    }

    /// Drop the cached env-snapshot OperatorRuntime and rebuild from the
    /// current .env on disk. Use after `memphis vault add` or any other
    /// out-of-process .env mutation so the next chat call sees the new
    /// MINIMAX_VAULT_KEY (or whatever was just written) without bouncing
    /// the whole TUI process.
    ///
    /// Returns the count of env vars actually applied from the file
    /// (`Ok(n)`) or an error if the .env was unreadable.
    ///
    /// Mechanics:
    ///   1. Walk up from `cwd` to find the install root (a directory
    ///      whose `package.json` carries `name == "@memphis-chains/memphis"`).
    ///   2. Parse `${installRoot}/.env` line-by-line.
    ///   3. For every `KEY=VALUE` pair, call `std::env::set_var` so the
    ///      next `env::vars()` snapshot sees it.
    ///   4. Rebuild `self.runtime` via `OperatorRuntime::from_env()`.
    ///
    /// Note: this does NOT update OTHER MemphisClient clones held by
    /// already-spawned tasks — they keep using their captured runtime.
    /// That's intentional; in-flight requests should not have their
    /// provider config yanked mid-stream.
    pub fn reload_env_from_disk(&mut self) -> Result<usize, String> {
        let env_path = locate_dotenv_from_install_root()
            .ok_or_else(|| "could not locate installRoot/.env".to_string())?;
        let applied = apply_dotenv_file(&env_path)?;
        self.runtime = OperatorRuntime::from_env();
        Ok(applied)
    }

    pub fn fetch_snapshot(&self) -> AppSnapshot {
        self.runtime.snapshot()
    }

    pub fn search_exact(&self, query: &str, limit: usize) -> Result<MemoryQueryResult, String> {
        self.runtime
            .search_exact(query, limit, None)
            .map_err(|error| error.to_string())
    }

    pub fn search_semantic(&self, query: &str, limit: usize) -> Result<MemoryQueryResult, String> {
        self.runtime
            .search_semantic(query, limit)
            .map_err(|error| error.to_string())
    }

    pub fn read_vault_secret(&self, key: &str) -> Result<VaultSecretView, String> {
        self.runtime
            .read_vault_secret(key)
            .map_err(|error| error.to_string())
    }

    pub fn load_chat_session(
        &self,
        session_id: Option<&str>,
        limit: usize,
    ) -> Result<ChatSessionView, String> {
        self.runtime
            .chat_session(session_id, limit)
            .map_err(|error| error.to_string())
    }

    pub fn stream_chat_with_cancel<F>(
        &self,
        session_id: Option<&str>,
        prompt: &str,
        provider: Option<&str>,
        model: Option<&str>,
        cancel_flag: Arc<AtomicBool>,
        on_event: F,
    ) -> Result<ChatExchange, ClientCommandError>
    where
        F: FnMut(ChatStreamEvent),
    {
        self.runtime
            .chat_stream_with_cancel(
                session_id,
                prompt,
                provider,
                model,
                Some(cancel_flag.as_ref()),
                on_event,
            )
            .map_err(client_command_error)
    }

    pub fn provider_statuses(&self) -> Vec<ProviderStatus> {
        self.runtime.provider_statuses()
    }

    pub fn run_extension_command_with_cancel<F>(
        &self,
        command: &ExtensionHostCommand,
        cancel_flag: Arc<AtomicBool>,
        mut on_line: F,
    ) -> Result<ExtensionHostResult, ClientCommandError>
    where
        F: FnMut(BridgeLine),
    {
        let mut manager = self.extension_host.lock().map_err(|_| {
            ClientCommandError::Message("extension host manager lock poisoned".to_string())
        })?;
        manager.ensure_session()?;
        let request_id = manager.next_request_id();
        let request_started_at = Instant::now();
        let mut last_progress_at = request_started_at;
        let mut saw_started = false;

        {
            let session = manager.session_mut()?;
            send_host_request(
                &mut session.stdin,
                &HostRequest::Execute {
                    id: request_id.clone(),
                    command: command.command.clone(),
                    args: command.args.clone(),
                },
            )?;
        }

        let mut cancel_sent = false;
        let mut cancel_wait_elapsed = Duration::ZERO;

        loop {
            if cancel_flag.load(Ordering::Relaxed) && !cancel_sent {
                if let Ok(session) = manager.session_mut() {
                    let _ = send_host_request(
                        &mut session.stdin,
                        &HostRequest::Cancel {
                            id: request_id.clone(),
                        },
                    );
                }
                cancel_sent = true;
            }

            let event = {
                let session = manager.session_mut()?;
                session.events.recv_timeout(HOST_POLL_INTERVAL)
            };

            match event {
                Ok(HostOutputEvent::Event(HostEvent::Ready { .. })) => {}
                Ok(HostOutputEvent::Event(HostEvent::Started { id, label }))
                    if id == request_id =>
                {
                    saw_started = true;
                    last_progress_at = Instant::now();
                    let _ = label;
                }
                Ok(HostOutputEvent::Event(HostEvent::Line { id, level, text }))
                    if id == request_id =>
                {
                    if !saw_started {
                        return Err(reset_session_with_error(
                            &mut manager,
                            "extension host protocol error",
                            "received line event before started".to_string(),
                        ));
                    }
                    last_progress_at = Instant::now();
                    on_line(BridgeLine {
                        level: bridge_line_level(level.as_str()),
                        text,
                    });
                }
                Ok(HostOutputEvent::Event(HostEvent::Result { id, data })) if id == request_id => {
                    if !saw_started {
                        return Err(reset_session_with_error(
                            &mut manager,
                            "extension host protocol error",
                            "received result event before started".to_string(),
                        ));
                    }
                    return Ok(ExtensionHostResult {
                        command: command.command.clone(),
                        data,
                    });
                }
                Ok(HostOutputEvent::Event(HostEvent::Error { id, message }))
                    if id == request_id || id == "__protocol__" =>
                {
                    let message = if id == "__protocol__" {
                        reset_session_message(
                            &mut manager,
                            "extension host protocol error",
                            message,
                        )
                    } else if !saw_started {
                        reset_session_message(
                            &mut manager,
                            "extension host protocol error",
                            format!("received error event before started: {message}"),
                        )
                    } else {
                        message
                    };
                    return Err(ClientCommandError::Message(message));
                }
                Ok(HostOutputEvent::Event(HostEvent::Cancelled { id })) if id == request_id => {
                    if !saw_started {
                        return Err(reset_session_with_error(
                            &mut manager,
                            "extension host protocol error",
                            "received cancelled event before started".to_string(),
                        ));
                    }
                    return Err(ClientCommandError::Cancelled);
                }
                Ok(HostOutputEvent::ProtocolError(message)) => {
                    return Err(reset_session_with_error(
                        &mut manager,
                        "extension host protocol error",
                        message,
                    ));
                }
                Ok(HostOutputEvent::Event(_)) => {}
                Err(RecvTimeoutError::Timeout) => {
                    if cancel_sent {
                        cancel_wait_elapsed += HOST_POLL_INTERVAL;
                        if cancel_wait_elapsed >= HOST_CANCEL_TIMEOUT {
                            manager.reset_session();
                            return Err(ClientCommandError::Cancelled);
                        }
                    } else if !saw_started
                        && request_started_at.elapsed() >= HOST_REQUEST_START_TIMEOUT
                    {
                        return Err(reset_session_with_error(
                            &mut manager,
                            "extension host request timed out before start",
                            format!(
                                "request {} did not emit started within {:?}",
                                request_id, HOST_REQUEST_START_TIMEOUT
                            ),
                        ));
                    } else if saw_started && last_progress_at.elapsed() >= HOST_REQUEST_IDLE_TIMEOUT
                    {
                        return Err(reset_session_with_error(
                            &mut manager,
                            "extension host request stalled",
                            format!(
                                "request {} emitted no progress for {:?}",
                                request_id, HOST_REQUEST_IDLE_TIMEOUT
                            ),
                        ));
                    }
                }
                Err(RecvTimeoutError::Disconnected) => {
                    return Err(reset_session_with_error(
                        &mut manager,
                        "extension host stopped unexpectedly",
                        "stdout event channel disconnected".to_string(),
                    ));
                }
            }
        }
    }

    pub fn run_cli_command_with_cancel(
        &self,
        args: &[String],
        cancel_flag: Arc<AtomicBool>,
    ) -> Result<CliBridgeResult, ClientCommandError> {
        let project_root = project_root();
        let mut command = new_memphis_cli_command(&project_root);
        command.args(args);
        if !args.iter().any(|arg| arg == "--json") {
            command.arg("--json");
        }
        apply_bridge_env(&mut command, &project_root);
        command.stdout(Stdio::piped());
        command.stderr(Stdio::piped());

        let mut child = command.spawn().map_err(|error| {
            ClientCommandError::Message(format!("failed to launch memphis CLI bridge: {error}"))
        })?;
        let stdout = child.stdout.take().ok_or_else(|| {
            ClientCommandError::Message("memphis CLI bridge stdout pipe unavailable".to_string())
        })?;
        let stderr = child.stderr.take().ok_or_else(|| {
            ClientCommandError::Message("memphis CLI bridge stderr pipe unavailable".to_string())
        })?;

        let stdout_handle = thread::spawn(move || read_pipe(stdout));
        let stderr_handle = thread::spawn(move || read_pipe(stderr));
        let wait_cancel = Arc::clone(&cancel_flag);
        let waiter = thread::spawn(move || -> Result<std::process::ExitStatus, String> {
            loop {
                if wait_cancel.load(Ordering::Relaxed) {
                    let _ = child.kill();
                }

                match child.try_wait() {
                    Ok(Some(status)) => return Ok(status),
                    Ok(None) => thread::sleep(Duration::from_millis(25)),
                    Err(error) => {
                        return Err(format!("failed waiting for memphis CLI bridge: {error}"))
                    }
                }
            }
        });

        let status = waiter
            .join()
            .map_err(|_| {
                ClientCommandError::Message("memphis CLI bridge waiter thread panicked".to_string())
            })?
            .map_err(ClientCommandError::Message)?;
        let stdout = stdout_handle
            .join()
            .map_err(|_| {
                ClientCommandError::Message("memphis CLI bridge stdout thread panicked".to_string())
            })?
            .map_err(ClientCommandError::Message)?
            .trim()
            .to_string();
        let stderr = stderr_handle
            .join()
            .map_err(|_| {
                ClientCommandError::Message("memphis CLI bridge stderr thread panicked".to_string())
            })?
            .map_err(ClientCommandError::Message)?
            .trim()
            .to_string();

        if cancel_flag.load(Ordering::Relaxed) {
            return Err(ClientCommandError::Cancelled);
        }

        if !status.success() {
            return Err(ClientCommandError::Message(if stderr.is_empty() {
                stdout
            } else {
                format!("{stderr}\n{stdout}").trim().to_string()
            }));
        }

        let json = if stdout.is_empty() {
            None
        } else {
            serde_json::from_str::<Value>(&stdout).ok()
        };

        Ok(CliBridgeResult {
            command_label: args.join(" "),
            stdout,
            json,
        })
    }
}

#[derive(Debug, Default)]
struct ExtensionHostManager {
    session: Option<ExtensionHostSession>,
    next_request_counter: u64,
}

impl ExtensionHostManager {
    fn ensure_session(&mut self) -> Result<(), ClientCommandError> {
        // S2.5 fix Bug 3: detect dead host child before reusing the session.
        // Pre-fix: ensure_session was a no-op when self.session was Some(...),
        // even if the child process had exited. Subsequent send_host_request
        // wrote to a dead stdin pipe and the operator saw
        // `host request write failed; Broken pipe (os error 32)` on the
        // second slash command. Auto-respawn-on-dead matches the
        // long-running-supervisor pattern used for MatrixTransport reconnect.
        if let Some(session) = self.session.as_mut() {
            match session.child.try_wait() {
                Ok(Some(_status)) => {
                    // Child has exited — drop the stale session so the next
                    // block respawns. Drop runs ExtensionHostSession::shutdown
                    // which is idempotent on an already-exited child.
                    self.session = None;
                }
                Ok(None) => {
                    // Still alive — reuse.
                }
                Err(_) => {
                    // try_wait failed; assume stale and respawn defensively.
                    self.session = None;
                }
            }
        }
        if self.session.is_none() {
            self.session = Some(start_extension_host_session()?);
        }
        Ok(())
    }

    fn session_mut(&mut self) -> Result<&mut ExtensionHostSession, ClientCommandError> {
        self.session.as_mut().ok_or_else(|| {
            ClientCommandError::Message("extension host session was not initialized".to_string())
        })
    }

    fn next_request_id(&mut self) -> String {
        self.next_request_counter += 1;
        format!("req-{}", self.next_request_counter)
    }

    fn stderr_snapshot(&self) -> Vec<String> {
        self.session
            .as_ref()
            .map(ExtensionHostSession::stderr_snapshot)
            .unwrap_or_default()
    }

    fn reset_session(&mut self) {
        if let Some(mut session) = self.session.take() {
            session.shutdown();
        }
    }
}

#[derive(Debug)]
struct ExtensionHostSession {
    child: Child,
    stdin: ChildStdin,
    events: Receiver<HostOutputEvent>,
    stderr_lines: Arc<Mutex<Vec<String>>>,
}

impl ExtensionHostSession {
    fn stderr_snapshot(&self) -> Vec<String> {
        self.stderr_lines
            .lock()
            .map(|lines| lines.clone())
            .unwrap_or_default()
    }

    fn shutdown(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

impl Drop for ExtensionHostSession {
    fn drop(&mut self) {
        self.shutdown();
    }
}

#[derive(Debug, Serialize)]
#[serde(tag = "type")]
enum HostRequest {
    #[serde(rename = "execute")]
    Execute {
        id: String,
        command: String,
        args: Value,
    },
    #[serde(rename = "cancel")]
    Cancel { id: String },
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type")]
enum HostEvent {
    #[serde(rename = "ready")]
    Ready {
        #[serde(rename = "protocolVersion")]
        protocol_version: u64,
        capabilities: Vec<String>,
    },
    #[serde(rename = "started")]
    Started { id: String, label: String },
    #[serde(rename = "line")]
    Line {
        id: String,
        level: String,
        text: String,
    },
    #[serde(rename = "result")]
    Result { id: String, data: Value },
    #[serde(rename = "error")]
    Error { id: String, message: String },
    #[serde(rename = "cancelled")]
    Cancelled { id: String },
}

#[derive(Debug)]
enum HostOutputEvent {
    Event(HostEvent),
    ProtocolError(String),
}

fn start_extension_host_session() -> Result<ExtensionHostSession, ClientCommandError> {
    let project_root = project_root();
    let mut command = new_memphis_cli_command(&project_root);
    command.args(["tui", "host", "--stdio-json"]);
    apply_bridge_env(&mut command, &project_root);
    command.stdin(Stdio::piped());
    command.stdout(Stdio::piped());
    command.stderr(Stdio::piped());

    let mut child = command.spawn().map_err(|error| {
        ClientCommandError::Message(format!("failed to launch memphis extension host: {error}"))
    })?;
    let stdin = child.stdin.take().ok_or_else(|| {
        ClientCommandError::Message("extension host stdin pipe unavailable".to_string())
    })?;
    let stdout = child.stdout.take().ok_or_else(|| {
        ClientCommandError::Message("extension host stdout pipe unavailable".to_string())
    })?;
    let stderr = child.stderr.take().ok_or_else(|| {
        ClientCommandError::Message("extension host stderr pipe unavailable".to_string())
    })?;

    let (sender, receiver) = mpsc::channel();
    spawn_host_stdout_reader(stdout, sender.clone());
    let stderr_lines = Arc::new(Mutex::new(Vec::new()));
    spawn_host_stderr_reader(stderr, Arc::clone(&stderr_lines));

    let ready_event = receiver
        .recv_timeout(HOST_HANDSHAKE_TIMEOUT)
        .map_err(|error| {
            ClientCommandError::Message(format!(
                "extension host did not emit ready handshake: {error}"
            ))
        })?;
    match ready_event {
        HostOutputEvent::Event(HostEvent::Ready {
            protocol_version: 1,
            capabilities,
        }) => {
            if capabilities.is_empty() {
                return Err(ClientCommandError::Message(
                    "extension host reported no capabilities".to_string(),
                ));
            }
        }
        HostOutputEvent::Event(HostEvent::Ready {
            protocol_version, ..
        }) => {
            return Err(ClientCommandError::Message(format!(
                "unsupported extension host protocol version: {protocol_version}"
            )))
        }
        HostOutputEvent::ProtocolError(message) => {
            return Err(ClientCommandError::Message(format!(
                "extension host emitted invalid ready event: {message}"
            )))
        }
        other => {
            return Err(ClientCommandError::Message(format!(
                "extension host emitted unexpected startup event: {other:?}"
            )))
        }
    }

    Ok(ExtensionHostSession {
        child,
        stdin,
        events: receiver,
        stderr_lines,
    })
}

fn spawn_host_stdout_reader(stdout: ChildStdout, sender: Sender<HostOutputEvent>) {
    thread::spawn(move || {
        let reader = BufReader::new(stdout);
        for line in reader.lines() {
            let line = match line {
                Ok(line) => line,
                Err(error) => {
                    let _ = sender.send(HostOutputEvent::ProtocolError(format!(
                        "failed reading extension host stdout: {error}"
                    )));
                    return;
                }
            };
            match serde_json::from_str::<HostEvent>(&line) {
                Ok(event) => {
                    let _ = sender.send(HostOutputEvent::Event(event));
                }
                Err(error) => {
                    let _ = sender.send(HostOutputEvent::ProtocolError(format!(
                        "failed to parse extension host event: {error}; line={line}"
                    )));
                    return;
                }
            }
        }
    });
}

fn spawn_host_stderr_reader(stderr: ChildStderr, lines: Arc<Mutex<Vec<String>>>) {
    thread::spawn(move || {
        let reader = BufReader::new(stderr);
        for line in reader.lines() {
            let Ok(line) = line else {
                return;
            };
            if let Ok(mut guard) = lines.lock() {
                guard.push(line);
                if guard.len() > 20 {
                    let overflow = guard.len() - 20;
                    guard.drain(0..overflow);
                }
            }
        }
    });
}

fn send_host_request(
    stdin: &mut ChildStdin,
    request: &HostRequest,
) -> Result<(), ClientCommandError> {
    let payload = serde_json::to_string(request).map_err(|error| {
        ClientCommandError::Message(format!(
            "failed to serialize extension host request: {error}"
        ))
    })?;
    stdin
        .write_all(payload.as_bytes())
        .and_then(|_| stdin.write_all(b"\n"))
        .and_then(|_| stdin.flush())
        .map_err(|error| {
            ClientCommandError::Message(format!("failed writing extension host request: {error}"))
        })
}

fn reset_session_with_error(
    manager: &mut ExtensionHostManager,
    prefix: &str,
    message: String,
) -> ClientCommandError {
    ClientCommandError::Message(reset_session_message(manager, prefix, message))
}

fn reset_session_message(
    manager: &mut ExtensionHostManager,
    prefix: &str,
    message: String,
) -> String {
    let snapshot = manager.stderr_snapshot();
    manager.reset_session();
    format_host_error(prefix, message, snapshot)
}

fn new_memphis_cli_command(project_root: &Path) -> Command {
    if let Some((tsx_path, cli_entry)) = source_cli_entrypoint(project_root) {
        let mut command = Command::new(tsx_path);
        command.arg(cli_entry);
        return command;
    }

    let mut command = Command::new("node");
    command.arg(project_root.join("bin").join("memphis.js"));
    command
}

fn source_cli_entrypoint(project_root: &Path) -> Option<(PathBuf, PathBuf)> {
    let tsx_binary = project_root
        .join("node_modules")
        .join(".bin")
        .join(if cfg!(windows) { "tsx.cmd" } else { "tsx" });
    let cli_entry = project_root
        .join("src")
        .join("infra")
        .join("cli")
        .join("index.ts");

    if tsx_binary.exists() && cli_entry.exists() {
        Some((tsx_binary, cli_entry))
    } else {
        None
    }
}

fn apply_bridge_env(command: &mut Command, project_root: &PathBuf) {
    command.current_dir(project_root);
    command.env("NODE_NO_WARNINGS", "1");
    command.env("NODE_ENV", "test");
    command.env("MEMPHIS_SKIP_FIRST_RUN_CHECKS", "1");
}

fn bridge_line_level(level: &str) -> BridgeLineLevel {
    match level {
        "warning" => BridgeLineLevel::Warning,
        "error" => BridgeLineLevel::Error,
        _ => BridgeLineLevel::Info,
    }
}

fn format_host_error(prefix: &str, message: String, stderr_lines: Vec<String>) -> String {
    if stderr_lines.is_empty() {
        return format!("{prefix}: {message}");
    }
    format!("{prefix}: {message}\nstderr:\n{}", stderr_lines.join("\n"))
}

fn project_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()
        .unwrap_or_else(|_| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../.."))
}

fn read_pipe(mut pipe: impl Read) -> Result<String, String> {
    let mut buffer = String::new();
    pipe.read_to_string(&mut buffer)
        .map_err(|error| format!("failed reading memphis CLI bridge output: {error}"))?;
    Ok(buffer)
}

fn client_command_error(error: OperatorError) -> ClientCommandError {
    match error {
        OperatorError::Cancelled => ClientCommandError::Cancelled,
        other => ClientCommandError::Message(other.to_string()),
    }
}

// ─── /reload helpers (Phase A1) ──────────────────────────────────────────
//
// Used by MemphisClient::reload_env_from_disk to pick up post-startup
// .env changes (e.g. `memphis vault add` writes a new MINIMAX_VAULT_KEY)
// without restarting the TUI process. Same install-root resolution logic
// as the TS-side `resolveInstallRoot`: walk up from cwd looking for a
// `package.json` whose name field is `@memphis-chains/memphis`.

const MEMPHIS_PACKAGE_NAME: &str = "@memphis-chains/memphis";

fn locate_dotenv_from_install_root() -> Option<PathBuf> {
    let env_override = std::env::var("MEMPHIS_ENV_FILE").ok();
    if let Some(path) = env_override {
        let trimmed = path.trim();
        if !trimmed.is_empty() {
            return Some(PathBuf::from(trimmed));
        }
    }

    let runtime_root = std::env::var("MEMPHIS_RUNTIME_ROOT").ok();
    if let Some(root) = runtime_root {
        let candidate = PathBuf::from(root.trim());
        if package_name_matches(&candidate) {
            return Some(candidate.join(".env"));
        }
    }

    let cwd = std::env::current_dir().ok()?;
    let mut current: Option<&Path> = Some(cwd.as_path());
    while let Some(dir) = current {
        if package_name_matches(dir) {
            return Some(dir.join(".env"));
        }
        current = dir.parent();
    }
    None
}

fn package_name_matches(dir: &Path) -> bool {
    let pkg = dir.join("package.json");
    let Ok(raw) = std::fs::read_to_string(&pkg) else {
        return false;
    };
    // Cheap parse — full serde_json would pull in features we don't
    // need just for one string lookup. Memphis's package.json is
    // deterministic enough that a substring check is fine.
    raw.contains(&format!("\"name\": \"{MEMPHIS_PACKAGE_NAME}\""))
        || raw.contains(&format!("\"name\":\"{MEMPHIS_PACKAGE_NAME}\""))
}

fn apply_dotenv_file(path: &Path) -> Result<usize, String> {
    let content = std::fs::read_to_string(path)
        .map_err(|error| format!("failed reading {}: {error}", path.display()))?;
    let mut applied = 0usize;
    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        let Some((key, value)) = trimmed.split_once('=') else {
            continue;
        };
        let key = key.trim();
        if key.is_empty() {
            continue;
        }
        // Strip surrounding quotes — common `KEY="value"` shape.
        let value = strip_dotenv_quotes(value.trim());
        std::env::set_var(key, value);
        applied += 1;
    }
    Ok(applied)
}

fn strip_dotenv_quotes(value: &str) -> &str {
    if value.len() >= 2 {
        let first = value.chars().next().unwrap();
        let last = value.chars().last().unwrap();
        if (first == '"' && last == '"') || (first == '\'' && last == '\'') {
            return &value[1..value.len() - 1];
        }
    }
    value
}

#[cfg(test)]
mod reload_tests {
    use super::{apply_dotenv_file, package_name_matches, strip_dotenv_quotes};
    use std::fs::write;
    use std::path::PathBuf;

    fn tmpfile(name: &str, content: &str) -> PathBuf {
        let dir =
            tempdir_path(&format!("memphis-tui-reload-{name}-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("mkdir tmp");
        let path = dir.join(name);
        write(&path, content).expect("write fixture");
        path
    }

    fn tempdir_path(suffix: &str) -> PathBuf {
        let mut p = std::env::temp_dir();
        p.push(suffix);
        p
    }

    #[test]
    fn strip_dotenv_quotes_handles_double_single_and_unquoted() {
        assert_eq!(strip_dotenv_quotes(r#""hello""#), "hello");
        assert_eq!(strip_dotenv_quotes(r#"'world'"#), "world");
        assert_eq!(strip_dotenv_quotes("bare"), "bare");
        assert_eq!(strip_dotenv_quotes(r#"""#), r#"""#); // single-char passthrough
    }

    #[test]
    fn apply_dotenv_file_sets_keys_and_returns_count() {
        // Use a unique env-key prefix so we don't trample real env state.
        let path = tmpfile(
            "set-keys.env",
            "TUI_RELOAD_TEST_FOO=1\n\
             # comment\n\
             \n\
             TUI_RELOAD_TEST_BAR=\"with spaces\"\n\
             TUI_RELOAD_TEST_BAZ='quoted-single'\n",
        );
        // Pre-clean
        std::env::remove_var("TUI_RELOAD_TEST_FOO");
        std::env::remove_var("TUI_RELOAD_TEST_BAR");
        std::env::remove_var("TUI_RELOAD_TEST_BAZ");

        let applied = apply_dotenv_file(&path).expect("apply");
        assert_eq!(applied, 3);
        assert_eq!(std::env::var("TUI_RELOAD_TEST_FOO").unwrap(), "1");
        assert_eq!(std::env::var("TUI_RELOAD_TEST_BAR").unwrap(), "with spaces");
        assert_eq!(std::env::var("TUI_RELOAD_TEST_BAZ").unwrap(), "quoted-single");

        // cleanup
        std::env::remove_var("TUI_RELOAD_TEST_FOO");
        std::env::remove_var("TUI_RELOAD_TEST_BAR");
        std::env::remove_var("TUI_RELOAD_TEST_BAZ");
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn apply_dotenv_file_errors_on_missing_path() {
        let bogus = std::env::temp_dir().join("memphis-tui-reload-nope.env");
        let _ = std::fs::remove_file(&bogus);
        let result = apply_dotenv_file(&bogus);
        assert!(result.is_err());
    }

    #[test]
    fn package_name_matches_recognises_memphis_package_json() {
        let dir = tempdir_path(&format!(
            "memphis-tui-reload-pkg-{}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).expect("mkdir");
        write(
            dir.join("package.json"),
            r#"{ "name": "@memphis-chains/memphis", "version": "1.0.0" }"#,
        )
        .expect("write pkg");
        assert!(package_name_matches(&dir));

        write(
            dir.join("package.json"),
            r#"{"name":"@memphis-chains/memphis"}"#,
        )
        .expect("rewrite");
        assert!(package_name_matches(&dir));

        write(dir.join("package.json"), r#"{ "name": "other" }"#).expect("other");
        assert!(!package_name_matches(&dir));

        let _ = std::fs::remove_dir_all(&dir);
    }
}
