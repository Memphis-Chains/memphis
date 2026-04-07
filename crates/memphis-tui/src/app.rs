use std::{
    collections::{HashMap, HashSet},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc::{self, Receiver, Sender, TryRecvError},
        Arc,
    },
    thread,
};

use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
use memphis_operator::{
    ChatExchange, ChatStreamEvent, ChatTranscriptEntry, MemoryQueryResult,
    ModelCapabilitySummary, ProviderStatus, SearchMode, TelegramReadinessSummary,
    TokenUsageSummary, VaultSecretView,
};
use serde_json::{json, Value};

use crate::client::{
    AppSnapshot, BridgeLineLevel, CliBridgeResult, ClientCommandError, ExtensionHostCommand,
    ExtensionHostResult, MemphisClient,
};
use crate::config::TuiConfig;

const OUTPUT_BUFFER_LIMIT: usize = 1200;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Screen {
    Overview,
    Chat,
    Memory,
    Sessions,
    Vault,
    Cases,
    System,
}

impl Screen {
    pub fn all() -> [Screen; 7] {
        [
            Screen::Overview,
            Screen::Chat,
            Screen::Memory,
            Screen::Sessions,
            Screen::Vault,
            Screen::Cases,
            Screen::System,
        ]
    }

    pub fn title(self) -> &'static str {
        match self {
            Screen::Overview => "Overview",
            Screen::Chat => "Chat",
            Screen::Memory => "Memory",
            Screen::Sessions => "Sessions",
            Screen::Vault => "Vault",
            Screen::Cases => "Cases",
            Screen::System => "System",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AppAction {
    None,
    Refresh,
    InterruptOrQuit,
    SubmitInput,
    ClearOutput,
    ScrollUp,
    ScrollDown,
    PageUp,
    PageDown,
    ScrollTop,
    ScrollBottom,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[allow(dead_code)]
pub enum LineTone {
    Plain,
    Title,
    Header,
    Section,
    Info,
    Success,
    Warning,
    Error,
    Dim,
    Accent,
    Prompt,
}

impl LineTone {
    pub fn as_str(self) -> &'static str {
        match self {
            LineTone::Plain => "plain",
            LineTone::Title => "title",
            LineTone::Header => "header",
            LineTone::Section => "section",
            LineTone::Info => "info",
            LineTone::Success => "success",
            LineTone::Warning => "warning",
            LineTone::Error => "error",
            LineTone::Dim => "dim",
            LineTone::Accent => "accent",
            LineTone::Prompt => "prompt",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CommandRoute {
    Native,
    Host,
    Legacy,
    Unsupported,
}

impl CommandRoute {
    pub fn as_str(self) -> &'static str {
        match self {
            CommandRoute::Native => "native",
            CommandRoute::Host => "host",
            CommandRoute::Legacy => "legacy",
            CommandRoute::Unsupported => "unsupported",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct HelpEntry {
    display: &'static str,
    example: &'static str,
    route: CommandRoute,
}

const HELP_ENTRIES: &[HelpEntry] = &[
    HelpEntry {
        display: "/help",
        example: "/help",
        route: CommandRoute::Native,
    },
    HelpEntry {
        display: "/overview",
        example: "/overview",
        route: CommandRoute::Native,
    },
    HelpEntry {
        display: "/memory",
        example: "/memory",
        route: CommandRoute::Native,
    },
    HelpEntry {
        display: "/memory semantic <query>",
        example: "/memory semantic demo-query",
        route: CommandRoute::Native,
    },
    HelpEntry {
        display: "/memory exact <query>",
        example: "/memory exact demo query",
        route: CommandRoute::Native,
    },
    HelpEntry {
        display: "/sessions",
        example: "/sessions",
        route: CommandRoute::Native,
    },
    HelpEntry {
        display: "/session <id>",
        example: "/session demo-session",
        route: CommandRoute::Native,
    },
    HelpEntry {
        display: "/vault",
        example: "/vault",
        route: CommandRoute::Native,
    },
    HelpEntry {
        display: "/vault get <key>",
        example: "/vault get DEMO_KEY",
        route: CommandRoute::Native,
    },
    HelpEntry {
        display: "/providers",
        example: "/providers",
        route: CommandRoute::Native,
    },
    HelpEntry {
        display: "/models",
        example: "/models",
        route: CommandRoute::Native,
    },
    HelpEntry {
        display: "/provider <name>",
        example: "/provider local-fallback",
        route: CommandRoute::Native,
    },
    HelpEntry {
        display: "/model <id>",
        example: "/model local-fallback-v0",
        route: CommandRoute::Native,
    },
    HelpEntry {
        display: "/system",
        example: "/system",
        route: CommandRoute::Native,
    },
    HelpEntry {
        display: "/telegram",
        example: "/telegram",
        route: CommandRoute::Native,
    },
    HelpEntry {
        display: "/telegram status",
        example: "/telegram status",
        route: CommandRoute::Native,
    },
    HelpEntry {
        display: "/telegram send <message>",
        example: "/telegram send hello from tui",
        route: CommandRoute::Host,
    },
    HelpEntry {
        display: "/telegram send --to <chatId> <message>",
        example: "/telegram send --to 12345 hello from tui",
        route: CommandRoute::Host,
    },
    HelpEntry {
        display: "/health",
        example: "/health",
        route: CommandRoute::Host,
    },
    HelpEntry {
        display: "/pulse",
        example: "/pulse",
        route: CommandRoute::Host,
    },
    HelpEntry {
        display: "/pulse status",
        example: "/pulse status",
        route: CommandRoute::Host,
    },
    HelpEntry {
        display: "/init status",
        example: "/init status",
        route: CommandRoute::Host,
    },
    HelpEntry {
        display: "/doctor [--fix] [--force] [--deep]",
        example: "/doctor --deep",
        route: CommandRoute::Host,
    },
    HelpEntry {
        display: "/agents list",
        example: "/agents list",
        route: CommandRoute::Host,
    },
    HelpEntry {
        display: "/agents discover",
        example: "/agents discover",
        route: CommandRoute::Host,
    },
    HelpEntry {
        display: "/agents show <did>",
        example: "/agents show did:memphis:test",
        route: CommandRoute::Host,
    },
    HelpEntry {
        display: "/sync status [--chain <name>]",
        example: "/sync status --chain journal",
        route: CommandRoute::Host,
    },
    HelpEntry {
        display: "/apps list",
        example: "/apps list",
        route: CommandRoute::Host,
    },
    HelpEntry {
        display: "/apps show <id>",
        example: "/apps show demo-app",
        route: CommandRoute::Host,
    },
    HelpEntry {
        display: "/apps show --file <manifest.json>",
        example: "/apps show --file /tmp/demo.json",
        route: CommandRoute::Host,
    },
    HelpEntry {
        display: "/apps plan <id> [--file <manifest.json>] [--action <name>]",
        example: "/apps plan demo-app --action install",
        route: CommandRoute::Host,
    },
    HelpEntry {
        display: "/reflect [--save]",
        example: "/reflect --save",
        route: CommandRoute::Host,
    },
    HelpEntry {
        display: "/insights [--daily|--weekly|--topic <topic>] [--save]",
        example: "/insights --weekly",
        route: CommandRoute::Host,
    },
    HelpEntry {
        display: "/knowledge <topic>",
        example: "/knowledge Rust TUI",
        route: CommandRoute::Host,
    },
    HelpEntry {
        display: "/knowledge status",
        example: "/knowledge status",
        route: CommandRoute::Host,
    },
    HelpEntry {
        display: "/mode",
        example: "/mode",
        route: CommandRoute::Host,
    },
    HelpEntry {
        display: "/mode <A|B|C|D|E>",
        example: "/mode B",
        route: CommandRoute::Host,
    },
    HelpEntry {
        display: "/config tools list",
        example: "/config tools list",
        route: CommandRoute::Host,
    },
    HelpEntry {
        display: "/config tools check <tool>",
        example: "/config tools check shell",
        route: CommandRoute::Host,
    },
    HelpEntry {
        display: "/config tools pending",
        example: "/config tools pending",
        route: CommandRoute::Host,
    },
    HelpEntry {
        display: "/config surfaces list",
        example: "/config surfaces list",
        route: CommandRoute::Host,
    },
    HelpEntry {
        display: "/config surfaces check <surface>",
        example: "/config surfaces check telegram",
        route: CommandRoute::Host,
    },
    HelpEntry {
        display: "/config surfaces set <surface> <setting> <value>",
        example: "/config surfaces set telegram max-tool-tier 1",
        route: CommandRoute::Host,
    },
    HelpEntry {
        display: "/config surfaces reset <surface> [setting]",
        example: "/config surfaces reset telegram allow-url-fetch",
        route: CommandRoute::Host,
    },
    HelpEntry {
        display: "/legacy <memphis cli args...>",
        example: "/legacy health",
        route: CommandRoute::Legacy,
    },
    HelpEntry {
        display: "/clear",
        example: "/clear",
        route: CommandRoute::Native,
    },
    HelpEntry {
        display: "/refresh",
        example: "/refresh",
        route: CommandRoute::Native,
    },
];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StyledLine {
    pub content: String,
    pub tone: LineTone,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StatusBarContext {
    pub connected: bool,
    pub provider: String,
    pub model: String,
    pub context_window_tokens: Option<u32>,
    pub context_pressure: Option<ContextPressureSummary>,
    pub token_usage: Option<TokenUsageSummary>,
    pub live_token_usage: Option<TokenUsageSummary>,
    pub live_output_tokens: Option<u32>,
    pub session_id: String,
    pub cognitive_mode: String,
    pub pulse_health: String,
    pub busy: bool,
    pub activity: Option<String>,
    pub cancelling: bool,
    pub cancel_waiting_on_provider: bool,
    pub degraded: bool,
    pub degradation_reason: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ContextPressureLevel {
    Low,
    Medium,
    High,
}

impl ContextPressureLevel {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Low => "low",
            Self::Medium => "medium",
            Self::High => "high",
        }
    }

    pub fn short_label(self) -> &'static str {
        match self {
            Self::Low => "low",
            Self::Medium => "med",
            Self::High => "high",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ContextPressureSummary {
    pub level: ContextPressureLevel,
    pub remaining_context_tokens: u32,
    pub estimated: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DegradationState {
    pub active: bool,
    pub tier: u8,
    pub original_provider: String,
    pub actual_provider: String,
    pub reason: String,
}

#[derive(Debug)]
struct ActiveCommand {
    label: String,
    cancel_flag: Arc<AtomicBool>,
    receiver: Receiver<WorkerEvent>,
    cancel_requested: bool,
    cancel_behavior: CancelBehavior,
    kind: ActiveCommandKind,
}

#[derive(Debug)]
#[allow(dead_code)]
enum WorkerEvent {
    ChatChunk { tone: LineTone, chunk: String },
    ChatUsage(TokenUsageSummary),
    ChatCompleted(ChatExchange),
    DegradationUpdate {
        active: bool,
        tier: u8,
        original_provider: String,
        actual_provider: String,
        reason: Option<String>,
    },
    MemoryCompleted(MemoryQueryResult),
    VaultCompleted(VaultSecretView),
    HostCompleted(ExtensionHostResult),
    CliCompleted(CliBridgeResult),
    Error(String),
    Cancelled,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum ActiveCommandKind {
    Generic,
    NativeChat,
    TelegramSend { target_chat: Option<String> },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CancelBehavior {
    Standard,
    WaitForProviderResponse,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum TelegramSendOutcome {
    Delivered,
    Failed,
    Cancelled,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct TelegramSendRecord {
    outcome: TelegramSendOutcome,
    target_chat: Option<String>,
    message_id: Option<String>,
    error: Option<String>,
}

#[derive(Debug)]
pub struct AppState {
    pub config: TuiConfig,
    pub snapshot: AppSnapshot,
    pub input_buffer: String,
    pub output_buffer: Vec<StyledLine>,
    pub history: Vec<String>,
    pub history_index: Option<usize>,
    pub chat_session_id: String,
    pub chat_provider: Option<String>,
    pub chat_model: Option<String>,
    pub provider_statuses: Vec<ProviderStatus>,
    last_token_usage: Option<TokenUsageSummary>,
    live_token_usage: Option<TokenUsageSummary>,
    live_output_chars: Option<usize>,
    last_telegram_send: Option<TelegramSendRecord>,
    active_command: Option<ActiveCommand>,
    next_task_id: u64,
    pub degradation: Option<DegradationState>,
}

impl AppState {
    pub fn new(config: TuiConfig) -> Self {
        Self {
            config,
            snapshot: AppSnapshot::default(),
            input_buffer: String::new(),
            output_buffer: Vec::new(),
            history: Vec::new(),
            history_index: None,
            chat_session_id: "primary::operator:local".to_string(),
            chat_provider: None,
            chat_model: None,
            provider_statuses: Vec::new(),
            last_token_usage: None,
            live_token_usage: None,
            live_output_chars: None,
            last_telegram_send: None,
            active_command: None,
            next_task_id: 1,
            degradation: None,
        }
    }

    pub fn refresh(&mut self, client: &MemphisClient) {
        self.snapshot = client.fetch_snapshot();
        self.provider_statuses = client.provider_statuses();
        if self.output_buffer.is_empty() {
            self.append_line(title("Memphis operator cockpit ready."));
            self.append_line(dim(
                "Plain text sends chat. Use /help for commands and /overview for a runtime snapshot.",
            ));
            self.append_blank();
            self.append_lines(self.surface_lines(Screen::Overview));
            self.append_blank();
        }
    }

    pub fn handle_key(&mut self, key: KeyEvent) -> AppAction {
        match key {
            KeyEvent {
                code: KeyCode::Char('c'),
                modifiers,
                ..
            } if modifiers.contains(KeyModifiers::CONTROL) => AppAction::InterruptOrQuit,
            KeyEvent {
                code: KeyCode::Char('l'),
                modifiers,
                ..
            } if modifiers.contains(KeyModifiers::CONTROL) => AppAction::ClearOutput,
            KeyEvent {
                code: KeyCode::Char('r'),
                modifiers,
                ..
            } if modifiers.contains(KeyModifiers::CONTROL) => AppAction::Refresh,
            KeyEvent {
                code: KeyCode::Enter,
                ..
            } => AppAction::SubmitInput,
            KeyEvent {
                code: KeyCode::Esc, ..
            } => {
                self.input_buffer.clear();
                self.history_index = None;
                AppAction::None
            }
            KeyEvent {
                code: KeyCode::Backspace,
                ..
            } => {
                self.input_buffer.pop();
                AppAction::None
            }
            KeyEvent {
                code: KeyCode::Up, ..
            } => {
                if key.modifiers.contains(KeyModifiers::ALT) {
                    return AppAction::ScrollUp;
                }
                self.history_prev();
                AppAction::None
            }
            KeyEvent {
                code: KeyCode::Down,
                ..
            } => {
                if key.modifiers.contains(KeyModifiers::ALT) {
                    return AppAction::ScrollDown;
                }
                self.history_next();
                AppAction::None
            }
            KeyEvent {
                code: KeyCode::PageUp,
                ..
            } => AppAction::PageUp,
            KeyEvent {
                code: KeyCode::PageDown,
                ..
            } => AppAction::PageDown,
            KeyEvent {
                code: KeyCode::Home, ..
            } => AppAction::ScrollTop,
            KeyEvent {
                code: KeyCode::End, ..
            } => AppAction::ScrollBottom,
            KeyEvent {
                code: KeyCode::Char(ch),
                modifiers,
                ..
            } if modifiers.is_empty() || modifiers == KeyModifiers::SHIFT => {
                self.input_buffer.push(ch);
                AppAction::None
            }
            _ => AppAction::None,
        }
    }

    pub fn clear_output(&mut self) {
        self.output_buffer.clear();
    }

    #[cfg(test)]
    pub fn status_bar_text(&self, timestamp: &str) -> String {
        let context = self.status_bar_context();
        let indicator = if context.connected { "●" } else { "○" };
        let activity = if context.busy {
            let label = context.activity.as_deref().unwrap_or("task");
            if context.cancelling {
                if context.cancel_waiting_on_provider {
                    format!("cancelling {label} (provider wait)")
                } else {
                    format!("cancelling {label}")
                }
            } else {
                format!("busy {label}")
            }
        } else {
            "ready".to_string()
        };
        let degraded_icon = if context.degraded { " ⚠" } else { "" };
        let context_window = context
            .context_window_tokens
            .map(|tokens| format!("ctx:{}", format_token_count(tokens)))
            .unwrap_or_else(|| "ctx:?".to_string());
        let token_usage = context
            .live_token_usage
            .as_ref()
            .map(format_status_token_usage)
            .or_else(|| {
                context
                    .live_output_tokens
                    .map(|tokens| format!("out~:{tokens}"))
            })
            .or_else(|| {
                context
                    .token_usage
                    .as_ref()
                    .map(format_status_token_usage)
            })
            .unwrap_or_else(|| "tok:?".to_string());
        let pressure = context
            .context_pressure
            .as_ref()
            .filter(|pressure| pressure.level != ContextPressureLevel::Low)
            .map(format_status_pressure);
        format!(
            "{degraded_icon}{indicator} [Mode:{}] {}/{} · {}{} · {} · {} · PULSE:{} · session:{} · {}",
            context.cognitive_mode,
            context.provider,
            context.model,
            context_window,
            pressure
                .as_ref()
                .map(|pressure| format!(" · {pressure}"))
                .unwrap_or_default(),
            token_usage,
            activity,
            context.pulse_health,
            context.session_id,
            timestamp
        )
    }

    pub fn surfaces(&self) -> Vec<&'static str> {
        Screen::all()
            .iter()
            .map(|surface| surface.title())
            .collect()
    }

    pub fn has_active_command(&self) -> bool {
        self.active_command.is_some()
    }

    pub fn interrupt_active_command(&mut self) -> bool {
        let Some(active) = self.active_command.as_mut() else {
            return false;
        };
        let label = active.label.clone();
        let should_announce = if !active.cancel_requested {
            active.cancel_requested = true;
            active.cancel_flag.store(true, Ordering::Relaxed);
            true
        } else {
            false
        };
        if should_announce {
            let message = match active.cancel_behavior {
                CancelBehavior::Standard => format!("cancelling {label}"),
                CancelBehavior::WaitForProviderResponse => {
                    format!("cancelling {label}; waiting for provider response")
                }
            };
            self.append_line(warning(message));
            self.append_blank();
        }
        true
    }

    pub fn poll_active_command(&mut self) {
        let mut events = Vec::new();
        let mut disconnected = false;
        let active_label = self
            .active_command
            .as_ref()
            .map(|active| active.label.clone());

        if let Some(active) = self.active_command.as_mut() {
            loop {
                match active.receiver.try_recv() {
                    Ok(event) => events.push(event),
                    Err(TryRecvError::Empty) => break,
                    Err(TryRecvError::Disconnected) => {
                        disconnected = true;
                        break;
                    }
                }
            }
        }

        let mut terminal_seen = false;
        for event in events {
            terminal_seen |= self.apply_worker_event(event);
        }

        if terminal_seen || disconnected {
            if disconnected && !terminal_seen {
                self.append_line(error_line(format!(
                    "{} stopped without a terminal event",
                    active_label.unwrap_or_else(|| "active command".to_string())
                )));
                self.append_blank();
            }
            self.active_command = None;
        }
    }

    pub fn execute_input(&mut self, client: &MemphisClient) {
        if self.active_command.is_some() {
            if !self.input_buffer.trim().is_empty() {
                self.append_line(warning(
                    "an active command is still running; wait or press Ctrl+C to cancel it",
                ));
                self.append_blank();
            }
            return;
        }

        let raw = self.input_buffer.trim().to_string();
        self.input_buffer.clear();
        self.history_index = None;

        if raw.is_empty() {
            return;
        }

        if self.history.last().map(String::as_str) != Some(raw.as_str()) {
            self.history.push(raw.clone());
        }

        self.append_line(prompt(format!("> {raw}")));

        if let Some(command) = raw.strip_prefix('/') {
            self.execute_command(command, client);
        } else {
            self.start_chat_task(client.clone(), raw);
        }
    }

    pub fn surface_lines(&self, surface: Screen) -> Vec<StyledLine> {
        match surface {
            Screen::Overview => self.render_overview(),
            Screen::Chat => self.render_chat_summary(),
            Screen::Memory => self.render_memory_summary(),
            Screen::Sessions => self.render_sessions_summary(),
            Screen::Vault => self.render_vault_summary(),
            Screen::Cases => self.render_cases_summary(),
            Screen::System => self.render_system_summary(),
        }
    }

    fn start_chat_task(&mut self, client: MemphisClient, prompt_text: String) {
        let session_id = self.chat_session_id.clone();
        let provider = self.chat_provider.clone();
        let model = self.chat_model.clone();
        let cancel_behavior = self.chat_cancel_behavior();
        self.append_line(styled("[Memphis] ".to_string(), LineTone::Plain));
        self.spawn_worker(
            "native chat",
            ActiveCommandKind::NativeChat,
            cancel_behavior,
            move |sender, cancel_flag| {
                let chunk_sender = sender.clone();
                match client.stream_chat_with_cancel(
                    Some(session_id.as_str()),
                    prompt_text.as_str(),
                    provider.as_deref(),
                    model.as_deref(),
                    Arc::clone(&cancel_flag),
                    move |event| {
                        let worker_event = match event {
                            ChatStreamEvent::Text(chunk) => WorkerEvent::ChatChunk {
                                tone: LineTone::Plain,
                                chunk,
                            },
                            ChatStreamEvent::Usage(usage) => WorkerEvent::ChatUsage(usage),
                        };
                        let _ = chunk_sender.send(worker_event);
                    },
                ) {
                    Ok(exchange) => {
                        let _ = sender.send(WorkerEvent::ChatCompleted(exchange));
                    }
                    Err(ClientCommandError::Cancelled) => {
                        let _ = sender.send(WorkerEvent::Cancelled);
                    }
                    Err(ClientCommandError::Message(error)) => {
                        let _ = sender.send(WorkerEvent::Error(error));
                    }
                }
            },
        );
    }

    fn start_extension_host_task(
        &mut self,
        client: MemphisClient,
        request: ExtensionHostCommand,
        kind: ActiveCommandKind,
    ) {
        let label = format!("TS host: {}", request.label);
        self.append_line(dim(format!("[running] {label}")));
        self.spawn_worker(
            label,
            kind,
            CancelBehavior::Standard,
            move |sender, cancel_flag| {
                let line_sender = sender.clone();
                match client.run_extension_command_with_cancel(
                    &request,
                    Arc::clone(&cancel_flag),
                    move |line| {
                        let tone = match line.level {
                            BridgeLineLevel::Info => LineTone::Info,
                            BridgeLineLevel::Warning => LineTone::Warning,
                            BridgeLineLevel::Error => LineTone::Error,
                        };
                        let _ = line_sender.send(WorkerEvent::ChatChunk {
                            tone,
                            chunk: format!("{}\n", line.text),
                        });
                    },
                ) {
                    Ok(result) => {
                        let _ = sender.send(WorkerEvent::HostCompleted(result));
                    }
                    Err(ClientCommandError::Cancelled) => {
                        let _ = sender.send(WorkerEvent::Cancelled);
                    }
                    Err(ClientCommandError::Message(error)) => {
                        let _ = sender.send(WorkerEvent::Error(error));
                    }
                }
            },
        );
    }

    fn execute_command(&mut self, command_line: &str, client: &MemphisClient) {
        let tokens = match split_command_tokens(command_line) {
            Ok(tokens) => tokens,
            Err(error) => {
                self.append_line(error_line(error));
                self.append_blank();
                return;
            }
        };

        if tokens.is_empty() {
            self.append_line(warning("empty command"));
            self.append_blank();
            return;
        }

        match tokens.as_slice() {
            [cmd] if *cmd == "help" => {
                self.append_help();
                self.append_blank();
            }
            [cmd] if *cmd == "clear" => self.clear_output(),
            [cmd] if *cmd == "refresh" => {
                self.refresh(client);
                self.append_line(success("snapshot refreshed"));
                self.append_blank();
            }
            [cmd] if *cmd == "overview" => {
                self.append_lines(self.surface_lines(Screen::Overview));
                self.append_blank();
            }
            [cmd] if *cmd == "memory" => {
                self.append_lines(self.surface_lines(Screen::Memory));
                self.append_blank();
            }
            [cmd] if *cmd == "sessions" => {
                self.append_lines(self.surface_lines(Screen::Sessions));
                self.append_blank();
            }
            [cmd] if *cmd == "vault" => {
                self.append_lines(self.surface_lines(Screen::Vault));
                self.append_blank();
            }
            [cmd] if *cmd == "cases" => {
                self.append_lines(self.surface_lines(Screen::Cases));
                self.append_blank();
            }
            [cmd] if *cmd == "system" => {
                self.append_lines(self.surface_lines(Screen::System));
                self.append_blank();
            }
            [cmd] if *cmd == "telegram" => {
                self.append_lines(self.telegram_status_lines());
                self.append_blank();
            }
            [scope, action] if *scope == "telegram" && *action == "status" => {
                self.append_lines(self.telegram_status_lines());
                self.append_blank();
            }
            [scope, action, rest @ ..] if *scope == "telegram" && *action == "send" => {
                self.start_telegram_send_task(client.clone(), rest);
            }
            [cmd, rest @ ..] if *cmd == "legacy" => {
                if rest.is_empty() {
                    self.append_line(error_line(
                        "legacy requires a memphis CLI command. Use it only as the last-resort escape hatch, e.g. /legacy health",
                    ));
                    self.append_blank();
                } else {
                    self.start_cli_fallback_task(client.clone(), rest.to_vec());
                }
            }
            [cmd] if *cmd == "providers" => {
                self.append_provider_status_rows("Provider status");
                self.append_blank();
            }
            [cmd] if *cmd == "models" => {
                self.append_model_rows();
                self.append_blank();
            }
            [scope, mode, query @ ..] if *scope == "memory" && *mode == "semantic" => {
                self.start_memory_query_task(
                    client.clone(),
                    SearchMode::Semantic,
                    query.join(" ").trim().to_string(),
                );
            }
            [scope, mode, query @ ..] if *scope == "memory" && *mode == "exact" => {
                self.start_memory_query_task(
                    client.clone(),
                    SearchMode::Exact,
                    query.join(" ").trim().to_string(),
                );
            }
            [scope, action, key] if *scope == "vault" && *action == "get" => {
                self.start_vault_read_task(client.clone(), key.to_string());
            }
            [scope, action, name] if *scope == "provider" && *action == "set" => {
                self.chat_provider = Some(name.to_string());
                self.append_line(success(format!("active provider set to {name}")));
                self.append_blank();
            }
            [scope, action, model @ ..] if *scope == "model" && *action == "set" => {
                let model = model.join(" ");
                self.chat_model = Some(model.clone());
                self.append_line(success(format!("active model set to {model}")));
                self.append_blank();
            }
            [cmd, value] if *cmd == "provider" => {
                self.chat_provider = Some(value.to_string());
                self.append_line(success(format!("active provider set to {value}")));
                self.append_blank();
            }
            [cmd, value @ ..] if *cmd == "model" => {
                let model = value.join(" ");
                self.chat_model = Some(model.clone());
                self.append_line(success(format!("active model set to {model}")));
                self.append_blank();
            }
            [cmd, value] if *cmd == "session" => {
                self.switch_session(client, value);
            }
            _ => match extension_host_command_for_tokens(&tokens) {
                Ok(Some((request, kind))) => {
                    self.start_extension_host_task(client.clone(), request, kind)
                }
                Ok(None) => {
                    self.append_line(error_line(unsupported_tui_command_notice(&tokens)));
                    self.append_blank();
                }
                Err(error) => {
                    self.append_line(error_line(error));
                    self.append_blank();
                }
            },
        }
    }

    fn start_memory_query_task(&mut self, client: MemphisClient, mode: SearchMode, query: String) {
        if query.trim().is_empty() {
            self.append_line(error_line("query must not be empty"));
            self.append_blank();
            return;
        }

        let label = match mode {
            SearchMode::Semantic => format!("semantic memory search: {query}"),
            SearchMode::Exact => format!("exact memory search: {query}"),
        };
        self.append_line(dim(format!("[running] {label}")));
        self.spawn_worker(
            label,
            ActiveCommandKind::Generic,
            CancelBehavior::Standard,
            move |sender, cancel_flag| {
                if cancel_flag.load(Ordering::Relaxed) {
                    let _ = sender.send(WorkerEvent::Cancelled);
                    return;
                }

                let result = match mode {
                    SearchMode::Semantic => client.search_semantic(query.trim(), 5),
                    SearchMode::Exact => client.search_exact(query.trim(), 5),
                };

                if cancel_flag.load(Ordering::Relaxed) {
                    let _ = sender.send(WorkerEvent::Cancelled);
                    return;
                }

                match result {
                    Ok(result) => {
                        let _ = sender.send(WorkerEvent::MemoryCompleted(result));
                    }
                    Err(error) => {
                        let _ = sender.send(WorkerEvent::Error(error));
                    }
                }
            },
        );
    }

    fn switch_session(&mut self, client: &MemphisClient, session_id: &str) {
        if session_id.trim().is_empty() {
            self.append_line(error_line("chat session id must not be empty"));
            self.append_blank();
            return;
        }

        self.chat_session_id = session_id.to_string();
        match client.load_chat_session(Some(self.chat_session_id.as_str()), 20) {
            Ok(view) => {
                self.append_line(success(format!(
                    "chat session switched to {}",
                    self.chat_session_id
                )));
                self.append_line(section("Session transcript"));
                if view.messages.is_empty() {
                    self.append_line(dim("No transcript entries yet."));
                } else {
                    for message in view.messages {
                        self.append_transcript_entry(&message);
                    }
                }
                self.append_blank();
            }
            Err(error) => {
                self.append_line(error_line(error));
                self.append_blank();
            }
        }
    }

    fn start_vault_read_task(&mut self, client: MemphisClient, key: String) {
        if key.trim().is_empty() {
            self.append_line(error_line("vault key must not be empty"));
            self.append_blank();
            return;
        }

        self.append_line(dim(format!("[running] vault read: {key}")));
        self.spawn_worker(
            format!("vault read: {key}"),
            ActiveCommandKind::Generic,
            CancelBehavior::Standard,
            move |sender, cancel_flag| {
                if cancel_flag.load(Ordering::Relaxed) {
                    let _ = sender.send(WorkerEvent::Cancelled);
                    return;
                }

                match client.read_vault_secret(key.as_str()) {
                    Ok(secret) => {
                        if cancel_flag.load(Ordering::Relaxed) {
                            let _ = sender.send(WorkerEvent::Cancelled);
                        } else {
                            let _ = sender.send(WorkerEvent::VaultCompleted(secret));
                        }
                    }
                    Err(error) => {
                        let _ = sender.send(WorkerEvent::Error(error));
                    }
                }
            },
        );
    }

    fn start_cli_fallback_task(&mut self, client: MemphisClient, tokens: Vec<String>) {
        let label = format!("legacy CLI: {}", tokens.join(" "));
        self.start_cli_fallback_task_with_kind(client, tokens, label, ActiveCommandKind::Generic);
    }

    fn start_cli_fallback_task_with_kind(
        &mut self,
        client: MemphisClient,
        tokens: Vec<String>,
        label: String,
        kind: ActiveCommandKind,
    ) {
        self.append_line(warning(legacy_cli_fallback_notice(&tokens)));
        self.append_line(dim(format!("[running] {label}")));
        self.spawn_worker(
            label,
            kind,
            CancelBehavior::Standard,
            move |sender, cancel_flag| match client
                .run_cli_command_with_cancel(&tokens, Arc::clone(&cancel_flag))
            {
                Ok(result) => {
                    let _ = sender.send(WorkerEvent::CliCompleted(result));
                }
                Err(ClientCommandError::Cancelled) => {
                    let _ = sender.send(WorkerEvent::Cancelled);
                }
                Err(ClientCommandError::Message(error)) => {
                    let _ = sender.send(WorkerEvent::Error(error));
                }
            },
        );
    }

    fn start_telegram_send_task(&mut self, client: MemphisClient, rest: &[String]) {
        if rest.is_empty() {
            self.append_line(error_line("telegram send requires a message"));
            self.append_blank();
            return;
        }

        let mut chat_id: Option<String> = None;
        let mut message_parts = Vec::new();
        let mut index = 0usize;
        while index < rest.len() {
            if rest[index] == "--to" {
                let Some(value) = rest.get(index + 1) else {
                    self.append_line(error_line("telegram send --to requires a chat id"));
                    self.append_blank();
                    return;
                };
                chat_id = Some(value.clone());
                index += 2;
                continue;
            }
            message_parts.push(rest[index].clone());
            index += 1;
        }

        let message = message_parts.join(" ").trim().to_string();
        if message.is_empty() {
            self.append_line(error_line("telegram send requires a message"));
            self.append_blank();
            return;
        }

        let target_chat = chat_id.clone();
        let label = target_chat
            .as_deref()
            .map(|chat_id| format!("telegram send to {chat_id}"))
            .unwrap_or_else(|| "telegram send".to_string());
        self.start_extension_host_task(
            client,
            ExtensionHostCommand {
                label,
                command: "telegram.send".to_string(),
                args: json!({
                    "message": message,
                    "chatId": target_chat,
                }),
            },
            ActiveCommandKind::TelegramSend { target_chat },
        );
    }

    fn spawn_worker<F>(
        &mut self,
        label: impl Into<String>,
        kind: ActiveCommandKind,
        cancel_behavior: CancelBehavior,
        run: F,
    ) where
        F: FnOnce(Sender<WorkerEvent>, Arc<AtomicBool>) + Send + 'static,
    {
        let label = label.into();
        let (sender, receiver) = mpsc::channel();
        let cancel_flag = Arc::new(AtomicBool::new(false));
        let _task_id = self.next_task_id;
        self.next_task_id += 1;
        if matches!(kind, ActiveCommandKind::NativeChat) {
            self.live_token_usage = None;
            self.live_output_chars = Some(0);
        }
        self.active_command = Some(ActiveCommand {
            label: label.clone(),
            cancel_flag: Arc::clone(&cancel_flag),
            receiver,
            cancel_requested: false,
            cancel_behavior,
            kind,
        });
        thread::spawn(move || run(sender, cancel_flag));
    }

    fn apply_worker_event(&mut self, event: WorkerEvent) -> bool {
        match event {
            WorkerEvent::ChatChunk { tone, chunk } => {
                if self.active_native_chat_running() {
                    let next_chars = self
                        .live_output_chars
                        .unwrap_or(0)
                        .saturating_add(chunk.chars().count());
                    self.live_output_chars = Some(next_chars);
                }
                self.append_stream_chunk(tone, chunk.as_str());
                false
            }
            WorkerEvent::ChatUsage(usage) => {
                self.live_token_usage = Some(usage);
                false
            }
            WorkerEvent::ChatCompleted(exchange) => {
                self.chat_session_id = exchange.session_id;
                self.chat_provider = Some(exchange.provider.clone());
                self.chat_model = Some(exchange.model.clone());
                self.last_token_usage =
                    exchange.token_usage.clone().or_else(|| self.live_token_usage.clone());
                self.live_token_usage = None;
                self.live_output_chars = None;
                if exchange.degraded {
                    self.degradation = Some(DegradationState {
                        active: true,
                        tier: 2,
                        original_provider: String::new(),
                        actual_provider: exchange.provider.clone(),
                        reason: exchange.degradation_reason.clone().unwrap_or_default(),
                    });
                }
                self.append_blank();
                self.append_line(success(format!(
                    "reply complete via {} / {}{}",
                    exchange.provider,
                    exchange.model,
                    exchange
                        .token_usage
                        .as_ref()
                        .map(|usage| format!(" · {}", format_full_token_usage(usage)))
                        .unwrap_or_default()
                )));
                self.append_blank();
                true
            }
            WorkerEvent::DegradationUpdate {
                active,
                tier,
                original_provider,
                actual_provider,
                reason,
            } => {
                if active {
                    self.degradation = Some(DegradationState {
                        active: true,
                        tier,
                        original_provider,
                        actual_provider,
                        reason: reason.unwrap_or_default(),
                    });
                } else {
                    self.degradation = None;
                }
                false
            }
            WorkerEvent::MemoryCompleted(result) => {
                self.append_memory_result(&result);
                self.append_blank();
                true
            }
            WorkerEvent::VaultCompleted(secret) => {
                self.append_line(section("Vault secret"));
                self.append_line(plain(format!("Key: {}", secret.key)));
                self.append_line(plain(format!("Created at: {}", secret.created_at)));
                self.append_line(warning(format!("Plaintext: {}", secret.plaintext)));
                self.append_blank();
                true
            }
            WorkerEvent::HostCompleted(result) => {
                self.append_extension_host_result(result);
                self.append_blank();
                true
            }
            WorkerEvent::CliCompleted(result) => {
                self.append_cli_result(result);
                self.append_blank();
                true
            }
            WorkerEvent::Error(error) => {
                if self.active_native_chat_running() {
                    self.live_token_usage = None;
                    self.live_output_chars = None;
                }
                if let Some(target_chat) = self.active_telegram_target() {
                    self.append_telegram_send_failure(target_chat, error);
                } else {
                    self.append_active_command_error(error.as_str());
                }
                self.append_blank();
                true
            }
            WorkerEvent::Cancelled => {
                if self.active_native_chat_running() {
                    self.live_token_usage = None;
                    self.live_output_chars = None;
                }
                if let Some(target_chat) = self.active_telegram_target() {
                    self.append_telegram_send_cancelled(target_chat);
                } else {
                    let label = self
                        .active_command
                        .as_ref()
                        .map(|active| active.label.clone())
                        .unwrap_or_else(|| "active command".to_string());
                    self.append_line(warning(format!("{label} cancelled")));
                }
                self.append_blank();
                true
            }
        }
    }

    fn append_help(&mut self) {
        self.append_line(section("Commands"));
        for entry in HELP_ENTRIES
            .iter()
            .filter(|entry| entry.route != CommandRoute::Legacy)
        {
            self.append_line(accent(entry.display));
        }
        self.append_line(accent("plain text -> live chat"));
        self.append_blank();
        self.append_line(section("Emergency compatibility"));
        self.append_line(warning(
            "/legacy <memphis cli args...> — explicit last-resort CLI escape hatch",
        ));
        self.append_line(dim(
            "Host-backed TS commands are standard. Unknown slash commands fail closed. Use /legacy only when you intentionally need the one-shot CLI compatibility path.",
        ));
    }

    fn append_active_command_error(&mut self, error: &str) {
        let active = self
            .active_command
            .as_ref()
            .map(|active| (active.label.clone(), active.kind.clone()));
        let Some((label, kind)) = active else {
            self.append_line(error_line(error));
            return;
        };

        match kind {
            ActiveCommandKind::TelegramSend { .. } => self.append_line(error_line(error)),
            ActiveCommandKind::Generic if label.starts_with("TS host: ") => {
                self.append_host_command_error(label.as_str(), error);
            }
            ActiveCommandKind::Generic if label.starts_with("legacy CLI: ") => {
                self.append_legacy_cli_error(label.as_str(), error);
            }
            ActiveCommandKind::Generic | ActiveCommandKind::NativeChat => {
                self.append_line(error_line(error))
            }
        }
    }

    fn append_host_command_error(&mut self, label: &str, error: &str) {
        let (status, detail, stderr_lines, reset_hint) = summarize_host_command_error(error);
        self.append_line(section(label.to_string()));
        self.append_line(error_line(status));
        if let Some(detail) = detail {
            self.append_line(dim(detail));
        }
        if reset_hint {
            self.append_line(dim("Host session reset; rerun the command if needed."));
        }
        for line in stderr_lines.into_iter().take(3) {
            self.append_line(dim(format!("stderr: {line}")));
        }
    }

    fn append_legacy_cli_error(&mut self, label: &str, error: &str) {
        let command = label
            .strip_prefix("legacy CLI: ")
            .unwrap_or(label)
            .trim()
            .to_string();
        self.append_line(section("Legacy CLI compatibility"));
        self.append_line(error_line("Status: compatibility command failed"));
        self.append_line(dim(format!("Command: {command}")));
        for line in error
            .lines()
            .map(str::trim)
            .filter(|line| !line.is_empty())
            .take(3)
        {
            self.append_line(dim(line.to_string()));
        }
    }

    fn append_memory_result(&mut self, result: &MemoryQueryResult) {
        self.append_line(section(match result.mode {
            SearchMode::Semantic => "Semantic memory search",
            SearchMode::Exact => "Exact memory search",
        }));
        self.append_line(info(format!("Query: {}", result.query)));
        self.append_line(info(format!("Hits: {}", result.count)));
        match result.mode {
            SearchMode::Semantic => {
                for hit in &result.semantic_hits {
                    self.append_line(plain(format!(
                        "- {} score={:.3} tags={} preview={}",
                        hit.id,
                        hit.score,
                        if hit.tags.is_empty() {
                            "-".to_string()
                        } else {
                            hit.tags.join(",")
                        },
                        hit.preview
                    )));
                }
            }
            SearchMode::Exact => {
                for hit in &result.exact_hits {
                    self.append_line(plain(format!(
                        "- {}:{} type={} score={:.3} {}",
                        hit.chain, hit.block_index, hit.block_type, hit.score, hit.snippet
                    )));
                }
            }
        }
    }

    fn append_cli_result(&mut self, result: CliBridgeResult) {
        if self.is_telegram_send_result(&result) {
            self.append_telegram_send_result(result);
            return;
        }

        self.append_line(section(format!(
            "Legacy CLI compatibility: {}",
            result.command_label
        )));
        if let Some(json) = result.json {
            if let Ok(pretty) = serde_json::to_string_pretty(&json) {
                for line in pretty.lines() {
                    self.append_line(plain(line.to_string()));
                }
            } else {
                self.append_line(error_line("failed to pretty-print CLI JSON output"));
            }
            return;
        }

        if result.stdout.trim().is_empty() {
            self.append_line(dim("command produced no output"));
            return;
        }

        for line in result.stdout.lines() {
            self.append_line(plain(line.to_string()));
        }
    }

    fn append_extension_host_result(&mut self, result: ExtensionHostResult) {
        match result.command.as_str() {
            "telegram.send" => self.append_telegram_send_host_result(result.data),
            "init.status" => self.append_init_status_host_result(result.data),
            "health.status" => self.append_health_host_result(result.data),
            "doctor.run" => self.append_doctor_host_result(result.data),
            "agents.list" | "agents.discover" => self.append_agents_host_result(result.data),
            "agents.show" => self.append_agent_show_host_result(result.data),
            "sync.status" => self.append_sync_status_host_result(result.data),
            "apps.list" => self.append_apps_list_host_result(result.data),
            "apps.show" => self.append_apps_show_host_result(result.data),
            "apps.plan" => self.append_apps_plan_host_result(result.data),
            "reflect.run" => self.append_reflect_host_result(result.data),
            "insights.run" => self.append_insights_host_result(result.data),
            "knowledge.status" => self.append_knowledge_status_host_result(result.data),
            "knowledge.query" => self.append_knowledge_query_host_result(result.data),
            "config.tools.list" => self.append_config_tools_list_host_result(result.data),
            "config.tools.check" => self.append_config_tools_check_host_result(result.data),
            "config.tools.pending" => self.append_config_tools_pending_host_result(result.data),
            "config.surfaces.list" => self.append_config_surfaces_list_host_result(result.data),
            "config.surfaces.check" => self.append_config_surfaces_check_host_result(result.data),
            "config.surfaces.set" => self.append_config_surfaces_set_host_result(result.data),
            "config.surfaces.reset" => self.append_config_surfaces_reset_host_result(result.data),
            "pulse.status" => self.append_pulse_status_host_result(result.data),
            "cognitive.mode" => self.append_cognitive_mode_host_result(result.data),
            _ => self.append_generic_extension_host_result(result),
        }
    }

    fn append_generic_extension_host_result(&mut self, result: ExtensionHostResult) {
        self.append_line(section(format!("TS host: {}", result.command)));
        if let Ok(pretty) = serde_json::to_string_pretty(&result.data) {
            for line in pretty.lines() {
                self.append_line(plain(line.to_string()));
            }
        } else {
            self.append_line(error_line("failed to pretty-print extension host result"));
        }
    }

    fn append_doctor_host_result(&mut self, data: Value) {
        self.append_line(section("Doctor"));

        let ok = data.get("ok").and_then(Value::as_bool).unwrap_or(false);
        let summary = data.get("summary").and_then(Value::as_object);
        let pass = summary
            .and_then(|summary| summary.get("pass"))
            .and_then(Value::as_u64)
            .unwrap_or(0);
        let warn = summary
            .and_then(|summary| summary.get("warn"))
            .and_then(Value::as_u64)
            .unwrap_or(0);
        let fail = summary
            .and_then(|summary| summary.get("fail"))
            .and_then(Value::as_u64)
            .unwrap_or(0);
        let required_failures = summary
            .and_then(|summary| summary.get("requiredFailures"))
            .and_then(Value::as_u64)
            .unwrap_or(0);
        let repair_status = json_value_as_string(data.get("repairStatus"))
            .unwrap_or_else(|| "unknown".to_string());
        let repairable = data
            .get("repairable")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let recommended_action = json_value_as_string(data.get("recommendedAction"))
            .unwrap_or_else(|| "none".to_string());

        self.append_line(if ok {
            success("Status: ok")
        } else if fail > 0 || required_failures > 0 {
            error_line("Status: required checks need attention")
        } else {
            warning("Status: warnings detected")
        });
        self.append_line(info(format!(
            "Summary: pass={pass} warn={warn} fail={fail} required_failures={required_failures}"
        )));
        self.append_line(info(format!(
            "Repair: status={} repairable={} action={}",
            repair_status,
            if repairable { "yes" } else { "no" },
            recommended_action
        )));

        let mut highlighted = 0usize;
        if let Some(checks) = data.get("checks").and_then(Value::as_array) {
            for check in checks
                .iter()
                .filter(|check| check.get("level").and_then(Value::as_str) != Some("pass"))
                .take(8)
            {
                let id =
                    json_value_as_string(check.get("id")).unwrap_or_else(|| "unknown".to_string());
                let level =
                    json_value_as_string(check.get("level")).unwrap_or_else(|| "info".to_string());
                let detail = json_value_as_string(check.get("detail"))
                    .unwrap_or_else(|| "no detail".to_string());
                let tone = match level.as_str() {
                    "fail" => LineTone::Error,
                    "warn" => LineTone::Warning,
                    _ => LineTone::Plain,
                };
                self.append_line(styled(format!("- {} :: {}", id, detail), tone));
                highlighted += 1;
            }
        }

        if highlighted == 0 {
            self.append_line(dim("No failing or warning checks were reported."));
        }
    }

    fn append_init_status_host_result(&mut self, data: Value) {
        self.append_line(section("First run"));

        let state = data
            .get("state")
            .and_then(Value::as_str)
            .unwrap_or("unknown");
        let initialized = data
            .get("initialized")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let recommended_action = json_value_as_string(data.get("recommendedAction"))
            .unwrap_or_else(|| "none".to_string());
        let record_origin = data
            .get("record")
            .and_then(Value::as_object)
            .and_then(|record| record.get("origin"))
            .and_then(Value::as_str)
            .unwrap_or("none");

        let tone = if initialized && state == "initialized-clean" {
            LineTone::Success
        } else if state == "legacy-manual" {
            LineTone::Error
        } else {
            LineTone::Warning
        };

        self.append_line(styled(
            format!("State: {} (origin: {})", state, record_origin),
            tone,
        ));
        self.append_line(info(format!("Recommended action: {}", recommended_action)));

        if let Some(reasons) = data.get("reasons").and_then(Value::as_array) {
            if !reasons.is_empty() {
                self.append_line(info("Reasons:".to_string()));
                for reason in reasons {
                    if let Some(text) = reason.as_str() {
                        self.append_line(dim(format!("- {}", text)));
                    }
                }
            }
        }
    }

    fn append_health_host_result(&mut self, data: Value) {
        self.append_line(section("Health"));

        let status = json_value_as_string(data.get("status")).unwrap_or_else(|| "unknown".to_string());
        let runtime_status = json_value_as_string(data.get("runtimeStatus"))
            .unwrap_or_else(|| status.clone());
        let runtime = data.get("runtime").and_then(Value::as_object);
        let memory = runtime.and_then(|runtime| runtime.get("memory")).and_then(Value::as_object);
        let embeddings = runtime
            .and_then(|runtime| runtime.get("embeddings"))
            .and_then(Value::as_object);
        let exact_search = runtime
            .and_then(|runtime| runtime.get("exactSearch"))
            .and_then(Value::as_object);
        let cognition = runtime
            .and_then(|runtime| runtime.get("cognition"))
            .and_then(Value::as_object);
        let repair = runtime
            .and_then(|runtime| runtime.get("repair"))
            .and_then(Value::as_object);

        let recall_mode = memory
            .and_then(|memory| memory.get("recallMode"))
            .and_then(Value::as_str)
            .unwrap_or("unknown");
        let degraded = memory
            .and_then(|memory| memory.get("degraded"))
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let embeddings_status = embeddings
            .and_then(|embeddings| embeddings.get("status"))
            .and_then(Value::as_str)
            .unwrap_or("unknown");
        let exact_status = exact_search
            .and_then(|exact_search| exact_search.get("status"))
            .and_then(Value::as_str)
            .unwrap_or("unknown");
        let cognitive_persistence = cognition
            .and_then(|cognition| cognition.get("persistenceStatus"))
            .and_then(Value::as_str)
            .unwrap_or("unknown");
        let repair_status = repair
            .and_then(|repair| repair.get("status"))
            .and_then(Value::as_str)
            .unwrap_or("unknown");
        let repair_action = json_value_as_string(data.get("recommendedAction"))
            .or_else(|| {
                json_value_as_string(repair.and_then(|repair| repair.get("recommendedAction")))
            })
            .unwrap_or_else(|| "none".to_string());

        let tone = if (status == "ok" && runtime_status == "healthy") || status == "healthy" {
            LineTone::Success
        } else if degraded || recall_mode != "semantic" {
            LineTone::Warning
        } else {
            LineTone::Error
        };

        self.append_line(styled(
            format!("Status: {} / runtime {}", status, runtime_status),
            tone,
        ));
        self.append_line(info(format!(
            "Memory recall: {}{}",
            recall_mode,
            if degraded { " (degraded)" } else { "" }
        )));
        self.append_line(info(format!("Embeddings: {}", embeddings_status)));
        self.append_line(info(format!("Exact search: {}", exact_status)));
        self.append_line(info(format!(
            "Cognitive persistence: {}",
            cognitive_persistence
        )));
        self.append_line(info(format!(
            "Repair: {} -> {}",
            repair_status, repair_action
        )));
    }

    fn append_agents_host_result(&mut self, data: Value) {
        let heading = match data.get("mode").and_then(Value::as_str) {
            Some("agents-discover") => "Agents discover",
            _ => "Agents list",
        };
        self.append_line(section(heading));

        let agents = data
            .get("agents")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let count = data
            .get("count")
            .and_then(Value::as_u64)
            .unwrap_or(agents.len() as u64);
        self.append_line(info(format!("Count: {count}")));

        if agents.is_empty() {
            self.append_line(dim("No agents reported."));
            return;
        }

        for agent in agents.iter().take(10) {
            let did =
                json_value_as_string(agent.get("did")).unwrap_or_else(|| "unknown".to_string());
            let name = json_value_as_string(agent.get("name")).unwrap_or_else(|| did.clone());
            let status =
                json_value_as_string(agent.get("status")).unwrap_or_else(|| "unknown".to_string());
            let endpoint = json_value_as_string(agent.get("endpoint"))
                .unwrap_or_else(|| "missing endpoint".to_string());
            let tone = match status.as_str() {
                "online" => LineTone::Success,
                "offline" => LineTone::Error,
                _ => LineTone::Warning,
            };
            self.append_line(styled(
                format!("- {name} ({did}) :: {status} :: {endpoint}"),
                tone,
            ));

            let capabilities = json_string_list(agent.get("capabilities"));
            if !capabilities.is_empty() {
                self.append_line(dim(format!("  caps: {}", capabilities.join(", "))));
            }
        }
    }

    fn append_agent_show_host_result(&mut self, data: Value) {
        self.append_line(section("Agent"));
        let Some(agent) = data.get("agent") else {
            self.append_line(error_line(
                "Agent payload was missing the expected agent object.",
            ));
            return;
        };

        let did = json_value_as_string(agent.get("did")).unwrap_or_else(|| "unknown".to_string());
        let name = json_value_as_string(agent.get("name")).unwrap_or_else(|| did.clone());
        let reputation = json_value_as_string(agent.get("reputation"));
        let last_seen = json_value_as_string(agent.get("lastSeen"));

        self.append_line(plain(format!("DID: {did}")));
        self.append_line(info(format!("Name: {name}")));
        if let Some(reputation) = reputation {
            self.append_line(info(format!("Reputation: {reputation}")));
        }
        if let Some(last_seen) = last_seen {
            self.append_line(dim(format!("Last seen: {last_seen}")));
        }
    }

    fn append_sync_status_host_result(&mut self, data: Value) {
        self.append_line(section("Sync status"));
        let chain =
            json_value_as_string(data.get("chain")).unwrap_or_else(|| "journal".to_string());
        let local_blocks = data.get("localBlocks").and_then(Value::as_u64).unwrap_or(0);
        let agents_known = data.get("agentsKnown").and_then(Value::as_u64).unwrap_or(0);
        let agents_online = data
            .get("agentsOnline")
            .and_then(Value::as_u64)
            .unwrap_or(0);

        self.append_line(plain(format!("Chain: {chain}")));
        self.append_line(info(format!("Local blocks: {local_blocks}")));
        self.append_line(info(format!(
            "Agents: known={agents_known} online={agents_online}"
        )));
        if let Some(updated_at) = json_value_as_string(data.get("updatedAt")) {
            self.append_line(dim(format!("Updated: {updated_at}")));
        }
    }

    fn append_apps_list_host_result(&mut self, data: Value) {
        self.append_line(section("Managed apps"));
        let manifests = data
            .get("manifests")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        self.append_line(info(format!("Manifests: {}", manifests.len())));

        if manifests.is_empty() {
            self.append_line(dim("No managed app manifests discovered."));
        } else {
            for manifest in manifests.iter().take(10) {
                let id = json_value_as_string(manifest.get("id"))
                    .unwrap_or_else(|| "unknown".to_string());
                let name = json_value_as_string(manifest.get("name")).unwrap_or_else(|| id.clone());
                let source_kind = manifest
                    .get("source")
                    .and_then(|value| value.get("kind"))
                    .and_then(Value::as_str)
                    .unwrap_or("unknown");
                let actions = json_string_list(manifest.get("actions"));
                let capabilities = json_string_list(manifest.get("capabilities"));
                self.append_line(plain(format!(
                    "- {id} :: {name} [{source_kind}] actions={} caps={}",
                    if actions.is_empty() {
                        "-".to_string()
                    } else {
                        actions.join(", ")
                    },
                    if capabilities.is_empty() {
                        "-".to_string()
                    } else {
                        capabilities.join(", ")
                    }
                )));
            }
        }

        let manifest_errors = data
            .get("manifestErrors")
            .and_then(Value::as_array)
            .map(|errors| errors.len())
            .unwrap_or(0);
        if manifest_errors > 0 {
            self.append_line(warning(format!(
                "Manifest errors: {manifest_errors} (inspect CLI JSON for full details)"
            )));
        }
    }

    fn append_apps_show_host_result(&mut self, data: Value) {
        self.append_line(section("Managed app"));
        let Some(manifest) = data.get("manifest") else {
            self.append_line(error_line(
                "Managed app payload was missing the manifest object.",
            ));
            return;
        };

        let id = json_value_as_string(manifest.get("id")).unwrap_or_else(|| "unknown".to_string());
        let name = json_value_as_string(manifest.get("name")).unwrap_or_else(|| id.clone());
        let description = json_value_as_string(manifest.get("description"));
        let actions = json_string_list(manifest.get("actions"));
        let capabilities = json_string_list(manifest.get("capabilities"));

        self.append_line(plain(format!("{name} ({id})")));
        if let Some(description) = description {
            self.append_line(dim(description));
        }
        self.append_line(info(format!(
            "Actions: {}",
            if actions.is_empty() {
                "-".to_string()
            } else {
                actions.join(", ")
            }
        )));
        self.append_line(info(format!(
            "Capabilities: {}",
            if capabilities.is_empty() {
                "-".to_string()
            } else {
                capabilities.join(", ")
            }
        )));
    }

    fn append_apps_plan_host_result(&mut self, data: Value) {
        self.append_line(section("Managed app plan"));
        let manifest = data.get("manifest");
        let app_name = manifest
            .and_then(|value| value.get("name"))
            .and_then(Value::as_str)
            .unwrap_or("unknown");
        let app_id = manifest
            .and_then(|value| value.get("id"))
            .and_then(Value::as_str)
            .unwrap_or("unknown");
        let action =
            json_value_as_string(data.get("action")).unwrap_or_else(|| "install".to_string());
        self.append_line(plain(format!("{app_name} ({app_id}) :: {action}")));

        if let Some(summary) = json_value_as_string(data.get("summary")) {
            self.append_line(dim(summary));
        }
        self.append_line(info(format!(
            "applyRequested={} willExecute={}",
            data.get("applyRequested")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            data.get("willExecute")
                .and_then(Value::as_bool)
                .unwrap_or(false)
        )));

        if let Some(requirements) = data.get("requirements").and_then(Value::as_array) {
            for requirement in requirements.iter().take(8) {
                let status = json_value_as_string(requirement.get("status"))
                    .unwrap_or_else(|| "unknown".to_string());
                let id = json_value_as_string(requirement.get("id"))
                    .unwrap_or_else(|| "requirement".to_string());
                let detail = json_value_as_string(requirement.get("detail"))
                    .unwrap_or_else(|| "no detail".to_string());
                let tone = match status.as_str() {
                    "pass" => LineTone::Success,
                    "warn" => LineTone::Warning,
                    _ => LineTone::Error,
                };
                self.append_line(styled(format!("- {id} :: {detail}"), tone));
            }
        }

        if let Some(steps) = data.get("steps").and_then(Value::as_array) {
            for (index, step) in steps.iter().take(8).enumerate() {
                if let Some(step) = step.as_str() {
                    self.append_line(plain(format!("Step {}: {step}", index + 1)));
                }
            }
        }
    }

    fn append_reflect_host_result(&mut self, data: Value) {
        self.append_line(section("Reflect"));
        let count = data.get("count").and_then(Value::as_u64).unwrap_or(0);
        self.append_line(info(format!("Count: {count}")));
        self.append_line(dim(format!(
            "Saved: {}",
            yes_no(data.get("saved").and_then(Value::as_bool).unwrap_or(false))
        )));

        let reflections = data
            .get("reflections")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        if reflections.is_empty() {
            self.append_line(dim("No reflections generated."));
            return;
        }

        for reflection in reflections.iter().take(5) {
            let reflection_type = json_value_as_string(reflection.get("type"))
                .unwrap_or_else(|| "reflection".to_string());
            let subject = json_value_as_string(reflection.get("subject"))
                .unwrap_or_else(|| "untitled".to_string());
            let insight = reflection
                .get("insights")
                .and_then(Value::as_array)
                .and_then(|insights| insights.first())
                .and_then(Value::as_str)
                .unwrap_or("no insight");
            self.append_line(plain(format!(
                "- {reflection_type} :: {subject} :: {insight}"
            )));
        }
    }

    fn append_insights_host_result(&mut self, data: Value) {
        self.append_line(section("Insights"));
        let window =
            json_value_as_string(data.get("window")).unwrap_or_else(|| "daily".to_string());
        let count = data.get("count").and_then(Value::as_u64).unwrap_or(0);
        self.append_line(info(format!("Window: {window}")));
        self.append_line(info(format!("Count: {count}")));
        self.append_line(dim(format!(
            "Saved: {}",
            yes_no(data.get("saved").and_then(Value::as_bool).unwrap_or(false))
        )));

        let insights = data
            .get("insights")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        if insights.is_empty() {
            self.append_line(dim("No insights generated."));
            return;
        }

        for insight in insights.iter().take(5) {
            let insight_type =
                json_value_as_string(insight.get("type")).unwrap_or_else(|| "insight".to_string());
            let title = json_value_as_string(insight.get("title"))
                .unwrap_or_else(|| "untitled".to_string());
            let description = json_value_as_string(insight.get("description"))
                .unwrap_or_else(|| "no description".to_string());
            self.append_line(plain(format!(
                "- {insight_type} :: {title} :: {description}"
            )));
        }
    }

    fn append_knowledge_status_host_result(&mut self, data: Value) {
        self.append_line(section("Knowledge sources"));
        let summary = data.get("summary").and_then(Value::as_object);
        let loaded = summary
            .and_then(|summary| summary.get("loaded"))
            .and_then(Value::as_u64)
            .unwrap_or(0);
        let missing_optional = summary
            .and_then(|summary| summary.get("missingOptional"))
            .and_then(Value::as_u64)
            .unwrap_or(0);
        let missing_required = summary
            .and_then(|summary| summary.get("missingRequired"))
            .and_then(Value::as_u64)
            .unwrap_or(0);
        self.append_line(info(format!(
            "Loaded: {loaded} :: missing_optional={missing_optional} :: missing_required={missing_required}"
        )));

        let sources = data
            .get("sources")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        if sources.is_empty() {
            self.append_line(dim("No knowledge sources registered."));
            return;
        }

        for source in sources.iter().take(6) {
            let source_id =
                json_value_as_string(source.get("id")).unwrap_or_else(|| "unknown".to_string());
            let available = source
                .get("available")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let optional = source
                .get("optional")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let state = if available { "loaded" } else { "missing" };
            self.append_line(plain(format!(
                "- {source_id} :: {state} :: optional={}",
                yes_no(optional)
            )));
            if let Some(path) = json_value_as_string(source.get("path")) {
                self.append_line(dim(format!("  {path}")));
            }
            if available {
                let section_count = source
                    .get("sectionCount")
                    .and_then(Value::as_u64)
                    .unwrap_or(0);
                self.append_line(dim(format!("  sections: {section_count}")));
            } else if let Some(warning) = json_value_as_string(source.get("warning")) {
                self.append_line(dim(format!("  warning: {warning}")));
            }
        }
    }

    fn append_knowledge_query_host_result(&mut self, data: Value) {
        self.append_line(section("Knowledge"));
        let topic =
            json_value_as_string(data.get("topic")).unwrap_or_else(|| "unknown".to_string());
        let hit_count = data
            .get("hits")
            .and_then(Value::as_array)
            .map(|hits| hits.len())
            .unwrap_or(0);
        self.append_line(info(format!("Topic: {topic}")));
        self.append_line(info(format!("Hits: {hit_count}")));
        if let Some(source) = json_value_as_string(data.get("source")) {
            self.append_line(dim(format!("Source filter: {source}")));
        }

        let hits = data
            .get("hits")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        if hits.is_empty() {
            self.append_line(dim("No knowledge hits."));
            return;
        }

        for hit in hits.iter().take(5) {
            let source_id =
                json_value_as_string(hit.get("sourceId")).unwrap_or_else(|| "unknown".to_string());
            let section =
                json_value_as_string(hit.get("section")).unwrap_or_else(|| "untitled".to_string());
            let snippet = json_value_as_string(hit.get("snippet"))
                .unwrap_or_else(|| "no snippet".to_string());
            self.append_line(plain(format!("- {source_id} :: {section}")));
            self.append_line(dim(format!("  {snippet}")));
        }
    }

    fn append_config_tools_list_host_result(&mut self, data: Value) {
        self.append_line(section("Config tools list"));
        let tools = data
            .get("tools")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        self.append_line(info(format!("Rules: {}", tools.len())));

        if tools.is_empty() {
            self.append_line(dim(
                "No explicit tool permission rules. Default allow applies.",
            ));
            return;
        }

        for tool in tools.iter().take(10) {
            let name = json_value_as_string(tool.get("tool_name"))
                .unwrap_or_else(|| "unknown".to_string());
            let policy =
                json_value_as_string(tool.get("policy")).unwrap_or_else(|| "unknown".to_string());
            let updated_at = json_value_as_string(tool.get("updated_at"));
            self.append_line(plain(format!("- {name} :: {policy}")));
            if let Some(updated_at) = updated_at {
                self.append_line(dim(format!("  updated: {updated_at}")));
            }
        }
    }

    fn append_config_tools_check_host_result(&mut self, data: Value) {
        self.append_line(section("Config tools check"));
        let tool = json_value_as_string(data.get("tool")).unwrap_or_else(|| "unknown".to_string());
        let policy =
            json_value_as_string(data.get("policy")).unwrap_or_else(|| "allow".to_string());
        let allowed = data
            .get("allowed")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        self.append_line(if allowed {
            success(format!("{tool} :: allowed ({policy})"))
        } else {
            warning(format!("{tool} :: blocked ({policy})"))
        });
        if let Some(reason) = json_value_as_string(data.get("reason")) {
            self.append_line(dim(format!("Reason: {reason}")));
        }
    }

    fn append_config_tools_pending_host_result(&mut self, data: Value) {
        self.append_line(section("Config tools pending"));
        let pending = data
            .get("pending")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        self.append_line(info(format!("Pending approvals: {}", pending.len())));

        if pending.is_empty() {
            self.append_line(dim("No pending tool approvals."));
            return;
        }

        for item in pending.iter().take(10) {
            let request_id = json_value_as_string(item.get("requestId"))
                .unwrap_or_else(|| "unknown-request".to_string());
            let tool_name = json_value_as_string(item.get("toolName"))
                .unwrap_or_else(|| "unknown-tool".to_string());
            let state =
                json_value_as_string(item.get("state")).unwrap_or_else(|| "pending".to_string());
            self.append_line(plain(format!("- {tool_name} :: {state} :: {request_id}")));
        }
    }

    fn append_surface_policy_summary_line(&mut self, policy: &Value) {
        let surface =
            json_value_as_string(policy.get("surface")).unwrap_or_else(|| "unknown".to_string());
        let surface_class = json_value_as_string(policy.get("surfaceClass"))
            .unwrap_or_else(|| "unknown".to_string());
        let tier =
            json_value_as_string(policy.get("maxToolTier")).unwrap_or_else(|| "0".to_string());
        let allow_url_fetch = policy
            .get("allowUrlFetch")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let allow_unknown_tools = policy
            .get("allowUnknownTools")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let allow_memory_recall = policy
            .get("allowMemoryRecall")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let allow_memory_write = policy
            .get("allowMemoryWrite")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let allow_operator_override = policy
            .get("allowOperatorOverride")
            .and_then(Value::as_bool)
            .unwrap_or(false);

        let tone = if surface_class == "chat"
            && (tier != "0" || allow_url_fetch || allow_unknown_tools || allow_operator_override)
        {
            LineTone::Warning
        } else if surface_class == "operator" {
            LineTone::Success
        } else {
            LineTone::Plain
        };

        self.append_line(styled(
            format!(
                "- {surface} :: class={surface_class} tier={tier} fetch={} recall={} write={} unknown={} override={}",
                yes_no(allow_url_fetch),
                yes_no(allow_memory_recall),
                yes_no(allow_memory_write),
                yes_no(allow_unknown_tools),
                yes_no(allow_operator_override)
            ),
            tone,
        ));
    }

    fn append_surface_policy_overrides(&mut self, data: &Value) {
        let overrides = data
            .get("overrides")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        if overrides.is_empty() {
            self.append_line(dim("Overrides: none"));
            return;
        }

        self.append_line(info(format!("Overrides: {}", overrides.len())));
        for override_item in overrides.iter().take(8) {
            let setting = json_value_as_string(override_item.get("setting"))
                .unwrap_or_else(|| "unknown".to_string());
            let raw_value = json_value_as_string(override_item.get("rawValue"))
                .unwrap_or_else(|| "unknown".to_string());
            self.append_line(dim(format!("- {setting}={raw_value}")));
        }
    }

    fn append_config_surfaces_list_host_result(&mut self, data: Value) {
        self.append_line(section("Config surfaces list"));
        let surfaces = data
            .get("surfaces")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        self.append_line(info(format!("Surface policies: {}", surfaces.len())));

        if surfaces.is_empty() {
            self.append_line(dim("No surface policies were returned."));
            return;
        }

        for surface in surfaces.iter().take(10) {
            self.append_surface_policy_summary_line(surface);
            let override_count = surface
                .get("overrides")
                .and_then(Value::as_array)
                .map(|items| items.len())
                .unwrap_or(0);
            if override_count > 0 {
                self.append_line(dim(format!("  overrides: {override_count}")));
            }
        }
    }

    fn append_config_surfaces_check_host_result(&mut self, data: Value) {
        self.append_line(section("Config surfaces check"));
        if let Some(policy) = data.get("policy") {
            self.append_surface_policy_summary_line(policy);
        } else {
            self.append_line(error_line("surface policy payload missing `policy`"));
            return;
        }
        self.append_surface_policy_overrides(&data);
    }

    fn append_config_surfaces_set_host_result(&mut self, data: Value) {
        self.append_line(section("Config surfaces set"));
        if let Some(policy) = data.get("policy") {
            self.append_line(success("Surface override applied"));
            self.append_surface_policy_summary_line(policy);
        } else {
            self.append_line(error_line("surface policy payload missing `policy`"));
            return;
        }
        if let Some(env_path) = json_value_as_string(data.get("envPath")) {
            self.append_line(dim(format!("Env path: {env_path}")));
        }
        if let Some(updated_keys) = data.get("updatedKeys").and_then(Value::as_array) {
            if !updated_keys.is_empty() {
                let joined = updated_keys
                    .iter()
                    .filter_map(Value::as_str)
                    .collect::<Vec<_>>()
                    .join(", ");
                self.append_line(info(format!("Updated keys: {joined}")));
            }
        }
    }

    fn append_config_surfaces_reset_host_result(&mut self, data: Value) {
        self.append_line(section("Config surfaces reset"));
        if let Some(policy) = data.get("policy") {
            self.append_line(success("Surface override reset"));
            self.append_surface_policy_summary_line(policy);
        } else {
            self.append_line(error_line("surface policy payload missing `policy`"));
            return;
        }
        if let Some(env_path) = json_value_as_string(data.get("envPath")) {
            self.append_line(dim(format!("Env path: {env_path}")));
        }
        let removed_keys = data
            .get("removedKeys")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        if removed_keys.is_empty() {
            self.append_line(dim("Removed keys: none"));
        } else {
            let joined = removed_keys
                .iter()
                .filter_map(Value::as_str)
                .collect::<Vec<_>>()
                .join(", ");
            self.append_line(info(format!("Removed keys: {joined}")));
        }
    }

    fn append_pulse_status_host_result(&mut self, data: Value) {
        self.append_line(section("PULSE"));

        let summary = data.get("summary").and_then(Value::as_object);
        let total_entries = summary
            .and_then(|summary| summary.get("totalEntries"))
            .and_then(Value::as_u64)
            .unwrap_or(0);
        let last_event = json_value_as_string(summary.and_then(|summary| summary.get("lastEvent")))
            .unwrap_or_else(|| "none".to_string());
        let last_health =
            json_value_as_string(summary.and_then(|summary| summary.get("lastHealth")))
                .unwrap_or_else(|| "unknown".to_string());
        let uptime_seconds = summary
            .and_then(|summary| summary.get("uptimeSeconds"))
            .and_then(Value::as_u64);

        let tone = match last_health.as_str() {
            "healthy" => LineTone::Success,
            "degraded" => LineTone::Warning,
            "unhealthy" => LineTone::Error,
            _ if total_entries == 0 => LineTone::Warning,
            _ => LineTone::Plain,
        };
        self.append_line(styled(
            format!(
                "Entries: {total_entries} :: last event={last_event} :: health={last_health}"
            ),
            tone,
        ));
        if let Some(uptime_seconds) = uptime_seconds {
            self.append_line(info(format!("Uptime seconds: {uptime_seconds}")));
        }
        if let Some(last_timestamp) =
            json_value_as_string(summary.and_then(|summary| summary.get("lastTimestamp")))
        {
            self.append_line(dim(format!("Last timestamp: {last_timestamp}")));
        }

        let entries = data
            .get("entries")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        if entries.is_empty() {
            self.append_line(dim("No PULSE heartbeat entries recorded yet."));
            return;
        }

        for entry in entries.iter().rev().take(3) {
            let timestamp =
                json_value_as_string(entry.get("timestamp")).unwrap_or_else(|| "unknown".to_string());
            let event =
                json_value_as_string(entry.get("event")).unwrap_or_else(|| "unknown".to_string());
            let health =
                json_value_as_string(entry.get("health")).unwrap_or_else(|| "unknown".to_string());
            self.append_line(plain(format!("- {timestamp} :: {event} :: {health}")));
            if let Some(detail) = json_value_as_string(entry.get("detail")) {
                self.append_line(dim(format!("  {detail}")));
            }
        }
    }

    fn append_cognitive_mode_host_result(&mut self, data: Value) {
        self.append_line(section("Cognitive mode"));

        let mode = json_value_as_string(data.get("mode")).unwrap_or_else(|| "unknown".to_string());
        let previous_mode = json_value_as_string(data.get("previousMode"));
        let config = data.get("config").and_then(Value::as_object);
        let mode_name =
            json_value_as_string(config.and_then(|config| config.get("name"))).unwrap_or_else(|| {
                "unknown".to_string()
            });
        let temperature = config
            .and_then(|config| config.get("temperature"))
            .and_then(Value::as_f64);
        let style = json_value_as_string(config.and_then(|config| config.get("style")));
        let pattern = json_value_as_string(config.and_then(|config| config.get("pattern")));
        let description =
            json_value_as_string(config.and_then(|config| config.get("description")));

        match previous_mode {
            Some(previous_mode) if previous_mode != mode => {
                self.append_line(success(format!("Mode: {previous_mode} -> {mode} ({mode_name})")));
            }
            _ => {
                self.append_line(info(format!("Mode: {mode} ({mode_name})")));
            }
        }

        if let Some(temperature) = temperature {
            self.append_line(info(format!("Temperature: {:.1}", temperature)));
        }
        if let Some(style) = style {
            self.append_line(dim(format!("Style: {style}")));
        }
        if let Some(pattern) = pattern {
            self.append_line(dim(format!("Pattern: {pattern}")));
        }
        if let Some(description) = description {
            self.append_line(dim(description));
        }
    }

    fn append_telegram_send_result(&mut self, result: CliBridgeResult) {
        self.append_line(section("Telegram send"));

        let Some(json) = result.json.as_ref() else {
            self.append_line(warning(
                "Telegram send returned no structured JSON payload.",
            ));
            if result.stdout.trim().is_empty() {
                self.append_line(dim("command produced no output"));
            } else {
                for line in result.stdout.lines() {
                    self.append_line(plain(line.to_string()));
                }
            }
            return;
        };

        let ok = json.get("ok").and_then(Value::as_bool);
        let message_id = json_value_as_string(json.get("messageId"));
        let target_chat = json_value_as_string(json.get("chatId"))
            .or_else(|| self.active_telegram_target().flatten());
        let error = json_value_as_string(json.get("error"));

        match ok {
            Some(true) => {
                let record = TelegramSendRecord {
                    outcome: TelegramSendOutcome::Delivered,
                    target_chat,
                    message_id,
                    error: None,
                };
                self.last_telegram_send = Some(record.clone());
                self.append_rendered_telegram_send(&record);
            }
            Some(false) => {
                let record = TelegramSendRecord {
                    outcome: TelegramSendOutcome::Failed,
                    target_chat,
                    message_id,
                    error: Some(
                        error.unwrap_or_else(|| "telegram send returned ok=false".to_string()),
                    ),
                };
                self.last_telegram_send = Some(record.clone());
                self.append_rendered_telegram_send(&record);
            }
            None => {
                self.append_line(warning(
                    "Telegram send JSON payload was missing the expected ok field.",
                ));
                if let Ok(pretty) = serde_json::to_string_pretty(json) {
                    for line in pretty.lines() {
                        self.append_line(plain(line.to_string()));
                    }
                }
            }
        }
    }

    fn append_telegram_send_host_result(&mut self, data: Value) {
        let record = TelegramSendRecord {
            outcome: TelegramSendOutcome::Delivered,
            target_chat: json_value_as_string(data.get("chatId")),
            message_id: json_value_as_string(data.get("messageId")),
            error: None,
        };
        self.last_telegram_send = Some(record.clone());
        self.append_line(section("Telegram send"));
        self.append_rendered_telegram_send(&record);
    }

    fn append_rendered_telegram_send(&mut self, record: &TelegramSendRecord) {
        match record.outcome {
            TelegramSendOutcome::Delivered => {
                self.append_line(success("Status: delivered"));
                self.append_line(dim(
                    "Route: TypeScript host transport (Rust TUI does not call Telegram directly).",
                ));
            }
            TelegramSendOutcome::Failed => {
                self.append_line(error_line("Status: failed"));
            }
            TelegramSendOutcome::Cancelled => {
                self.append_line(warning("Status: cancelled"));
            }
        }

        if let Some(chat_id) = &record.target_chat {
            self.append_line(plain(format!("Target chat: {chat_id}")));
        }

        if let Some(message_id) = &record.message_id {
            self.append_line(info(format!("Message ID: {message_id}")));
        }

        if let Some(error) = &record.error {
            self.append_line(error_line(format!("Error: {error}")));
        }
    }

    fn append_telegram_send_failure(&mut self, target_chat: Option<String>, error: String) {
        let record = TelegramSendRecord {
            outcome: TelegramSendOutcome::Failed,
            target_chat,
            message_id: None,
            error: Some(error),
        };
        self.last_telegram_send = Some(record.clone());
        self.append_line(section("Telegram send"));
        self.append_rendered_telegram_send(&record);
    }

    fn append_telegram_send_cancelled(&mut self, target_chat: Option<String>) {
        let record = TelegramSendRecord {
            outcome: TelegramSendOutcome::Cancelled,
            target_chat,
            message_id: None,
            error: None,
        };
        self.last_telegram_send = Some(record.clone());
        self.append_line(section("Telegram send"));
        self.append_rendered_telegram_send(&record);
    }

    fn append_transcript_entry(&mut self, message: &ChatTranscriptEntry) {
        let prefix = match message.role.as_str() {
            "user" => "You",
            "assistant" => "Memphis",
            "tool" => message.tool_name.as_deref().unwrap_or("Tool"),
            other => other,
        };
        let tone = match message.role.as_str() {
            "user" => LineTone::Prompt,
            "assistant" => LineTone::Plain,
            "tool" => LineTone::Accent,
            _ => LineTone::Dim,
        };
        self.append_line(styled(format!("[{prefix}] {}", message.content), tone));
        if let (Some(provider), Some(model)) = (&message.provider, &message.model) {
            self.append_line(dim(format!("    via {provider} / {model}")));
        }
    }

    fn append_provider_status_rows(&mut self, title_text: &str) {
        self.append_line(section(title_text));
        if self.provider_statuses.is_empty() {
            self.append_line(dim("No providers detected yet."));
            return;
        }

        let rows = self
            .provider_statuses
            .iter()
            .map(|provider| {
                let state = if provider.configured && provider.available {
                    "[up]"
                } else if provider.configured {
                    "[down][!]"
                } else {
                    "[nocfg]"
                };
                let marker = if provider.configured && provider.available {
                    "●"
                } else if provider.configured {
                    "◐"
                } else {
                    "○"
                };
                let error_suffix = provider
                    .error
                    .as_deref()
                    .filter(|error| !error.trim().is_empty())
                    .map(|error| format!(" {error}"))
                    .unwrap_or_default();
                styled(
                    format!(
                        "{marker} {name:<12} {model:<22} {state}{error_suffix}",
                        name = provider.name,
                        model = provider.default_model
                    ),
                    if provider.configured && provider.available {
                        LineTone::Success
                    } else if provider.configured {
                        LineTone::Warning
                    } else {
                        LineTone::Dim
                    },
                )
            })
            .collect::<Vec<_>>();

        for row in rows {
            self.append_line(row);
        }
    }

    fn append_model_rows(&mut self) {
        self.append_line(section("Models"));
        if self.provider_statuses.is_empty() {
            self.append_line(dim("No provider models detected yet."));
            return;
        }

        let rows = self
            .provider_statuses
            .iter()
            .flat_map(|provider| {
                let mut lines = vec![info(format!("Provider: {}", provider.name))];
                lines.extend(
                    provider
                        .models
                        .iter()
                        .map(|model| plain(format!("- {model}"))),
                );
                lines
            })
            .collect::<Vec<_>>();

        for row in rows {
            self.append_line(row);
        }
    }

    fn render_overview(&self) -> Vec<StyledLine> {
        let mut lines = vec![
            section("Overview"),
            dim("Single-view cockpit backed by memphis-operator."),
        ];

        if let Some(overview) = &self.snapshot.overview {
            lines.push(info("Runtime"));
            lines.push(plain(format!("Data dir: {}", overview.data_dir)));
            lines.push(plain(format!(
                "Default provider: {}",
                overview.default_provider
            )));
            lines.push(plain(format!("Embed mode: {}", overview.embed_mode)));
            lines.push(plain(format!(
                "Cognitive mode: {}  PULSE: {}",
                overview.cognitive_mode, overview.pulse_health
            )));
            lines.push(blank());
            lines.push(info("Inventory"));
            lines.push(plain(format!(
                "Chains: {}  Blocks: {}  Vault entries: {}  Sessions: {}  Cases: {}",
                overview.chains,
                overview.blocks,
                overview.vault_entries,
                overview.sessions,
                overview.case_rows
            )));
            lines.push(plain(format!(
                "Memory docs: {}  Exact entries: {}",
                overview.semantic_docs, overview.exact_entries
            )));
            if let Some(model_capability) = self.selected_model_capability() {
                if let Some(context_window_tokens) = model_capability.context_window_tokens {
                    lines.push(plain(format!(
                        "Active context window: {} tokens",
                        format_token_count(context_window_tokens)
                    )));
                }
            }
            if !self.provider_statuses.is_empty() {
                lines.push(blank());
                lines.push(info("Provider status"));
                lines.extend(self.provider_rows_as_lines());
            }
        } else if let Some(error) = &self.snapshot.overview_error {
            lines.push(error_line(format!("Overview unavailable: {error}")));
        } else {
            lines.push(warning("Overview not loaded yet."));
        }

        lines
    }

    fn render_chat_summary(&self) -> Vec<StyledLine> {
        let context_window_tokens = self
            .selected_model_capability()
            .and_then(|capability| capability.context_window_tokens);
        let context_pressure = derive_context_pressure_summary(
            context_window_tokens,
            self.live_token_usage
                .as_ref()
                .or(self.last_token_usage.as_ref()),
        );
        vec![
            section("Chat"),
            plain(format!("Session: {}", self.chat_session_id)),
            plain(format!("Provider: {}", self.selected_provider_name())),
            plain(format!("Model: {}", self.selected_model_name())),
            plain(format!(
                "Context window: {}",
                context_window_tokens
                    .map(|tokens| format!("{} tokens", format_token_count(tokens)))
                    .unwrap_or_else(|| "unknown".to_string())
            )),
            plain(format!(
                "Context headroom: {}",
                context_pressure
                    .as_ref()
                    .map(format_full_context_headroom)
                    .unwrap_or_else(|| "unknown".to_string())
            )),
            plain(format!(
                "Context pressure: {}",
                context_pressure
                    .as_ref()
                    .map(|pressure| pressure.level.as_str().to_string())
                    .unwrap_or_else(|| "unknown".to_string())
            )),
            plain(format!(
                "Last token usage: {}",
                self.last_token_usage
                    .as_ref()
                    .map(format_full_token_usage)
                    .unwrap_or_else(|| "unknown".to_string())
            )),
            plain(format!(
                "Live output meter: {}",
                self.live_token_usage
                    .as_ref()
                    .map(format_full_token_usage)
                    .or_else(|| {
                        self.live_output_chars.map(|chars| {
                            format!("out~:{} tokens", estimate_tokens_from_chars(chars))
                        })
                    })
                    .unwrap_or_else(|| "idle".to_string())
            )),
            plain(format!(
                "Degradation: {}",
                self.degradation
                    .as_ref()
                    .filter(|state| state.active)
                    .map(format_degradation_summary)
                    .unwrap_or_else(|| "none".to_string())
            )),
            dim("Plain text entered into the prompt is sent as live chat."),
        ]
    }

    fn render_memory_summary(&self) -> Vec<StyledLine> {
        let mut lines = vec![
            section("Memory"),
            dim("Semantic recall and exact phrase search state."),
        ];

        if let Some(memory) = &self.snapshot.memory {
            lines.push(plain(format!(
                "Semantic provider: {}  Docs: {}  Persistence: {}",
                memory.semantic_provider, memory.semantic_docs, memory.semantic_persistence_state
            )));
            lines.push(plain(format!(
                "Exact entries: {}  Database: {}",
                memory.exact_entries, memory.exact_database_path
            )));
            lines.push(plain(format!(
                "Indexed chains: {}",
                if memory.indexed_chains.is_empty() {
                    "-".to_string()
                } else {
                    memory.indexed_chains.join(", ")
                }
            )));
        } else if let Some(error) = &self.snapshot.memory_error {
            lines.push(error_line(format!("Memory unavailable: {error}")));
        } else {
            lines.push(warning("Memory state not loaded yet."));
        }

        lines
    }

    fn render_sessions_summary(&self) -> Vec<StyledLine> {
        let mut lines = vec![
            section("Sessions"),
            dim("Recent operator sessions from SQLite."),
        ];
        if let Some(sessions) = &self.snapshot.sessions {
            lines.push(plain(format!(
                "Database: {}  Recent sessions: {}",
                sessions.database_path, sessions.count
            )));
            for session in &sessions.sessions {
                lines.push(plain(format!(
                    "- {} created={} updated={}",
                    session.id, session.created_at, session.updated_at
                )));
            }
        } else if let Some(error) = &self.snapshot.sessions_error {
            lines.push(error_line(format!("Sessions unavailable: {error}")));
        } else {
            lines.push(warning("No session data loaded yet."));
        }
        lines
    }

    fn render_vault_summary(&self) -> Vec<StyledLine> {
        let mut lines = vec![
            section("Vault"),
            dim("Metadata-first view. Direct plaintext reads stay bounded to explicit commands."),
        ];

        if let Some(vault) = &self.snapshot.vault {
            lines.push(plain(format!(
                "Initialized: {}  State version: {:?}  Entries: {}",
                if vault.initialized { "yes" } else { "no" },
                vault.state_version,
                vault.count
            )));
            lines.push(plain(format!("State path: {}", vault.state_path)));
            lines.push(plain(format!("Entries path: {}", vault.entries_path)));
            for entry in vault.entries.iter().take(8) {
                let integrity = if entry.integrity_ok { "ok" } else { "bad" };
                let fingerprint = entry.fingerprint.chars().take(10).collect::<String>();
                let entry_id = entry.id.as_deref().unwrap_or("-");
                lines.push(plain(format!(
                    "- {}  integrity={}  created={}  fp={}  id={}",
                    entry.key, integrity, entry.created_at, fingerprint, entry_id
                )));
            }
        } else if let Some(error) = &self.snapshot.vault_error {
            lines.push(error_line(format!("Vault unavailable: {error}")));
        } else {
            lines.push(warning("Vault not loaded yet."));
        }

        lines
    }

    fn render_cases_summary(&self) -> Vec<StyledLine> {
        let mut lines = vec![
            section("Cases / Decisions"),
            dim("Recent case rows from the native index."),
        ];
        if let Some(cases) = &self.snapshot.cases {
            lines.push(plain(format!("Index path: {}", cases.index_path)));
            lines.push(plain(format!("Recent case rows: {}", cases.count)));
            for case in &cases.cases {
                lines.push(plain(format!(
                    "- #{} {} entity={} actor={} target={}",
                    case.block_index,
                    case.case_type,
                    case.entity.as_deref().unwrap_or("-"),
                    case.actor.as_deref().unwrap_or("-"),
                    case.target.as_deref().unwrap_or("-"),
                )));
            }
        } else if let Some(error) = &self.snapshot.cases_error {
            lines.push(error_line(format!("Cases unavailable: {error}")));
        } else {
            lines.push(warning("No case data loaded yet."));
        }
        lines
    }

    fn render_system_summary(&self) -> Vec<StyledLine> {
        let mut lines = vec![
            section("System"),
            dim("Runtime paths, readiness, bridge state, and provider health."),
        ];

        if let Some(system) = &self.snapshot.system {
            lines.push(plain(format!("Data dir: {}", system.data_dir)));
            lines.push(plain(format!("Database: {}", system.database_path)));
            lines.push(plain(format!(
                "Rust chain enabled={}  bridge={}",
                if system.rust_chain_enabled {
                    "yes"
                } else {
                    "no"
                },
                system.rust_bridge_path
            )));
            lines.push(plain(format!(
                "Matrix federation={} trust_mode={} homeserver={} token={} peer_storage={}",
                system.matrix.federation,
                system.matrix.trust_mode,
                if system.matrix.homeserver_configured {
                    "yes"
                } else {
                    "no"
                },
                system.matrix.access_token_source,
                if system.matrix.peer_storage_ready {
                    "yes"
                } else {
                    "no"
                }
            )));
            if !system.matrix.reasons.is_empty() {
                lines.push(warning(format!(
                    "Matrix blockers: {}",
                    system.matrix.reasons.join("; ")
                )));
            }
            lines.push(plain(format!(
                "Telegram state={} gateway={} token_source={} chat_id={} allowlist={}",
                system.telegram.state,
                if system.telegram.gateway_enabled {
                    "on"
                } else {
                    "off"
                },
                system.telegram.token_source,
                if system.telegram.chat_id_configured {
                    "yes"
                } else {
                    "no"
                },
                system.telegram.allowlist_count
            )));
            lines.push(plain(format!(
                "Vault initialized={}",
                if system.vault_initialized {
                    "yes"
                } else {
                    "no"
                }
            )));
            lines.push(plain(format!(
                "Embed persist path: {}",
                system.embed_persist_path
            )));
            lines.push(plain(format!(
                "Chains: {}",
                if system.chain_names.is_empty() {
                    "-".to_string()
                } else {
                    system.chain_names.join(", ")
                }
            )));
            if !self.provider_statuses.is_empty() {
                lines.push(blank());
                lines.push(info("Provider status"));
                lines.extend(self.provider_rows_as_lines());
            }
        } else if let Some(error) = &self.snapshot.system_error {
            lines.push(error_line(format!("System status unavailable: {error}")));
        } else {
            lines.push(warning("System status not loaded yet."));
        }

        lines
    }

    fn telegram_status_lines(&self) -> Vec<StyledLine> {
        let mut lines = vec![
            section("Telegram"),
            dim("Native readiness view for Telegram companion mode."),
        ];

        if let Some(system) = &self.snapshot.system {
            lines.push(info("Readiness"));
            lines.push(telegram_state_line(&system.telegram));
            lines.push(plain(format!(
                "Gateway enabled: {}",
                yes_no(system.telegram.gateway_enabled)
            )));
            lines.push(plain(format!(
                "Configured: {}",
                yes_no(system.telegram.configured)
            )));
            lines.push(plain(format!(
                "Token source: {}",
                system.telegram.token_source
            )));
            lines.push(plain(format!(
                "Chat ID configured: {}",
                yes_no(system.telegram.chat_id_configured)
            )));
            lines.push(plain(format!(
                "Allowlist: {} ({})",
                if system.telegram.allowlist_enabled {
                    "enabled"
                } else {
                    "open"
                },
                system.telegram.allowlist_count
            )));
        } else if let Some(error) = &self.snapshot.system_error {
            lines.push(error_line(format!("Telegram status unavailable: {error}")));
        } else {
            lines.push(warning("Telegram status not loaded yet."));
        }

        lines.push(blank());
        lines.push(info("Companion route"));
        lines.push(dim(
            "Status is local memphis-operator truth; send actions route through the TypeScript host transport.",
        ));
        lines.push(dim(
            "Rust TUI does not call the Telegram API directly or resolve the bot token itself.",
        ));
        lines.push(blank());
        lines.push(info("Last send in this session"));
        if let Some(last_send) = &self.last_telegram_send {
            lines.extend(self.telegram_send_record_lines(last_send));
        } else {
            lines.push(dim("No Telegram send executed in this TUI session."));
        }

        lines
    }

    fn telegram_send_record_lines(&self, record: &TelegramSendRecord) -> Vec<StyledLine> {
        let mut lines = Vec::new();
        match record.outcome {
            TelegramSendOutcome::Delivered => lines.push(success("Status: delivered")),
            TelegramSendOutcome::Failed => lines.push(error_line("Status: failed")),
            TelegramSendOutcome::Cancelled => lines.push(warning("Status: cancelled")),
        }

        if let Some(chat_id) = &record.target_chat {
            lines.push(plain(format!("Target chat: {chat_id}")));
        }

        if let Some(message_id) = &record.message_id {
            lines.push(info(format!("Message ID: {message_id}")));
        }

        if let Some(error) = &record.error {
            lines.push(error_line(format!("Error: {error}")));
        }

        lines
    }

    fn provider_rows_as_lines(&self) -> Vec<StyledLine> {
        if self.provider_statuses.is_empty() {
            return vec![dim("No providers detected yet.")];
        }

        self.provider_statuses
            .iter()
            .map(|provider| {
                let state = if provider.configured && provider.available {
                    "[up]"
                } else if provider.configured {
                    "[down][!]"
                } else {
                    "[nocfg]"
                };
                let marker = if provider.configured && provider.available {
                    "●"
                } else if provider.configured {
                    "◐"
                } else {
                    "○"
                };
                let error_suffix = provider
                    .error
                    .as_deref()
                    .filter(|error| !error.trim().is_empty())
                    .map(|error| format!(" {error}"))
                    .unwrap_or_default();
                let context_suffix = provider
                    .model_capabilities
                    .iter()
                    .find(|capability| capability.model == provider.default_model)
                    .and_then(|capability| capability.context_window_tokens)
                    .map(|tokens| format!(" ctx:{}", format_token_count(tokens)))
                    .unwrap_or_default();
                styled(
                    format!(
                        "{marker} {name:<12} {model:<22}{context_suffix} {state}{error_suffix}",
                        name = provider.name,
                        model = provider.default_model
                    ),
                    if provider.configured && provider.available {
                        LineTone::Success
                    } else if provider.configured {
                        LineTone::Warning
                    } else {
                        LineTone::Dim
                    },
                )
            })
            .collect()
    }

    fn history_prev(&mut self) {
        if self.history.is_empty() {
            return;
        }

        let next_index = match self.history_index {
            Some(index) if index > 0 => index - 1,
            Some(index) => index,
            None => self.history.len().saturating_sub(1),
        };
        self.history_index = Some(next_index);
        self.input_buffer = self.history[next_index].clone();
    }

    fn history_next(&mut self) {
        let Some(index) = self.history_index else {
            return;
        };

        if index + 1 >= self.history.len() {
            self.history_index = None;
            self.input_buffer.clear();
            return;
        }

        let next_index = index + 1;
        self.history_index = Some(next_index);
        self.input_buffer = self.history[next_index].clone();
    }

    fn append_stream_chunk(&mut self, tone: LineTone, chunk: &str) {
        if chunk.is_empty() {
            return;
        }

        let mut parts = chunk.split('\n').peekable();
        while let Some(part) = parts.next() {
            if self.output_buffer.is_empty() {
                self.output_buffer.push(styled(String::new(), tone));
            }

            let append_to_current = self
                .output_buffer
                .last()
                .map(|line| line.tone == tone)
                .unwrap_or(false);

            if append_to_current {
                if let Some(last) = self.output_buffer.last_mut() {
                    last.content.push_str(part);
                }
            } else {
                self.output_buffer.push(styled(part.to_string(), tone));
            }

            if parts.peek().is_some() {
                self.output_buffer.push(styled(String::new(), tone));
            }
        }

        self.trim_output_buffer();
    }

    fn append_line(&mut self, line: StyledLine) {
        self.output_buffer.push(line);
        self.trim_output_buffer();
    }

    fn append_lines<I>(&mut self, lines: I)
    where
        I: IntoIterator<Item = StyledLine>,
    {
        for line in lines {
            self.append_line(line);
        }
    }

    fn append_blank(&mut self) {
        self.append_line(blank());
    }

    fn trim_output_buffer(&mut self) {
        if self.output_buffer.len() > OUTPUT_BUFFER_LIMIT {
            let overflow = self.output_buffer.len() - OUTPUT_BUFFER_LIMIT;
            self.output_buffer.drain(0..overflow);
        }
    }

    pub fn render_status_bar_context(&self) -> StatusBarContext {
        self.status_bar_context()
    }

    fn status_bar_context(&self) -> StatusBarContext {
        let provider = self.selected_provider_name();
        let model = self.selected_model_name();
        let context_window_tokens = self
            .selected_model_capability()
            .and_then(|capability| capability.context_window_tokens);
        let context_pressure = derive_context_pressure_summary(
            context_window_tokens,
            self.live_token_usage
                .as_ref()
                .or(self.last_token_usage.as_ref()),
        );
        let connected = self
            .provider_statuses
            .iter()
            .find(|status| status.name == provider)
            .map(|status| status.configured && status.available)
            .unwrap_or(false);

        StatusBarContext {
            connected,
            provider,
            model,
            context_window_tokens,
            context_pressure,
            token_usage: self.last_token_usage.clone(),
            live_token_usage: self.live_token_usage.clone(),
            live_output_tokens: self
                .live_output_chars
                .map(estimate_tokens_from_chars),
            session_id: self.chat_session_id.clone(),
            busy: self.active_command.is_some(),
            activity: self
                .active_command
                .as_ref()
                .map(|active| active.label.clone()),
            cancelling: self
                .active_command
                .as_ref()
                .map(|active| active.cancel_requested)
                .unwrap_or(false),
            cancel_waiting_on_provider: self
                .active_command
                .as_ref()
                .map(|active| {
                    active.cancel_requested
                        && active.cancel_behavior == CancelBehavior::WaitForProviderResponse
                })
                .unwrap_or(false),
            degraded: self.degradation.as_ref().map(|d| d.active).unwrap_or(false),
            degradation_reason: self.degradation.as_ref().map(|d| d.reason.clone()),
            cognitive_mode: self
                .snapshot
                .overview
                .as_ref()
                .map(|o| o.cognitive_mode.clone())
                .unwrap_or_else(|| "A".to_string()),
            pulse_health: self
                .snapshot
                .overview
                .as_ref()
                .map(|o| o.pulse_health.clone())
                .unwrap_or_else(|| "unknown".to_string()),
        }
    }

    fn chat_cancel_behavior(&self) -> CancelBehavior {
        CancelBehavior::Standard
    }

    fn selected_provider_name(&self) -> String {
        self.chat_provider
            .as_deref()
            .filter(|value| !value.trim().is_empty())
            .map(ToString::to_string)
            .or_else(|| {
                self.snapshot
                    .overview
                    .as_ref()
                    .map(|overview| overview.default_provider.clone())
            })
            .unwrap_or_else(|| "local-fallback".to_string())
    }

    fn selected_model_name(&self) -> String {
        if let Some(model) = self
            .chat_model
            .as_deref()
            .filter(|value| !value.trim().is_empty())
        {
            return model.to_string();
        }

        let provider = self.selected_provider_name();
        self.provider_statuses
            .iter()
            .find(|status| status.name == provider)
            .map(|status| status.default_model.clone())
            .unwrap_or_else(|| "default".to_string())
    }

    fn selected_model_capability(&self) -> Option<&ModelCapabilitySummary> {
        let provider = self.selected_provider_name();
        let model = self.selected_model_name();
        let provider_status = self
            .provider_statuses
            .iter()
            .find(|status| status.name == provider)?;

        provider_status
            .model_capabilities
            .iter()
            .find(|capability| capability.model == model)
            .or_else(|| {
                provider_status
                    .model_capabilities
                    .iter()
                    .find(|capability| capability.model == provider_status.default_model)
            })
    }

    fn active_native_chat_running(&self) -> bool {
        matches!(
            self.active_command.as_ref().map(|active| &active.kind),
            Some(ActiveCommandKind::NativeChat)
        )
    }

    fn is_telegram_send_result(&self, result: &CliBridgeResult) -> bool {
        result.command_label == "telegram send"
            || result.command_label.starts_with("telegram send ")
    }

    fn active_telegram_target(&self) -> Option<Option<String>> {
        self.active_command
            .as_ref()
            .and_then(|active| match &active.kind {
                ActiveCommandKind::TelegramSend { target_chat } => Some(target_chat.clone()),
                ActiveCommandKind::Generic | ActiveCommandKind::NativeChat => None,
            })
    }
}

fn format_token_count(tokens: u32) -> String {
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

fn estimate_tokens_from_chars(chars: usize) -> u32 {
    chars.div_ceil(4) as u32
}

#[cfg(test)]
fn format_status_token_usage(usage: &TokenUsageSummary) -> String {
    if usage.estimated {
        format!("tok~:{}", usage.total_tokens)
    } else {
        format!("tok:{}", usage.total_tokens)
    }
}

fn format_full_token_usage(usage: &TokenUsageSummary) -> String {
    let prefix = if usage.estimated { "tok~" } else { "tok" };
    format!(
        "{prefix} p:{} c:{} t:{}",
        usage.prompt_tokens, usage.completion_tokens, usage.total_tokens
    )
}

fn derive_context_pressure_summary(
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
fn format_status_pressure(pressure: &ContextPressureSummary) -> String {
    let remaining = format_token_count(pressure.remaining_context_tokens);
    if pressure.estimated {
        format!("prs:{} rem~:{remaining}", pressure.level.short_label())
    } else {
        format!("prs:{} rem:{remaining}", pressure.level.short_label())
    }
}

fn format_full_context_headroom(pressure: &ContextPressureSummary) -> String {
    let remaining = format_token_count(pressure.remaining_context_tokens);
    if pressure.estimated {
        format!("~{remaining} tokens")
    } else {
        format!("{remaining} tokens")
    }
}

fn format_degradation_summary(state: &DegradationState) -> String {
    let provider = state.actual_provider.trim();
    let reason = state.reason.trim();
    match (provider.is_empty(), reason.is_empty()) {
        (true, true) => "active".to_string(),
        (false, true) => format!("active via {provider}"),
        (true, false) => format!("active ({reason})"),
        (false, false) => format!("active via {provider} ({reason})"),
    }
}

pub fn classify_input_route(raw: &str) -> Result<CommandRoute, String> {
    let raw = raw.trim();
    if raw.is_empty() {
        return Err("input must not be empty".to_string());
    }

    if let Some(command_line) = raw.strip_prefix('/') {
        let tokens = split_command_tokens(command_line)?;
        return classify_command_route(&tokens);
    }

    Ok(CommandRoute::Native)
}

fn classify_command_route(tokens: &[String]) -> Result<CommandRoute, String> {
    if tokens.is_empty() {
        return Ok(CommandRoute::Unsupported);
    }

    match tokens {
        [scope, action, ..] if *scope == "telegram" && *action == "send" => {
            return Ok(CommandRoute::Host);
        }
        [cmd, ..] if *cmd == "legacy" => return Ok(CommandRoute::Legacy),
        _ => {}
    }

    if is_native_command_tokens(tokens) {
        return Ok(CommandRoute::Native);
    }

    match extension_host_command_for_tokens(tokens) {
        Ok(Some(_)) => Ok(CommandRoute::Host),
        Ok(None) => Ok(CommandRoute::Unsupported),
        Err(error) => Err(error),
    }
}

fn is_native_command_tokens(tokens: &[String]) -> bool {
    match tokens {
        [cmd]
            if matches!(
                cmd.as_str(),
                "help"
                    | "clear"
                    | "refresh"
                    | "overview"
                    | "memory"
                    | "sessions"
                    | "vault"
                    | "cases"
                    | "system"
                    | "telegram"
                    | "providers"
                    | "models"
            ) =>
        {
            true
        }
        [scope, action] if *scope == "telegram" && *action == "status" => true,
        [scope, mode, ..] if *scope == "memory" && (*mode == "semantic" || *mode == "exact") => {
            true
        }
        [scope, action, _key] if *scope == "vault" && *action == "get" => true,
        [scope, action, _name] if *scope == "provider" && *action == "set" => true,
        [scope, action, _model @ ..] if *scope == "model" && *action == "set" => true,
        [cmd, _value] if *cmd == "provider" => true,
        [cmd, _value @ ..] if *cmd == "model" => true,
        [cmd, _value] if *cmd == "session" => true,
        _ => false,
    }
}

fn extension_host_command_for_tokens(
    tokens: &[String],
) -> Result<Option<(ExtensionHostCommand, ActiveCommandKind)>, String> {
    match tokens {
        [cmd, sub] if *cmd == "init" && *sub == "status" => Ok(Some((
            ExtensionHostCommand {
                label: "init status".to_string(),
                command: "init.status".to_string(),
                args: json!({}),
            },
            ActiveCommandKind::Generic,
        ))),
        [cmd] if *cmd == "health" => Ok(Some((
            ExtensionHostCommand {
                label: "health".to_string(),
                command: "health.status".to_string(),
                args: json!({}),
            },
            ActiveCommandKind::Generic,
        ))),
        [cmd] if *cmd == "pulse" => Ok(Some((
            ExtensionHostCommand {
                label: "pulse".to_string(),
                command: "pulse.status".to_string(),
                args: json!({}),
            },
            ActiveCommandKind::Generic,
        ))),
        [cmd, sub] if *cmd == "pulse" && *sub == "status" => Ok(Some((
            ExtensionHostCommand {
                label: "pulse status".to_string(),
                command: "pulse.status".to_string(),
                args: json!({}),
            },
            ActiveCommandKind::Generic,
        ))),
        [cmd, rest @ ..] if *cmd == "doctor" => {
            let (bools, values) =
                parse_supported_flags(rest, &["--fix", "--force", "--deep"], &[])?;
            if !values.is_empty() {
                return Err("doctor does not accept value flags in the TUI".to_string());
            }
            Ok(Some((
                ExtensionHostCommand {
                    label: "doctor".to_string(),
                    command: "doctor.run".to_string(),
                    args: json!({
                        "fix": bools.contains("--fix"),
                        "force": bools.contains("--force"),
                        "deep": bools.contains("--deep"),
                    }),
                },
                ActiveCommandKind::Generic,
            )))
        }
        [cmd, sub] if *cmd == "agents" && *sub == "list" => Ok(Some((
            ExtensionHostCommand {
                label: "agents list".to_string(),
                command: "agents.list".to_string(),
                args: json!({}),
            },
            ActiveCommandKind::Generic,
        ))),
        [cmd, sub] if *cmd == "agents" && *sub == "discover" => Ok(Some((
            ExtensionHostCommand {
                label: "agents discover".to_string(),
                command: "agents.discover".to_string(),
                args: json!({}),
            },
            ActiveCommandKind::Generic,
        ))),
        [cmd, sub, did] if *cmd == "agents" && *sub == "show" => Ok(Some((
            ExtensionHostCommand {
                label: format!("agents show {did}"),
                command: "agents.show".to_string(),
                args: json!({ "did": did }),
            },
            ActiveCommandKind::Generic,
        ))),
        [cmd, sub, rest @ ..] if *cmd == "sync" && *sub == "status" => {
            let (_bools, values) = parse_supported_flags(rest, &[], &["--chain"])?;
            Ok(Some((
                ExtensionHostCommand {
                    label: "sync status".to_string(),
                    command: "sync.status".to_string(),
                    args: json!({ "chain": values.get("--chain") }),
                },
                ActiveCommandKind::Generic,
            )))
        }
        [cmd, sub] if *cmd == "apps" && *sub == "list" => Ok(Some((
            ExtensionHostCommand {
                label: "apps list".to_string(),
                command: "apps.list".to_string(),
                args: json!({}),
            },
            ActiveCommandKind::Generic,
        ))),
        [cmd, sub, rest @ ..] if *cmd == "apps" && *sub == "show" => {
            let (id, flag_tokens) = match rest.split_first() {
                Some((first, remaining)) if !first.starts_with("--") => {
                    (Some(first.clone()), remaining)
                }
                _ => (None, rest),
            };
            let (_bools, values) = parse_supported_flags(flag_tokens, &[], &["--file"])?;
            let file = values.get("--file").cloned();
            if id.is_none() && file.is_none() {
                return Err("apps show requires <id> or --file <manifest.json>".to_string());
            }
            let label_target = id
                .clone()
                .or_else(|| file.clone())
                .unwrap_or_else(|| "manifest".to_string());
            Ok(Some((
                ExtensionHostCommand {
                    label: format!("apps show {label_target}"),
                    command: "apps.show".to_string(),
                    args: json!({ "id": id, "file": file }),
                },
                ActiveCommandKind::Generic,
            )))
        }
        [cmd, sub, id, rest @ ..] if *cmd == "apps" && *sub == "plan" => {
            let (_bools, values) = parse_supported_flags(rest, &[], &["--file", "--action"])?;
            Ok(Some((
                ExtensionHostCommand {
                    label: format!("apps plan {id}"),
                    command: "apps.plan".to_string(),
                    args: json!({
                        "id": id,
                        "file": values.get("--file"),
                        "action": values.get("--action"),
                    }),
                },
                ActiveCommandKind::Generic,
            )))
        }
        [cmd, rest @ ..] if *cmd == "reflect" => {
            let (bools, values) = parse_supported_flags(rest, &["--save"], &[])?;
            if !values.is_empty() {
                return Err("reflect does not accept value flags in the TUI".to_string());
            }
            Ok(Some((
                ExtensionHostCommand {
                    label: "reflect".to_string(),
                    command: "reflect.run".to_string(),
                    args: json!({ "save": bools.contains("--save") }),
                },
                ActiveCommandKind::Generic,
            )))
        }
        [cmd, rest @ ..] if *cmd == "insights" || *cmd == "insight" => {
            let (bools, values) =
                parse_supported_flags(rest, &["--save", "--daily", "--weekly"], &["--topic"])?;
            if bools.contains("--daily") && bools.contains("--weekly") {
                return Err("insights cannot use --daily and --weekly together".to_string());
            }
            let window = if values.contains_key("--topic") {
                "topic"
            } else if bools.contains("--weekly") {
                "weekly"
            } else {
                "daily"
            };
            Ok(Some((
                ExtensionHostCommand {
                    label: "insights".to_string(),
                    command: "insights.run".to_string(),
                    args: json!({
                        "window": window,
                        "topic": values.get("--topic"),
                        "save": bools.contains("--save"),
                    }),
                },
                ActiveCommandKind::Generic,
            )))
        }
        [cmd, sub] if *cmd == "knowledge" && *sub == "status" => Ok(Some((
            ExtensionHostCommand {
                label: "knowledge status".to_string(),
                command: "knowledge.status".to_string(),
                args: json!({}),
            },
            ActiveCommandKind::Generic,
        ))),
        [cmd, sub] if *cmd == "knowledge" && *sub == "sources" => Ok(Some((
            ExtensionHostCommand {
                label: "knowledge sources".to_string(),
                command: "knowledge.status".to_string(),
                args: json!({}),
            },
            ActiveCommandKind::Generic,
        ))),
        [cmd] if *cmd == "mode" => Ok(Some((
            ExtensionHostCommand {
                label: "mode".to_string(),
                command: "cognitive.mode".to_string(),
                args: json!({ "subcommand": "get" }),
            },
            ActiveCommandKind::Generic,
        ))),
        [cmd, mode] if *cmd == "mode" => {
            let normalized = mode.to_ascii_uppercase();
            match normalized.as_str() {
                "A" | "B" | "C" | "D" | "E" => Ok(Some((
                    ExtensionHostCommand {
                        label: format!("mode {normalized}"),
                        command: "cognitive.mode".to_string(),
                        args: json!({ "subcommand": "set", "mode": normalized }),
                    },
                    ActiveCommandKind::Generic,
                ))),
                _ => Err("mode requires one of: A | B | C | D | E".to_string()),
            }
        }
        [cmd, sub, rest @ ..] if *cmd == "knowledge" && *sub == "query" => {
            let (_bools, values) =
                parse_supported_flags(rest, &[], &["--topic", "--source", "--limit"])?;
            let Some(topic) = values.get("--topic") else {
                return Err("knowledge query requires --topic <text> in the TUI".to_string());
            };
            let limit = values
                .get("--limit")
                .and_then(|value| value.parse::<u64>().ok())
                .unwrap_or(5);
            Ok(Some((
                ExtensionHostCommand {
                    label: format!("knowledge query {topic}"),
                    command: "knowledge.query".to_string(),
                    args: json!({
                        "topic": topic,
                        "source": values.get("--source"),
                        "limit": limit,
                    }),
                },
                ActiveCommandKind::Generic,
            )))
        }
        [cmd, topic @ ..] if *cmd == "knowledge" => {
            let topic = topic.join(" ");
            if topic.trim().is_empty() {
                return Err("knowledge requires a topic or subcommand".to_string());
            }
            Ok(Some((
                ExtensionHostCommand {
                    label: format!("knowledge {topic}"),
                    command: "knowledge.query".to_string(),
                    args: json!({ "topic": topic }),
                },
                ActiveCommandKind::Generic,
            )))
        }
        [cmd, scope, action] if *cmd == "config" && *scope == "tools" && *action == "list" => {
            Ok(Some((
                ExtensionHostCommand {
                    label: "config tools list".to_string(),
                    command: "config.tools.list".to_string(),
                    args: json!({}),
                },
                ActiveCommandKind::Generic,
            )))
        }
        [cmd, scope, action, tool_name]
            if *cmd == "config" && *scope == "tools" && *action == "check" =>
        {
            Ok(Some((
                ExtensionHostCommand {
                    label: format!("config tools check {tool_name}"),
                    command: "config.tools.check".to_string(),
                    args: json!({ "toolName": tool_name }),
                },
                ActiveCommandKind::Generic,
            )))
        }
        [cmd, scope, action] if *cmd == "config" && *scope == "tools" && *action == "pending" => {
            Ok(Some((
                ExtensionHostCommand {
                    label: "config tools pending".to_string(),
                    command: "config.tools.pending".to_string(),
                    args: json!({}),
                },
                ActiveCommandKind::Generic,
            )))
        }
        [cmd, scope, action] if *cmd == "config" && *scope == "surfaces" && *action == "list" => {
            Ok(Some((
                ExtensionHostCommand {
                    label: "config surfaces list".to_string(),
                    command: "config.surfaces.list".to_string(),
                    args: json!({}),
                },
                ActiveCommandKind::Generic,
            )))
        }
        [cmd, scope, action, surface]
            if *cmd == "config" && *scope == "surfaces" && *action == "check" =>
        {
            Ok(Some((
                ExtensionHostCommand {
                    label: format!("config surfaces check {surface}"),
                    command: "config.surfaces.check".to_string(),
                    args: json!({ "surface": surface }),
                },
                ActiveCommandKind::Generic,
            )))
        }
        [cmd, scope, action, surface, setting, value @ ..]
            if *cmd == "config" && *scope == "surfaces" && *action == "set" =>
        {
            let value = value.join(" ");
            if value.trim().is_empty() {
                return Err(
                    "config surfaces set requires <surface> <setting> <value> in the TUI"
                        .to_string(),
                );
            }
            Ok(Some((
                ExtensionHostCommand {
                    label: format!("config surfaces set {surface} {setting}"),
                    command: "config.surfaces.set".to_string(),
                    args: json!({ "surface": surface, "setting": setting, "value": value }),
                },
                ActiveCommandKind::Generic,
            )))
        }
        [cmd, scope, action, surface]
            if *cmd == "config" && *scope == "surfaces" && *action == "reset" =>
        {
            Ok(Some((
                ExtensionHostCommand {
                    label: format!("config surfaces reset {surface}"),
                    command: "config.surfaces.reset".to_string(),
                    args: json!({ "surface": surface }),
                },
                ActiveCommandKind::Generic,
            )))
        }
        [cmd, scope, action, surface, setting]
            if *cmd == "config" && *scope == "surfaces" && *action == "reset" =>
        {
            Ok(Some((
                ExtensionHostCommand {
                    label: format!("config surfaces reset {surface} {setting}"),
                    command: "config.surfaces.reset".to_string(),
                    args: json!({ "surface": surface, "setting": setting }),
                },
                ActiveCommandKind::Generic,
            )))
        }
        _ => Ok(None),
    }
}

fn parse_supported_flags(
    tokens: &[String],
    bool_flags: &[&str],
    value_flags: &[&str],
) -> Result<(HashSet<String>, HashMap<String, String>), String> {
    let mut bools = HashSet::new();
    let mut values = HashMap::new();
    let bool_allowed = bool_flags.iter().copied().collect::<HashSet<_>>();
    let value_allowed = value_flags.iter().copied().collect::<HashSet<_>>();
    let mut index = 0usize;

    while index < tokens.len() {
        let token = tokens[index].as_str();
        if bool_allowed.contains(token) {
            bools.insert(token.to_string());
            index += 1;
            continue;
        }
        if value_allowed.contains(token) {
            let Some(value) = tokens.get(index + 1) else {
                return Err(format!("{token} requires a value"));
            };
            values.insert(token.to_string(), value.clone());
            index += 2;
            continue;
        }
        return Err(format!(
            "unsupported flag or argument for extension host command: {token}"
        ));
    }

    Ok((bools, values))
}

fn legacy_cli_fallback_notice(tokens: &[String]) -> String {
    let command = if tokens.is_empty() {
        "unknown command".to_string()
    } else {
        tokens.join(" ")
    };
    format!(
        "Emergency CLI escape hatch: `{command}` is running through the one-shot memphis --json compatibility path."
    )
}

fn unsupported_tui_command_notice(tokens: &[String]) -> String {
    let command = if tokens.is_empty() {
        "unknown command".to_string()
    } else {
        tokens.join(" ")
    };
    format!(
        "unsupported command: `/{command}`. This Rust TUI only runs native or host-backed commands by default. Check /help. If you intentionally need the compatibility path, rerun it as /legacy {command}."
    )
}

fn split_stderr_details(error: &str) -> (String, Vec<String>) {
    let mut primary_lines = Vec::new();
    let mut stderr_lines = Vec::new();
    let mut in_stderr = false;

    for line in error.lines() {
        let trimmed = line.trim();
        if trimmed.eq_ignore_ascii_case("stderr:") {
            in_stderr = true;
            continue;
        }

        if in_stderr {
            if !trimmed.is_empty() {
                stderr_lines.push(trimmed.to_string());
            }
        } else if !trimmed.is_empty() {
            primary_lines.push(trimmed.to_string());
        }
    }

    (primary_lines.join("\n"), stderr_lines)
}

fn summarize_host_command_error(error: &str) -> (&'static str, Option<String>, Vec<String>, bool) {
    let (primary, stderr_lines) = split_stderr_details(error);
    let normalized = primary.trim();

    let (status, detail, reset_hint) = if let Some(detail) =
        normalized.strip_prefix("extension host request timed out before start: ")
    {
        ("Status: host start timeout", detail.trim(), true)
    } else if let Some(detail) = normalized.strip_prefix("extension host request stalled: ") {
        ("Status: host request stalled", detail.trim(), true)
    } else if let Some(detail) = normalized.strip_prefix("extension host stopped unexpectedly: ") {
        ("Status: host stopped unexpectedly", detail.trim(), true)
    } else if let Some(detail) = normalized.strip_prefix("extension host protocol error: ") {
        ("Status: host protocol reset", detail.trim(), true)
    } else if let Some(detail) =
        normalized.strip_prefix("failed to launch memphis extension host: ")
    {
        ("Status: host startup failed", detail.trim(), false)
    } else if let Some(detail) =
        normalized.strip_prefix("extension host did not emit ready handshake: ")
    {
        ("Status: host startup failed", detail.trim(), false)
    } else if let Some(detail) =
        normalized.strip_prefix("unsupported extension host protocol version: ")
    {
        ("Status: host startup failed", detail.trim(), false)
    } else if let Some(detail) =
        normalized.strip_prefix("extension host emitted invalid ready event: ")
    {
        ("Status: host startup failed", detail.trim(), false)
    } else if let Some(detail) =
        normalized.strip_prefix("extension host emitted unexpected startup event: ")
    {
        ("Status: host startup failed", detail.trim(), false)
    } else if let Some(detail) = normalized.strip_prefix("failed writing extension host request: ")
    {
        ("Status: host request write failed", detail.trim(), false)
    } else {
        ("Status: host command failed", normalized, false)
    };

    let detail = if detail.is_empty() {
        None
    } else {
        Some(detail.to_string())
    };

    (status, detail, stderr_lines, reset_hint)
}

fn split_command_tokens(input: &str) -> Result<Vec<String>, String> {
    let mut tokens = Vec::new();
    let mut current = String::new();
    let mut quote: Option<char> = None;
    let mut chars = input.chars().peekable();

    while let Some(ch) = chars.next() {
        if let Some(active_quote) = quote {
            if ch == active_quote {
                quote = None;
            } else if ch == '\\' {
                if let Some(next) = chars.next() {
                    current.push(next);
                }
            } else {
                current.push(ch);
            }
            continue;
        }

        match ch {
            '\'' | '"' => quote = Some(ch),
            ' ' | '\t' if !current.is_empty() => {
                tokens.push(std::mem::take(&mut current));
            }
            ' ' | '\t' => {}
            '\\' => {
                if let Some(next) = chars.next() {
                    current.push(next);
                }
            }
            _ => current.push(ch),
        }
    }

    if quote.is_some() {
        return Err("unterminated quoted string".to_string());
    }

    if !current.is_empty() {
        tokens.push(current);
    }

    Ok(tokens)
}

fn styled(content: impl Into<String>, tone: LineTone) -> StyledLine {
    StyledLine {
        content: content.into(),
        tone,
    }
}

fn blank() -> StyledLine {
    plain("")
}

fn plain(content: impl Into<String>) -> StyledLine {
    styled(content, LineTone::Plain)
}

fn title(content: impl Into<String>) -> StyledLine {
    styled(content, LineTone::Title)
}

fn section(content: impl Into<String>) -> StyledLine {
    styled(content, LineTone::Section)
}

fn info(content: impl Into<String>) -> StyledLine {
    styled(content, LineTone::Info)
}

fn success(content: impl Into<String>) -> StyledLine {
    styled(content, LineTone::Success)
}

fn warning(content: impl Into<String>) -> StyledLine {
    styled(content, LineTone::Warning)
}

fn error_line(content: impl Into<String>) -> StyledLine {
    styled(content, LineTone::Error)
}

fn dim(content: impl Into<String>) -> StyledLine {
    styled(content, LineTone::Dim)
}

fn accent(content: impl Into<String>) -> StyledLine {
    styled(content, LineTone::Accent)
}

fn prompt(content: impl Into<String>) -> StyledLine {
    styled(content, LineTone::Prompt)
}

fn yes_no(value: bool) -> &'static str {
    if value {
        "yes"
    } else {
        "no"
    }
}

fn telegram_state_line(summary: &TelegramReadinessSummary) -> StyledLine {
    let tone = match summary.state.as_str() {
        "ready" => LineTone::Success,
        "configured" => LineTone::Warning,
        "disabled" => LineTone::Dim,
        _ => LineTone::Error,
    };
    styled(format!("State: {}", summary.state), tone)
}

fn json_value_as_string(value: Option<&Value>) -> Option<String> {
    match value {
        Some(Value::String(text)) => Some(text.clone()),
        Some(Value::Number(number)) => Some(number.to_string()),
        Some(Value::Bool(flag)) => Some(flag.to_string()),
        _ => None,
    }
}

fn json_string_list(value: Option<&Value>) -> Vec<String> {
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

#[cfg(test)]
mod tests {
    use super::{
        classify_input_route, extension_host_command_for_tokens, legacy_cli_fallback_notice,
        split_command_tokens, unsupported_tui_command_notice, ActiveCommand, ActiveCommandKind,
        AppAction, AppState, CancelBehavior, DegradationState, ModelCapabilitySummary, Screen,
        TokenUsageSummary,
        TelegramSendOutcome, WorkerEvent,
        HELP_ENTRIES,
    };
    use crate::client::{AppSnapshot, CliBridgeResult, ExtensionHostResult, MemphisClient};
    use crate::config::TuiConfig;
    use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
    use memphis_operator::{
        MatrixReadinessSummary, OverviewSummary, ProviderStatus, SystemSummary,
        TelegramReadinessSummary,
    };
    use serde_json::{json, Value};
    use std::path::PathBuf;
    use std::sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc,
    };
    use std::time::Duration;

    fn config() -> TuiConfig {
        TuiConfig {
            data_dir: PathBuf::from("/tmp/memphis"),
            refresh_interval: Duration::from_secs(3),
        }
    }

    #[test]
    fn enter_submits_input() {
        let mut app = AppState::new(config());
        app.input_buffer = "hello".to_string();

        let action = app.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE));

        assert_eq!(action, AppAction::SubmitInput);
    }

    #[test]
    fn history_navigation_works() {
        let mut app = AppState::new(config());
        app.history = vec!["first".to_string(), "second".to_string()];

        app.handle_key(KeyEvent::new(KeyCode::Up, KeyModifiers::NONE));
        assert_eq!(app.input_buffer, "second");

        app.handle_key(KeyEvent::new(KeyCode::Up, KeyModifiers::NONE));
        assert_eq!(app.input_buffer, "first");

        app.handle_key(KeyEvent::new(KeyCode::Down, KeyModifiers::NONE));
        assert_eq!(app.input_buffer, "second");
    }

    #[test]
    fn paging_keys_control_transcript_scroll() {
        let mut app = AppState::new(config());

        assert_eq!(
            app.handle_key(KeyEvent::new(KeyCode::PageUp, KeyModifiers::NONE)),
            AppAction::PageUp
        );
        assert_eq!(
            app.handle_key(KeyEvent::new(KeyCode::PageDown, KeyModifiers::NONE)),
            AppAction::PageDown
        );
        assert_eq!(
            app.handle_key(KeyEvent::new(KeyCode::Home, KeyModifiers::NONE)),
            AppAction::ScrollTop
        );
        assert_eq!(
            app.handle_key(KeyEvent::new(KeyCode::End, KeyModifiers::NONE)),
            AppAction::ScrollBottom
        );
    }

    #[test]
    fn alt_arrow_keys_scroll_without_touching_history() {
        let mut app = AppState::new(config());
        app.history = vec!["first".to_string(), "second".to_string()];

        assert_eq!(
            app.handle_key(KeyEvent::new(KeyCode::Up, KeyModifiers::ALT)),
            AppAction::ScrollUp
        );
        assert_eq!(
            app.handle_key(KeyEvent::new(KeyCode::Down, KeyModifiers::ALT)),
            AppAction::ScrollDown
        );
        assert!(app.input_buffer.is_empty());
        assert!(app.history_index.is_none());
    }

    #[test]
    fn ctrl_c_interrupts_active_command_when_busy() {
        let mut app = AppState::new(config());
        let (_sender, receiver) = mpsc::channel();
        let cancel_flag = Arc::new(AtomicBool::new(false));
        app.active_command = Some(ActiveCommand {
            label: "native chat".to_string(),
            cancel_flag: Arc::clone(&cancel_flag),
            receiver,
            cancel_requested: false,
            cancel_behavior: CancelBehavior::Standard,
            kind: ActiveCommandKind::Generic,
        });

        let action = app.handle_key(KeyEvent::new(KeyCode::Char('c'), KeyModifiers::CONTROL));

        assert_eq!(action, AppAction::InterruptOrQuit);
        assert!(app.interrupt_active_command());
        assert!(cancel_flag.load(Ordering::Relaxed));
        assert!(
            app.active_command
                .as_ref()
                .expect("active command")
                .cancel_requested
        );
    }

    #[test]
    fn ctrl_c_announces_provider_wait_for_request_response_chat() {
        let mut app = AppState::new(config());
        let (_sender, receiver) = mpsc::channel();
        let cancel_flag = Arc::new(AtomicBool::new(false));
        app.active_command = Some(ActiveCommand {
            label: "native chat".to_string(),
            cancel_flag: Arc::clone(&cancel_flag),
            receiver,
            cancel_requested: false,
            cancel_behavior: CancelBehavior::WaitForProviderResponse,
            kind: ActiveCommandKind::Generic,
        });

        assert!(app.interrupt_active_command());
        assert!(cancel_flag.load(Ordering::Relaxed));

        let contents = app
            .output_buffer
            .iter()
            .map(|line| line.content.as_str())
            .collect::<Vec<_>>();
        assert!(contents
            .iter()
            .any(|line| line.contains("waiting for provider response")));
    }

    #[test]
    fn shared_llm_chat_now_uses_standard_cancel_behavior() {
        let mut app = AppState::new(config());
        app.chat_provider = Some("shared-llm".to_string());

        assert_eq!(app.chat_cancel_behavior(), CancelBehavior::Standard);
    }

    #[test]
    fn status_bar_marks_provider_wait_when_cancelling_request_response_chat() {
        let mut app = AppState::new(config());
        app.chat_provider = Some("shared-llm".to_string());
        let (_sender, receiver) = mpsc::channel();
        app.active_command = Some(ActiveCommand {
            label: "native chat".to_string(),
            cancel_flag: Arc::new(AtomicBool::new(false)),
            receiver,
            cancel_requested: true,
            cancel_behavior: CancelBehavior::WaitForProviderResponse,
            kind: ActiveCommandKind::Generic,
        });

        assert_eq!(
            app.status_bar_text("14:32:05"),
            "○ [Mode:A] shared-llm/default · ctx:? · tok:? · cancelling native chat (provider wait) · PULSE:unknown · session:primary::operator:local · 14:32:05"
        );
    }

    #[test]
    fn cancelled_generic_command_uses_command_label_in_transcript() {
        let mut app = AppState::new(config());
        let (_sender, receiver) = mpsc::channel();
        app.active_command = Some(ActiveCommand {
            label: "TS host: doctor".to_string(),
            cancel_flag: Arc::new(AtomicBool::new(false)),
            receiver,
            cancel_requested: true,
            cancel_behavior: CancelBehavior::Standard,
            kind: ActiveCommandKind::Generic,
        });

        assert!(app.apply_worker_event(WorkerEvent::Cancelled));

        let contents = app
            .output_buffer
            .iter()
            .map(|line| line.content.as_str())
            .collect::<Vec<_>>();
        assert!(contents
            .iter()
            .any(|line| line == &"TS host: doctor cancelled"));
    }

    #[test]
    fn host_error_is_normalized_for_operator_transcript() {
        let mut app = AppState::new(config());
        let (_sender, receiver) = mpsc::channel();
        app.active_command = Some(ActiveCommand {
            label: "TS host: doctor".to_string(),
            cancel_flag: Arc::new(AtomicBool::new(false)),
            receiver,
            cancel_requested: false,
            cancel_behavior: CancelBehavior::Standard,
            kind: ActiveCommandKind::Generic,
        });

        assert!(app.apply_worker_event(WorkerEvent::Error(
            "extension host request stalled: request req-7 emitted no progress for 30s\nstderr:\nline one\nline two".to_string(),
        )));

        let contents = app
            .output_buffer
            .iter()
            .map(|line| line.content.as_str())
            .collect::<Vec<_>>();
        assert!(contents.iter().any(|line| line == &"TS host: doctor"));
        assert!(contents
            .iter()
            .any(|line| line == &"Status: host request stalled"));
        assert!(contents
            .iter()
            .any(|line| line == &"Host session reset; rerun the command if needed."));
        assert!(contents.iter().any(|line| line == &"stderr: line one"));
    }

    #[test]
    fn legacy_cli_error_is_normalized_for_operator_transcript() {
        let mut app = AppState::new(config());
        let (_sender, receiver) = mpsc::channel();
        app.active_command = Some(ActiveCommand {
            label: "legacy CLI: health --json".to_string(),
            cancel_flag: Arc::new(AtomicBool::new(false)),
            receiver,
            cancel_requested: false,
            cancel_behavior: CancelBehavior::Standard,
            kind: ActiveCommandKind::Generic,
        });

        assert!(app.apply_worker_event(WorkerEvent::Error(
            "unknown flag: --bad\nusage: memphis health".to_string(),
        )));

        let contents = app
            .output_buffer
            .iter()
            .map(|line| line.content.as_str())
            .collect::<Vec<_>>();
        assert!(contents
            .iter()
            .any(|line| line == &"Legacy CLI compatibility"));
        assert!(contents
            .iter()
            .any(|line| line == &"Status: compatibility command failed"));
        assert!(contents
            .iter()
            .any(|line| line == &"Command: health --json"));
        assert!(contents.iter().any(|line| line == &"unknown flag: --bad"));
    }

    #[test]
    fn status_bar_uses_current_provider_context() {
        let mut app = AppState::new(config());
        app.snapshot = AppSnapshot {
            overview: Some(OverviewSummary {
                data_dir: "/tmp/memphis".to_string(),
                default_provider: "ollama".to_string(),
                embed_mode: "local".to_string(),
                cognitive_mode: "A".to_string(),
                pulse_health: "healthy".to_string(),
                chains: 1,
                blocks: 1,
                semantic_docs: 1,
                exact_entries: 1,
                sessions: 1,
                case_rows: 1,
                vault_entries: 1,
            }),
            system: Some(SystemSummary {
                data_dir: "/tmp/memphis".to_string(),
                database_path: "/tmp/memphis.db".to_string(),
                rust_chain_enabled: true,
                rust_bridge_path: "./crates/memphis-napi".to_string(),
                matrix_enabled: true,
                telegram_enabled: true,
                matrix: MatrixReadinessSummary {
                    federation: "ready".to_string(),
                    trust_mode: "trusted-pilot".to_string(),
                    enabled: true,
                    homeserver_configured: true,
                    access_token_configured: true,
                    access_token_source: "vault-ref".to_string(),
                    admin_user_configured: true,
                    peer_storage_ready: true,
                    reasons: Vec::new(),
                    homeserver: Some("https://matrix.internal.example".to_string()),
                },
                telegram: TelegramReadinessSummary {
                    state: "ready".to_string(),
                    gateway_enabled: true,
                    configured: true,
                    token_source: "memphis".to_string(),
                    chat_id_configured: true,
                    allowlist_enabled: true,
                    allowlist_count: 1,
                },
                vault_initialized: true,
                embed_persist_path: "/tmp/embed/index-v1.json".to_string(),
                chain_names: vec!["journal".to_string()],
            }),
            ..AppSnapshot::default()
        };
        app.provider_statuses = vec![ProviderStatus {
            name: "ollama".to_string(),
            configured: true,
            available: true,
            default_model: "qwen2.5-coder:3b".to_string(),
            models: vec!["qwen2.5-coder:3b".to_string()],
            model_capabilities: vec![ModelCapabilitySummary {
                model: "qwen2.5-coder:3b".to_string(),
                context_window_tokens: Some(8192),
                supports_streaming: true,
                supports_vision: false,
            }],
            error: None,
        }];
        app.last_token_usage = Some(TokenUsageSummary {
            prompt_tokens: 96,
            completion_tokens: 24,
            total_tokens: 120,
            estimated: false,
        });
        app.chat_session_id = "mem0".to_string();

        let status = app.status_bar_text("14:32:05");

        assert_eq!(
            status,
            "● [Mode:A] ollama/qwen2.5-coder:3b · ctx:8k · tok:120 · ready · PULSE:healthy · session:mem0 · 14:32:05"
        );
    }

    #[test]
    fn status_bar_prefers_live_provider_usage_over_output_estimate() {
        let mut app = AppState::new(config());
        app.snapshot = AppSnapshot {
            overview: Some(OverviewSummary {
                data_dir: "/tmp/memphis".to_string(),
                default_provider: "ollama".to_string(),
                embed_mode: "local".to_string(),
                cognitive_mode: "A".to_string(),
                pulse_health: "healthy".to_string(),
                chains: 1,
                blocks: 1,
                semantic_docs: 1,
                exact_entries: 1,
                sessions: 1,
                case_rows: 1,
                vault_entries: 1,
            }),
            ..AppSnapshot::default()
        };
        app.provider_statuses = vec![ProviderStatus {
            name: "ollama".to_string(),
            configured: true,
            available: true,
            default_model: "qwen2.5-coder:3b".to_string(),
            models: vec!["qwen2.5-coder:3b".to_string()],
            model_capabilities: vec![ModelCapabilitySummary {
                model: "qwen2.5-coder:3b".to_string(),
                context_window_tokens: Some(8192),
                supports_streaming: true,
                supports_vision: false,
            }],
            error: None,
        }];
        app.chat_provider = Some("ollama".to_string());
        app.chat_model = Some("qwen2.5-coder:3b".to_string());
        app.live_output_chars = Some(72);
        app.live_token_usage = Some(TokenUsageSummary {
            prompt_tokens: 96,
            completion_tokens: 18,
            total_tokens: 114,
            estimated: false,
        });
        let (_sender, receiver) = mpsc::channel();
        app.active_command = Some(ActiveCommand {
            label: "native chat".to_string(),
            cancel_flag: Arc::new(AtomicBool::new(false)),
            receiver,
            cancel_requested: false,
            cancel_behavior: CancelBehavior::Standard,
            kind: ActiveCommandKind::NativeChat,
        });

        assert_eq!(
            app.status_bar_text("14:32:05"),
            "● [Mode:A] ollama/qwen2.5-coder:3b · ctx:8k · tok:114 · busy native chat · PULSE:healthy · session:primary::operator:local · 14:32:05"
        );
    }

    #[test]
    fn overview_surface_keeps_provider_rows() {
        let mut app = AppState::new(config());
        app.snapshot = AppSnapshot {
            overview: Some(OverviewSummary {
                data_dir: "/tmp/memphis".to_string(),
                default_provider: "ollama".to_string(),
                embed_mode: "local".to_string(),
                cognitive_mode: "A".to_string(),
                pulse_health: "healthy".to_string(),
                chains: 5,
                blocks: 42,
                semantic_docs: 12,
                exact_entries: 10,
                sessions: 2,
                case_rows: 3,
                vault_entries: 1,
            }),
            ..AppSnapshot::default()
        };
        app.provider_statuses = vec![
            ProviderStatus {
                name: "ollama".to_string(),
                configured: true,
                available: true,
                default_model: "qwen2.5-coder:3b".to_string(),
                models: vec!["qwen2.5-coder:3b".to_string()],
                model_capabilities: vec![ModelCapabilitySummary {
                    model: "qwen2.5-coder:3b".to_string(),
                    context_window_tokens: Some(8192),
                    supports_streaming: true,
                    supports_vision: false,
                }],
                error: None,
            },
            ProviderStatus {
                name: "deepseek".to_string(),
                configured: true,
                available: false,
                default_model: "deepseek-chat".to_string(),
                models: vec!["deepseek-chat".to_string()],
                model_capabilities: vec![ModelCapabilitySummary {
                    model: "deepseek-chat".to_string(),
                    context_window_tokens: Some(64000),
                    supports_streaming: true,
                    supports_vision: false,
                }],
                error: Some("provider not configured".to_string()),
            },
        ];

        let lines = app.surface_lines(Screen::Overview);
        let contents = lines
            .iter()
            .map(|line| line.content.as_str())
            .collect::<Vec<_>>();

        assert!(contents
            .iter()
            .any(|line| line.contains("Default provider: ollama")));
        assert!(contents
            .iter()
            .any(|line| line.contains("Active context window: 8k tokens")));
        assert!(contents
            .iter()
            .any(|line| line.contains("ollama") && line.contains("[up]") && line.contains("ctx:8k")));
        assert!(contents
            .iter()
            .any(|line| line.contains("deepseek") && line.contains("[down][!]") && line.contains("ctx:64k")));
    }

    #[test]
    fn chat_surface_reports_context_window_when_known() {
        let mut app = AppState::new(config());
        app.chat_provider = Some("ollama".to_string());
        app.last_token_usage = Some(TokenUsageSummary {
            prompt_tokens: 96,
            completion_tokens: 24,
            total_tokens: 120,
            estimated: true,
        });
        app.provider_statuses = vec![ProviderStatus {
            name: "ollama".to_string(),
            configured: true,
            available: true,
            default_model: "qwen2.5-coder:3b".to_string(),
            models: vec!["qwen2.5-coder:3b".to_string()],
            model_capabilities: vec![ModelCapabilitySummary {
                model: "qwen2.5-coder:3b".to_string(),
                context_window_tokens: Some(8192),
                supports_streaming: true,
                supports_vision: false,
            }],
            error: None,
        }];

        let lines = app.surface_lines(Screen::Chat);
        let contents = lines
            .iter()
            .map(|line| line.content.as_str())
            .collect::<Vec<_>>();

        assert!(contents
            .iter()
            .any(|line| line.contains("Context window: 8k tokens")));
        assert!(contents
            .iter()
            .any(|line| line.contains("Last token usage: tok~ p:96 c:24 t:120")));
    }

    #[test]
    fn chat_surface_reports_context_pressure_when_headroom_is_tight() {
        let mut app = AppState::new(config());
        app.chat_provider = Some("ollama".to_string());
        app.last_token_usage = Some(TokenUsageSummary {
            prompt_tokens: 5000,
            completion_tokens: 24,
            total_tokens: 5024,
            estimated: true,
        });
        app.provider_statuses = vec![ProviderStatus {
            name: "ollama".to_string(),
            configured: true,
            available: true,
            default_model: "qwen2.5-coder:3b".to_string(),
            models: vec!["qwen2.5-coder:3b".to_string()],
            model_capabilities: vec![ModelCapabilitySummary {
                model: "qwen2.5-coder:3b".to_string(),
                context_window_tokens: Some(8192),
                supports_streaming: true,
                supports_vision: false,
            }],
            error: None,
        }];

        let lines = app.surface_lines(Screen::Chat);
        let contents = lines
            .iter()
            .map(|line| line.content.as_str())
            .collect::<Vec<_>>();

        assert!(contents
            .iter()
            .any(|line| line.contains("Context headroom: ~3.2k tokens")));
        assert!(contents
            .iter()
            .any(|line| line.contains("Context pressure: medium")));
    }

    #[test]
    fn chat_surface_reports_live_provider_usage_when_available() {
        let mut app = AppState::new(config());
        app.live_token_usage = Some(TokenUsageSummary {
            prompt_tokens: 96,
            completion_tokens: 18,
            total_tokens: 114,
            estimated: false,
        });

        let lines = app.surface_lines(Screen::Chat);
        let contents = lines
            .iter()
            .map(|line| line.content.as_str())
            .collect::<Vec<_>>();

        assert!(contents
            .iter()
            .any(|line| line.contains("Live output meter: tok p:96 c:18 t:114")));
    }

    #[test]
    fn chat_surface_reports_active_degradation_truth() {
        let mut app = AppState::new(config());
        app.degradation = Some(DegradationState {
            active: true,
            tier: 2,
            original_provider: "deepseek".to_string(),
            actual_provider: "local-fallback".to_string(),
            reason: "provider cooldown".to_string(),
        });

        let lines = app.surface_lines(Screen::Chat);
        let contents = lines
            .iter()
            .map(|line| line.content.as_str())
            .collect::<Vec<_>>();

        assert!(contents
            .iter()
            .any(|line| line.contains("Degradation: active via local-fallback (provider cooldown)")));
    }

    #[test]
    fn telegram_status_lines_use_system_readiness_snapshot() {
        let mut app = AppState::new(config());
        app.snapshot = AppSnapshot {
            system: Some(SystemSummary {
                data_dir: "/tmp/memphis".to_string(),
                database_path: "/tmp/memphis.db".to_string(),
                rust_chain_enabled: true,
                rust_bridge_path: "./crates/memphis-napi".to_string(),
                matrix_enabled: false,
                telegram_enabled: true,
                matrix: MatrixReadinessSummary {
                    federation: "unavailable".to_string(),
                    trust_mode: "trusted-pilot".to_string(),
                    enabled: false,
                    homeserver_configured: false,
                    access_token_configured: false,
                    access_token_source: "missing".to_string(),
                    admin_user_configured: false,
                    peer_storage_ready: true,
                    reasons: Vec::new(),
                    homeserver: None,
                },
                telegram: TelegramReadinessSummary {
                    state: "ready".to_string(),
                    gateway_enabled: true,
                    configured: true,
                    token_source: "vault-ref".to_string(),
                    chat_id_configured: true,
                    allowlist_enabled: true,
                    allowlist_count: 2,
                },
                vault_initialized: true,
                embed_persist_path: "/tmp/embed/index-v1.json".to_string(),
                chain_names: vec!["journal".to_string()],
            }),
            ..AppSnapshot::default()
        };

        let lines = app.telegram_status_lines();
        let contents = lines
            .iter()
            .map(|line| line.content.as_str())
            .collect::<Vec<_>>();

        assert!(contents.iter().any(|line| line.contains("State: ready")));
        assert!(contents
            .iter()
            .any(|line| line.contains("Token source: vault-ref")));
        assert!(contents
            .iter()
            .any(|line| line.contains("Allowlist: enabled (2)")));
        assert!(contents.iter().any(|line| line.contains("Companion route")));
        assert!(contents
            .iter()
            .any(|line| line.contains("Last send in this session")));
    }

    #[test]
    fn telegram_and_telegram_status_commands_render_same_surface() {
        let snapshot = AppSnapshot {
            system: Some(SystemSummary {
                data_dir: "/tmp/memphis".to_string(),
                database_path: "/tmp/memphis.db".to_string(),
                rust_chain_enabled: true,
                rust_bridge_path: "./crates/memphis-napi".to_string(),
                matrix_enabled: false,
                telegram_enabled: true,
                matrix: MatrixReadinessSummary {
                    federation: "unavailable".to_string(),
                    trust_mode: "trusted-pilot".to_string(),
                    enabled: false,
                    homeserver_configured: false,
                    access_token_configured: false,
                    access_token_source: "missing".to_string(),
                    admin_user_configured: false,
                    peer_storage_ready: true,
                    reasons: Vec::new(),
                    homeserver: None,
                },
                telegram: TelegramReadinessSummary {
                    state: "configured".to_string(),
                    gateway_enabled: false,
                    configured: true,
                    token_source: "memphis".to_string(),
                    chat_id_configured: false,
                    allowlist_enabled: false,
                    allowlist_count: 0,
                },
                vault_initialized: true,
                embed_persist_path: "/tmp/embed/index-v1.json".to_string(),
                chain_names: vec!["journal".to_string()],
            }),
            ..AppSnapshot::default()
        };
        let client = MemphisClient::new();
        let mut short = AppState::new(config());
        short.snapshot = snapshot.clone();
        short.execute_command("telegram", &client);
        let short_lines = short
            .output_buffer
            .iter()
            .map(|line| line.content.as_str())
            .collect::<Vec<_>>();

        let mut explicit = AppState::new(config());
        explicit.snapshot = snapshot;
        explicit.execute_command("telegram status", &client);
        let explicit_lines = explicit
            .output_buffer
            .iter()
            .map(|line| line.content.as_str())
            .collect::<Vec<_>>();

        for required in [
            "Telegram",
            "Readiness",
            "State: configured",
            "Companion route",
            "Last send in this session",
        ] {
            assert!(short_lines.iter().any(|line| line.contains(required)));
            assert!(explicit_lines.iter().any(|line| line.contains(required)));
        }
    }

    #[test]
    fn successful_telegram_send_is_normalized_and_tracked() {
        let mut app = AppState::new(config());
        let (_sender, receiver) = mpsc::channel();
        app.active_command = Some(ActiveCommand {
            label: "telegram send".to_string(),
            cancel_flag: Arc::new(AtomicBool::new(false)),
            receiver,
            cancel_requested: false,
            cancel_behavior: CancelBehavior::Standard,
            kind: ActiveCommandKind::TelegramSend {
                target_chat: Some("123456".to_string()),
            },
        });

        app.append_cli_result(CliBridgeResult {
            command_label: "telegram send --value hello".to_string(),
            stdout: "{\"ok\":true,\"messageId\":42,\"chatId\":\"123456\"}".to_string(),
            json: Some(json!({
                "ok": true,
                "messageId": 42,
                "chatId": "123456"
            })),
        });

        let contents = app
            .output_buffer
            .iter()
            .map(|line| line.content.as_str())
            .collect::<Vec<_>>();
        assert!(contents.iter().any(|line| line == &"Telegram send"));
        assert!(contents.iter().any(|line| line == &"Status: delivered"));
        assert!(contents.iter().any(|line| line == &"Target chat: 123456"));
        assert!(contents.iter().any(|line| line == &"Message ID: 42"));

        let last_send = app
            .last_telegram_send
            .as_ref()
            .expect("tracked telegram send");
        assert_eq!(last_send.outcome, TelegramSendOutcome::Delivered);
        assert_eq!(last_send.target_chat.as_deref(), Some("123456"));
        assert_eq!(last_send.message_id.as_deref(), Some("42"));
        assert_eq!(last_send.error, None);
    }

    #[test]
    fn failed_telegram_send_is_normalized_and_tracked() {
        let mut app = AppState::new(config());
        let (_sender, receiver) = mpsc::channel();
        app.active_command = Some(ActiveCommand {
            label: "telegram send".to_string(),
            cancel_flag: Arc::new(AtomicBool::new(false)),
            receiver,
            cancel_requested: false,
            cancel_behavior: CancelBehavior::Standard,
            kind: ActiveCommandKind::TelegramSend {
                target_chat: Some("ops-room".to_string()),
            },
        });

        app.append_cli_result(CliBridgeResult {
            command_label: "telegram send --to ops-room --value hello".to_string(),
            stdout: "{\"ok\":false,\"error\":\"Telegram API 401\"}".to_string(),
            json: Some(json!({
                "ok": false,
                "error": "Telegram API 401"
            })),
        });

        let contents = app
            .output_buffer
            .iter()
            .map(|line| line.content.as_str())
            .collect::<Vec<_>>();
        assert!(contents.iter().any(|line| line == &"Status: failed"));
        assert!(contents.iter().any(|line| line == &"Target chat: ops-room"));
        assert!(contents
            .iter()
            .any(|line| line == &"Error: Telegram API 401"));

        let last_send = app
            .last_telegram_send
            .as_ref()
            .expect("tracked telegram send");
        assert_eq!(last_send.outcome, TelegramSendOutcome::Failed);
        assert_eq!(last_send.target_chat.as_deref(), Some("ops-room"));
        assert_eq!(last_send.message_id, None);
        assert_eq!(last_send.error.as_deref(), Some("Telegram API 401"));
    }

    #[test]
    fn cancelled_telegram_send_leaves_cancelled_line_and_session_state() {
        let mut app = AppState::new(config());
        let (_sender, receiver) = mpsc::channel();
        app.active_command = Some(ActiveCommand {
            label: "telegram send".to_string(),
            cancel_flag: Arc::new(AtomicBool::new(false)),
            receiver,
            cancel_requested: true,
            cancel_behavior: CancelBehavior::Standard,
            kind: ActiveCommandKind::TelegramSend {
                target_chat: Some("ops-room".to_string()),
            },
        });

        assert!(app.apply_worker_event(WorkerEvent::Cancelled));

        let contents = app
            .output_buffer
            .iter()
            .map(|line| line.content.as_str())
            .collect::<Vec<_>>();
        assert!(contents.iter().any(|line| line == &"Telegram send"));
        assert!(contents.iter().any(|line| line == &"Status: cancelled"));
        assert!(contents.iter().any(|line| line == &"Target chat: ops-room"));

        let last_send = app
            .last_telegram_send
            .as_ref()
            .expect("tracked telegram send");
        assert_eq!(last_send.outcome, TelegramSendOutcome::Cancelled);
        assert_eq!(last_send.target_chat.as_deref(), Some("ops-room"));
        assert_eq!(last_send.message_id, None);
        assert_eq!(last_send.error, None);
    }

    #[test]
    fn shell_splitter_respects_quotes() {
        let tokens = split_command_tokens(r#"vault add API_KEY "secret value""#).unwrap();
        assert_eq!(tokens, vec!["vault", "add", "API_KEY", "secret value"]);
    }

    #[test]
    fn legacy_cli_fallback_notice_is_operator_visible() {
        let notice = legacy_cli_fallback_notice(&["health".to_string()]);

        assert!(notice.contains("Emergency CLI escape hatch"));
        assert!(notice.contains("health"));
        assert!(notice.contains("one-shot memphis --json compatibility path"));
    }

    #[test]
    fn unsupported_command_notice_points_to_help_and_legacy() {
        let notice = unsupported_tui_command_notice(&["banana".to_string()]);

        assert!(notice.contains("unsupported command"));
        assert!(notice.contains("/help"));
        assert!(notice.contains("/legacy banana"));
    }

    #[test]
    fn unknown_commands_fail_closed_instead_of_auto_fallback() {
        let mut app = AppState::new(config());
        let client = MemphisClient::new();

        app.execute_command("banana", &client);

        assert!(app.active_command.is_none());
        let contents = app
            .output_buffer
            .iter()
            .map(|line| line.content.as_str())
            .collect::<Vec<_>>();
        assert!(contents
            .iter()
            .any(|line| line.contains("unsupported command")));
        assert!(contents.iter().any(|line| line.contains("/legacy banana")));
        assert!(!contents
            .iter()
            .any(|line| line.contains("Legacy CLI bridge")));
    }

    #[test]
    fn legacy_prefix_requires_explicit_subcommand() {
        let mut app = AppState::new(config());
        let client = MemphisClient::new();

        app.execute_command("legacy", &client);

        assert!(app.active_command.is_none());
        let contents = app
            .output_buffer
            .iter()
            .map(|line| line.content.as_str())
            .collect::<Vec<_>>();
        assert!(contents
            .iter()
            .any(|line| line.contains("legacy requires a memphis CLI command")));
    }

    #[test]
    fn help_catalog_examples_resolve_to_declared_routes() {
        for entry in HELP_ENTRIES {
            let route = classify_input_route(entry.example)
                .unwrap_or_else(|error| panic!("{error}: {}", entry.example));
            assert_eq!(
                route, entry.route,
                "{} did not resolve to {:?}",
                entry.example, entry.route
            );
        }
    }

    #[test]
    fn apps_show_host_mapping_accepts_file_without_id() {
        let tokens =
            split_command_tokens("apps show --file /tmp/demo.json").expect("command tokens");
        let (command, _kind) = extension_host_command_for_tokens(&tokens)
            .expect("host mapping parse")
            .expect("apps show should resolve through the host");

        assert_eq!(command.command, "apps.show");
        assert_eq!(
            command.args.get("file").and_then(Value::as_str),
            Some("/tmp/demo.json")
        );
        assert!(command.args.get("id").is_some_and(Value::is_null));
    }

    #[test]
    fn help_lists_documented_host_backed_command_families() {
        let mut app = AppState::new(config());

        app.append_help();

        let contents = app
            .output_buffer
            .iter()
            .map(|line| line.content.as_str())
            .collect::<Vec<_>>();
        for command in [
            "/health",
            "/pulse",
            "/pulse status",
            "/init status",
            "/doctor [--fix] [--force] [--deep]",
            "/agents show <did>",
            "/sync status [--chain <name>]",
            "/apps show --file <manifest.json>",
            "/apps plan <id> [--file <manifest.json>] [--action <name>]",
            "/reflect [--save]",
            "/insights [--daily|--weekly|--topic <topic>] [--save]",
            "/knowledge <topic>",
            "/knowledge status",
            "/mode",
            "/mode <A|B|C|D|E>",
            "/config tools check <tool>",
            "/config tools pending",
            "/config surfaces list",
            "/config surfaces check <surface>",
            "/config surfaces set <surface> <setting> <value>",
            "/config surfaces reset <surface> [setting]",
        ] {
            assert!(
                contents.iter().any(|line| *line == command),
                "missing help entry for {command}"
            );
        }
    }

    #[test]
    fn doctor_host_result_is_normalized_for_operator_output() {
        let mut app = AppState::new(config());

        app.append_extension_host_result(ExtensionHostResult {
            command: "doctor.run".to_string(),
            data: json!({
                "ok": false,
                "summary": {
                    "pass": 3,
                    "warn": 2,
                    "fail": 1,
                    "requiredFailures": 1
                },
                "checks": [
                    {
                        "id": "vault",
                        "level": "warn",
                        "detail": "vault unavailable or not initialized"
                    },
                    {
                        "id": "did",
                        "level": "fail",
                        "detail": "missing DID identity file"
                    }
                ]
            }),
        });

        let contents = app
            .output_buffer
            .iter()
            .map(|line| line.content.as_str())
            .collect::<Vec<_>>();
        assert!(contents.iter().any(|line| *line == "Doctor"));
        assert!(contents
            .iter()
            .any(|line| line.contains("Summary: pass=3 warn=2 fail=1 required_failures=1")));
        assert!(contents
            .iter()
            .any(|line| line.contains("vault :: vault unavailable or not initialized")));
        assert!(contents
            .iter()
            .any(|line| line.contains("did :: missing DID identity file")));
        assert!(!contents.iter().any(|line| line.trim() == "{"));
    }

    #[test]
    fn agents_host_result_is_normalized_for_operator_output() {
        let mut app = AppState::new(config());

        app.append_extension_host_result(ExtensionHostResult {
            command: "agents.list".to_string(),
            data: json!({
                "ok": true,
                "mode": "agents-list",
                "count": 1,
                "agents": [
                    {
                        "did": "did:pc-zona",
                        "name": "pc-zona",
                        "endpoint": "ws://10.0.0.80:8787",
                        "status": "unknown",
                        "capabilities": ["sync.push", "sync.pull"]
                    }
                ]
            }),
        });

        let contents = app
            .output_buffer
            .iter()
            .map(|line| line.content.as_str())
            .collect::<Vec<_>>();
        assert!(contents.iter().any(|line| *line == "Agents list"));
        assert!(contents.iter().any(|line| *line == "Count: 1"));
        assert!(contents
            .iter()
            .any(|line| line.contains("pc-zona (did:pc-zona) :: unknown :: ws://10.0.0.80:8787")));
        assert!(contents
            .iter()
            .any(|line| line.contains("caps: sync.push, sync.pull")));
    }

    #[test]
    fn apps_plan_host_result_is_normalized_for_operator_output() {
        let mut app = AppState::new(config());

        app.append_extension_host_result(ExtensionHostResult {
            command: "apps.plan".to_string(),
            data: json!({
                "ok": true,
                "manifest": {
                    "id": "demo-app",
                    "name": "Demo App"
                },
                "action": "install",
                "summary": "print install token",
                "applyRequested": false,
                "willExecute": false,
                "requirements": [
                    {
                        "id": "platform",
                        "status": "pass",
                        "detail": "platform supported: linux"
                    }
                ],
                "steps": ["printf install-ready"]
            }),
        });

        let contents = app
            .output_buffer
            .iter()
            .map(|line| line.content.as_str())
            .collect::<Vec<_>>();
        assert!(contents.iter().any(|line| *line == "Managed app plan"));
        assert!(contents
            .iter()
            .any(|line| line.contains("Demo App (demo-app) :: install")));
        assert!(contents
            .iter()
            .any(|line| line.contains("applyRequested=false willExecute=false")));
        assert!(contents
            .iter()
            .any(|line| line.contains("platform :: platform supported: linux")));
        assert!(contents
            .iter()
            .any(|line| line.contains("Step 1: printf install-ready")));
    }

    #[test]
    fn config_tools_host_result_is_normalized_for_operator_output() {
        let mut app = AppState::new(config());

        app.append_extension_host_result(ExtensionHostResult {
            command: "config.tools.check".to_string(),
            data: json!({
                "tool": "shell",
                "allowed": false,
                "policy": "require-approval",
                "reason": "tool 'shell' requires approval"
            }),
        });

        let contents = app
            .output_buffer
            .iter()
            .map(|line| line.content.as_str())
            .collect::<Vec<_>>();
        assert!(contents.iter().any(|line| *line == "Config tools check"));
        assert!(contents
            .iter()
            .any(|line| line.contains("shell :: blocked (require-approval)")));
        assert!(contents
            .iter()
            .any(|line| line.contains("Reason: tool 'shell' requires approval")));
    }

    #[test]
    fn config_surfaces_check_host_result_is_normalized_for_operator_output() {
        let mut app = AppState::new(config());

        app.append_extension_host_result(ExtensionHostResult {
            command: "config.surfaces.check".to_string(),
            data: json!({
                "surface": "telegram",
                "policy": {
                    "surface": "telegram",
                    "surfaceClass": "chat",
                    "maxToolTier": 1,
                    "allowUnknownTools": false,
                    "allowUrlFetch": true,
                    "allowCognitivePrelude": true,
                    "allowMemoryRecall": true,
                    "allowMemoryWrite": true,
                    "allowOperatorOverride": false
                },
                "overrides": [
                    {
                        "setting": "maxToolTier",
                        "envKey": "MEMPHIS_SURFACE_TELEGRAM_MAX_TOOL_TIER",
                        "rawValue": "1"
                    },
                    {
                        "setting": "allowUrlFetch",
                        "envKey": "MEMPHIS_SURFACE_TELEGRAM_ALLOW_URL_FETCH",
                        "rawValue": "true"
                    }
                ]
            }),
        });

        let contents = app
            .output_buffer
            .iter()
            .map(|line| line.content.as_str())
            .collect::<Vec<_>>();
        assert!(contents.iter().any(|line| *line == "Config surfaces check"));
        assert!(contents
            .iter()
            .any(|line| line.contains("telegram :: class=chat tier=1")));
        assert!(contents.iter().any(|line| line.contains("Overrides: 2")));
        assert!(contents.iter().any(|line| line.contains("maxToolTier=1")));
        assert!(contents.iter().any(|line| line.contains("allowUrlFetch=true")));
    }

    #[test]
    fn config_surfaces_commands_map_to_host_requests() {
        let list_tokens =
            split_command_tokens("config surfaces list").expect("list command tokens");
        let (list_command, _kind) = extension_host_command_for_tokens(&list_tokens)
            .expect("list host mapping parse")
            .expect("config surfaces list should resolve through the host");
        assert_eq!(list_command.command, "config.surfaces.list");

        let check_tokens = split_command_tokens("config surfaces check telegram")
            .expect("check command tokens");
        let (check_command, _kind) = extension_host_command_for_tokens(&check_tokens)
            .expect("check host mapping parse")
            .expect("config surfaces check should resolve through the host");
        assert_eq!(check_command.command, "config.surfaces.check");
        assert_eq!(
            check_command.args.get("surface").and_then(Value::as_str),
            Some("telegram")
        );

        let set_tokens = split_command_tokens(
            "config surfaces set telegram allow-url-fetch true",
        )
        .expect("set command tokens");
        let (set_command, _kind) = extension_host_command_for_tokens(&set_tokens)
            .expect("set host mapping parse")
            .expect("config surfaces set should resolve through the host");
        assert_eq!(set_command.command, "config.surfaces.set");
        assert_eq!(
            set_command.args.get("surface").and_then(Value::as_str),
            Some("telegram")
        );
        assert_eq!(
            set_command.args.get("setting").and_then(Value::as_str),
            Some("allow-url-fetch")
        );
        assert_eq!(
            set_command.args.get("value").and_then(Value::as_str),
            Some("true")
        );

        let reset_tokens = split_command_tokens(
            "config surfaces reset telegram allow-url-fetch",
        )
        .expect("reset command tokens");
        let (reset_command, _kind) = extension_host_command_for_tokens(&reset_tokens)
            .expect("reset host mapping parse")
            .expect("config surfaces reset should resolve through the host");
        assert_eq!(reset_command.command, "config.surfaces.reset");
        assert_eq!(
            reset_command.args.get("setting").and_then(Value::as_str),
            Some("allow-url-fetch")
        );
    }

    #[test]
    fn pulse_and_mode_commands_map_to_host_requests() {
        let pulse_tokens = split_command_tokens("pulse").expect("pulse command tokens");
        let (pulse_command, _kind) = extension_host_command_for_tokens(&pulse_tokens)
            .expect("pulse host mapping parse")
            .expect("pulse should resolve through the host");
        assert_eq!(pulse_command.command, "pulse.status");

        let pulse_status_tokens =
            split_command_tokens("pulse status").expect("pulse status command tokens");
        let (pulse_status_command, _kind) = extension_host_command_for_tokens(&pulse_status_tokens)
            .expect("pulse status host mapping parse")
            .expect("pulse status should resolve through the host");
        assert_eq!(pulse_status_command.command, "pulse.status");

        let mode_tokens = split_command_tokens("mode").expect("mode command tokens");
        let (mode_command, _kind) = extension_host_command_for_tokens(&mode_tokens)
            .expect("mode host mapping parse")
            .expect("mode should resolve through the host");
        assert_eq!(mode_command.command, "cognitive.mode");
        assert_eq!(
            mode_command.args.get("subcommand").and_then(Value::as_str),
            Some("get")
        );

        let set_mode_tokens = split_command_tokens("mode c").expect("set mode command tokens");
        let (set_mode_command, _kind) = extension_host_command_for_tokens(&set_mode_tokens)
            .expect("set mode host mapping parse")
            .expect("mode set should resolve through the host");
        assert_eq!(set_mode_command.command, "cognitive.mode");
        assert_eq!(
            set_mode_command.args.get("subcommand").and_then(Value::as_str),
            Some("set")
        );
        assert_eq!(
            set_mode_command.args.get("mode").and_then(Value::as_str),
            Some("C")
        );
    }

    #[test]
    fn pulse_and_mode_host_results_are_normalized_for_operator_output() {
        let mut app = AppState::new(config());

        app.append_extension_host_result(ExtensionHostResult {
            command: "pulse.status".to_string(),
            data: json!({
                "summary": {
                    "totalEntries": 2,
                    "lastEvent": "heartbeat",
                    "lastHealth": "healthy",
                    "lastTimestamp": "2026-04-02T12:00:00.000Z",
                    "uptimeSeconds": 321
                },
                "entries": [
                    {
                        "timestamp": "2026-04-02T11:59:00.000Z",
                        "event": "bootstrap",
                        "health": "healthy",
                        "detail": "runtime ready"
                    },
                    {
                        "timestamp": "2026-04-02T12:00:00.000Z",
                        "event": "heartbeat",
                        "health": "healthy",
                        "detail": "scheduler workers healthy"
                    }
                ]
            }),
        });

        app.append_extension_host_result(ExtensionHostResult {
            command: "cognitive.mode".to_string(),
            data: json!({
                "previousMode": "A",
                "mode": "C",
                "config": {
                    "name": "PredictivePatterns",
                    "temperature": 0.7,
                    "style": "reflective",
                    "pattern": "analogical",
                    "description": "Pattern recognition and prediction — analogical thinking"
                }
            }),
        });

        let contents = app
            .output_buffer
            .iter()
            .map(|line| line.content.as_str())
            .collect::<Vec<_>>();
        assert!(contents.iter().any(|line| *line == "PULSE"));
        assert!(contents
            .iter()
            .any(|line| line.contains("Entries: 2 :: last event=heartbeat :: health=healthy")));
        assert!(contents
            .iter()
            .any(|line| line.contains("scheduler workers healthy")));
        assert!(contents.iter().any(|line| *line == "Cognitive mode"));
        assert!(contents
            .iter()
            .any(|line| line.contains("Mode: A -> C (PredictivePatterns)")));
        assert!(contents
            .iter()
            .any(|line| line.contains("Temperature: 0.7")));
    }

    #[test]
    fn knowledge_shorthand_maps_to_host_query_command() {
        let tokens = split_command_tokens("knowledge Rust TUI").expect("command tokens");
        let (command, _kind) = extension_host_command_for_tokens(&tokens)
            .expect("host mapping parse")
            .expect("knowledge should resolve through the host");

        assert_eq!(command.command, "knowledge.query");
        assert_eq!(
            command.args.get("topic").and_then(Value::as_str),
            Some("Rust TUI")
        );
    }

    #[test]
    fn knowledge_query_flags_map_to_host_query_command() {
        let tokens = split_command_tokens(
            "knowledge query --topic architecture --source architecture-model --limit 2",
        )
        .expect("command tokens");
        let (command, _kind) = extension_host_command_for_tokens(&tokens)
            .expect("host mapping parse")
            .expect("knowledge query should resolve through the host");

        assert_eq!(command.command, "knowledge.query");
        assert_eq!(
            command.args.get("topic").and_then(Value::as_str),
            Some("architecture")
        );
        assert_eq!(
            command.args.get("source").and_then(Value::as_str),
            Some("architecture-model")
        );
        assert_eq!(command.args.get("limit").and_then(Value::as_u64), Some(2));
    }

    #[test]
    fn knowledge_host_result_is_normalized_for_operator_output() {
        let mut app = AppState::new(config());

        app.append_extension_host_result(ExtensionHostResult {
            command: "knowledge.query".to_string(),
            data: json!({
                "topic": "workspace",
                "hits": [
                    {
                        "sourceId": "workspace-context",
                        "section": "Workspace summary",
                        "snippet": "Workspace: memphis Purpose: Shared Memphis workspace",
                    }
                ]
            }),
        });

        let contents = app
            .output_buffer
            .iter()
            .map(|line| line.content.as_str())
            .collect::<Vec<_>>();
        assert!(contents.iter().any(|line| *line == "Knowledge"));
        assert!(contents.iter().any(|line| *line == "Topic: workspace"));
        assert!(contents
            .iter()
            .any(|line| line.contains("workspace-context :: Workspace summary")));
        assert!(contents
            .iter()
            .any(|line| line.contains("Shared Memphis workspace")));
    }
}
