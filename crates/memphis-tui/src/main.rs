mod app;
mod client;
mod config;
mod sanitize;
mod ui;
mod widgets;

use std::{
    env,
    process::ExitCode,
    sync::mpsc,
    thread,
    time::{Duration, Instant},
};

use app::{
    classify_input_route, AppAction, AppState, CommandRoute, LineTone, MouseCaptureToast,
    StyledLine,
};
use client::MemphisClient;
use config::TuiConfig;
use crossterm::{
    cursor::{Hide, Show},
    event::{
        self, DisableMouseCapture, EnableMouseCapture, Event, MouseEvent, MouseEventKind,
    },
    execute,
    terminal::{disable_raw_mode, enable_raw_mode, EnterAlternateScreen, LeaveAlternateScreen},
};
use serde::Serialize;

/// Set UTF-8 locale environment variables for proper Unicode support
/// This ensures Polish characters and other non-ASCII text render correctly in the terminal
fn setup_utf8_locale() {
    // Try to set locale to a UTF-8 variant
    let utf8_locales = ["en_US.UTF-8", "C.UTF-8", "POSIX.UTF-8", "pl_PL.UTF-8"];

    for locale in &utf8_locales {
        if env::var("LANG").is_err() {
            env::set_var("LANG", locale);
        }
        if env::var("LC_ALL").is_err() {
            env::set_var("LC_ALL", locale);
        }
        // Test if locale is available (doesn't fail on most systems even if not installed)
        if std::process::Command::new("locale")
            .arg("-a")
            .output()
            .map(|o| String::from_utf8_lossy(&o.stdout).contains(locale))
            .unwrap_or(false)
        {
            env::set_var("LANG", locale);
            env::set_var("LC_ALL", locale);
            break;
        }
    }
}

struct TerminalGuard {
    mouse_captured: bool,
}

/// Mouse capture is OPT-IN. By default the operator can select + copy
/// text from the TUI like any other terminal app — Memphis runs in
/// long-lived sessions where copying log output is the dominant use
/// case, and losing that to gain scroll-wheel events is a bad trade.
///
/// Set `MEMPHIS_TUI_MOUSE_SCROLL=1` to enable mouse-wheel scrolling.
/// While capture is active, terminal text selection requires holding
/// Shift on most Linux/X11 emulators (Option/Alt on macOS Terminal).
/// Keyboard scroll keys (PageUp/PgDn, Ctrl+U/D, g/G, Alt+↑/↓, Home/End)
/// always work regardless of this flag.
fn mouse_capture_enabled() -> bool {
    std::env::var("MEMPHIS_TUI_MOUSE_SCROLL")
        .ok()
        .map(|v| matches!(v.as_str(), "1" | "true" | "yes" | "on"))
        .unwrap_or(false)
}

impl TerminalGuard {
    fn enter() -> std::io::Result<Self> {
        setup_utf8_locale();
        enable_raw_mode()?;
        let mouse_captured = mouse_capture_enabled();
        if mouse_captured {
            execute!(
                std::io::stdout(),
                EnterAlternateScreen,
                EnableMouseCapture,
                Hide
            )?;
        } else {
            execute!(std::io::stdout(), EnterAlternateScreen, Hide)?;
        }
        Ok(Self { mouse_captured })
    }
}

impl Drop for TerminalGuard {
    fn drop(&mut self) {
        let _ = disable_raw_mode();
        if self.mouse_captured {
            let _ = execute!(
                std::io::stdout(),
                Show,
                DisableMouseCapture,
                LeaveAlternateScreen
            );
        } else {
            let _ = execute!(std::io::stdout(), Show, LeaveAlternateScreen);
        }
    }
}

#[derive(Debug, Clone, Default)]
struct CliArgs {
    check_only: bool,
    json: bool,
    run_command: Option<String>,
}

impl CliArgs {
    fn from_env() -> Result<Self, String> {
        Self::from_env_args(std::env::args())
    }

    fn from_env_args<I, T>(values: I) -> Result<Self, String>
    where
        I: IntoIterator<Item = T>,
        T: Into<String>,
    {
        let mut args = Self::default();
        let collected = values.into_iter().map(Into::into).collect::<Vec<String>>();
        let mut index = 1usize;

        while let Some(value) = collected.get(index) {
            match value.as_str() {
                "--check-only" => args.check_only = true,
                "--json" => args.json = true,
                "--run-command" => {
                    let Some(command) = collected.get(index + 1) else {
                        return Err("--run-command requires an input string.".to_string());
                    };
                    if args.run_command.is_some() {
                        return Err("--run-command specified more than once.".to_string());
                    }
                    args.run_command = Some(command.clone());
                    index += 1;
                }
                "--help" | "-h" => {
                    print_usage();
                    return Err(String::new());
                }
                unknown => return Err(format!("unsupported memphis-tui flag: {unknown}")),
            }
            index += 1;
        }

        if args.check_only && args.run_command.is_some() {
            return Err("--check-only and --run-command cannot be used together.".to_string());
        }

        if args.run_command.is_some() && !args.json {
            return Err("--run-command requires --json.".to_string());
        }

        Ok(args)
    }
}

#[derive(Debug, Serialize)]
struct CheckOnlyReport {
    mode: &'static str,
    #[serde(rename = "uiMode")]
    ui_mode: &'static str,
    #[serde(rename = "rendererMode")]
    renderer_mode: &'static str,
    ok: bool,
    data_dir: String,
    refresh_interval_ms: u64,
    surfaces: Vec<&'static str>,
    provider_status_count: usize,
    chat_session_id: String,
    snapshot: client::AppSnapshot,
    errors: Vec<CheckOnlyError>,
}

#[derive(Debug, Serialize)]
struct CheckOnlyError {
    section: &'static str,
    message: String,
}

#[derive(Debug, Serialize)]
struct RunCommandReport {
    mode: &'static str,
    command: String,
    ok: bool,
    route: &'static str,
    transcript: Vec<RunCommandLine>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

#[derive(Debug, Serialize)]
struct RunCommandLine {
    tone: &'static str,
    content: String,
}

fn main() -> ExitCode {
    let args = match CliArgs::from_env() {
        Ok(args) => args,
        Err(message) if message.is_empty() => return ExitCode::SUCCESS,
        Err(message) => {
            eprintln!("{message}");
            return ExitCode::from(2);
        }
    };

    let config = TuiConfig::from_env();
    let mut client = MemphisClient::new();
    let mut app = AppState::new(config.clone());
    app.refresh(&client);

    if args.check_only {
        return run_check_only(&app, &client, args.json);
    }

    if let Some(command) = args.run_command {
        return run_command(&mut app, &mut client, &command, args.json);
    }

    let _terminal = match TerminalGuard::enter() {
        Ok(terminal) => terminal,
        Err(error) => {
            eprintln!("failed to enter terminal mode: {error}");
            return ExitCode::FAILURE;
        }
    };
    let mut last_refresh = Instant::now();
    let mut renderer = match ui::UiRenderer::new() {
        Ok(renderer) => renderer,
        Err(error) => {
            eprintln!("failed to create UI renderer: {error}");
            return ExitCode::FAILURE;
        }
    };

    // Refresh used to run inline on the main loop — `app.refresh(&client)`
    // does vault decrypt + provider HTTP pings + memory snapshot, totalling
    // 5–15s on a populated runtime. Every keystroke had to wait for the
    // refresh cadence to clear before crossterm could read the input.
    // Operator hit visible 15s lag on every keystroke 2026-04-29.
    //
    // We now spawn refresh on a background thread when the cadence elapses
    // and read the result via a non-blocking try_recv. Only one refresh is
    // in flight at a time (skip the next tick if the previous hasn't
    // finished). Each background task creates its own MemphisClient — vault
    // entry reads are file-open + AES-GCM decrypt, safe to do concurrently
    // with the main thread (no shared mutable state, no locking required).
    let mut pending_refresh: Option<mpsc::Receiver<RefreshResult>> = None;

    loop {
        app.poll_active_command();

        if let Err(error) = renderer.draw(&app) {
            eprintln!("failed to draw Rust TUI: {error}");
            return ExitCode::FAILURE;
        }

        // Drain any background refresh that finished since the last tick.
        if let Some(rx) = pending_refresh.as_ref() {
            match rx.try_recv() {
                Ok(result) => {
                    app.apply_refresh_snapshot(result.snapshot, result.provider_statuses);
                    pending_refresh = None;
                }
                Err(mpsc::TryRecvError::Empty) => {
                    // Worker still running; leave the receiver in place,
                    // try again next tick. Main loop continues.
                }
                Err(mpsc::TryRecvError::Disconnected) => {
                    // Worker thread crashed/exited without sending. Drop
                    // the receiver and let the next cadence kick a fresh
                    // attempt. We don't surface this to the operator —
                    // the previous snapshot stays on screen, which is
                    // strictly better than blocking the UI on the failure.
                    pending_refresh = None;
                }
            }
        }

        // Kick a new background refresh when the cadence elapses AND no
        // previous refresh is still running.
        if pending_refresh.is_none() && last_refresh.elapsed() >= config.refresh_interval {
            pending_refresh = Some(spawn_refresh());
            last_refresh = Instant::now();
        }

        let poll_interval = if app.has_active_command() {
            Duration::from_millis(50)
        } else {
            Duration::from_millis(250)
        };

        let should_poll = match event::poll(poll_interval) {
            Ok(value) => value,
            Err(error) => {
                eprintln!("failed to poll terminal events: {error}");
                return ExitCode::FAILURE;
            }
        };

        if should_poll {
            let next_event = match event::read() {
                Ok(value) => value,
                Err(error) => {
                    eprintln!("failed to read terminal event: {error}");
                    return ExitCode::FAILURE;
                }
            };

            // Mouse wheel → scroll the body. Other mouse events
            // (click, drag) are intentionally ignored — we don't have
            // a mouse-driven UI, only scroll. Three-line steps match
            // most terminal expectations.
            if let Event::Mouse(MouseEvent { kind, .. }) = next_event {
                match kind {
                    MouseEventKind::ScrollUp => renderer.scroll_up(3),
                    MouseEventKind::ScrollDown => renderer.scroll_down(3),
                    _ => {}
                }
                continue;
            }

            if let Event::Key(key) = next_event {
                match app.handle_key(key) {
                    AppAction::InterruptOrQuit => {
                        if !app.interrupt_active_command() {
                            break;
                        }
                    }
                    AppAction::Refresh => {
                        // Operator pressed F5 / Ctrl-R — force an immediate
                        // background refresh even if cadence hasn't elapsed.
                        // Replaces any previously-in-flight refresh.
                        pending_refresh = Some(spawn_refresh());
                        last_refresh = Instant::now();
                    }
                    AppAction::SubmitInput => {
                        app.execute_input(&mut client);
                    }
                    AppAction::ClearOutput => {
                        app.clear_output();
                    }
                    AppAction::ScrollUp => renderer.scroll_up(1),
                    AppAction::ScrollDown => renderer.scroll_down(1),
                    AppAction::PageUp => renderer.page_up(),
                    AppAction::PageDown => renderer.page_down(),
                    AppAction::HalfPageUp => renderer.half_page_up(),
                    AppAction::HalfPageDown => renderer.half_page_down(),
                    AppAction::ScrollTop => renderer.scroll_to_top(),
                    AppAction::ScrollBottom => renderer.scroll_to_bottom(),
                    AppAction::ToggleHelp => app.help_visible = !app.help_visible,
                    AppAction::ToggleMouseCapture => {
                        // Flip the runtime mouse-capture flag and
                        // tell the terminal — the existing scroll-
                        // wheel handler in the main loop only fires
                        // when capture is on, so toggling is safe.
                        let new_state = !app.mouse_captured;
                        let result = if new_state {
                            execute!(std::io::stdout(), EnableMouseCapture)
                        } else {
                            execute!(std::io::stdout(), DisableMouseCapture)
                        };
                        if result.is_ok() {
                            app.mouse_captured = new_state;
                            app.mouse_capture_toast =
                                Some(MouseCaptureToast::fresh(new_state));
                        }
                    }
                    AppAction::None => {}
                }
            }
        }
    }

    ExitCode::SUCCESS
}

struct RefreshResult {
    snapshot: client::AppSnapshot,
    provider_statuses: Vec<client::ProviderStatus>,
}

/// Spawn a background thread that builds a fresh MemphisClient (so the
/// main thread's client stays untouched), does the slow snapshot +
/// provider-statuses calls, and returns the result through a channel.
/// The receiver is non-blocking — the main loop polls it via try_recv.
fn spawn_refresh() -> mpsc::Receiver<RefreshResult> {
    let (tx, rx) = mpsc::channel();
    thread::spawn(move || {
        let bg_client = MemphisClient::new();
        let snapshot = bg_client.fetch_snapshot();
        let provider_statuses = bg_client.provider_statuses();
        // Receiver may already be dropped if the operator quit between
        // spawn and finish — ignore the send error in that case.
        let _ = tx.send(RefreshResult {
            snapshot,
            provider_statuses,
        });
    });
    rx
}

fn print_usage() {
    println!("memphis-tui [--check-only --json] [--run-command '<input>' --json]");
}

fn run_check_only(app: &AppState, client: &MemphisClient, json: bool) -> ExitCode {
    let report = build_check_only_report(app, client);

    if json {
        match serde_json::to_string_pretty(&report) {
            Ok(payload) => println!("{payload}"),
            Err(error) => {
                eprintln!("failed to serialize check-only report: {error}");
                return ExitCode::FAILURE;
            }
        }
    } else {
        println!("memphis-tui check-only");
        println!("ui_mode={}", report.ui_mode);
        println!("data_dir={}", report.data_dir);
        println!("refresh_interval_ms={}", report.refresh_interval_ms);
        println!("surfaces={}", report.surfaces.join(", "));
        println!("provider_status_count={}", report.provider_status_count);
        println!("chat_session_id={}", report.chat_session_id);
        if report.errors.is_empty() {
            println!("status=ok");
        } else {
            println!("status=error");
            for error in &report.errors {
                println!("error[{}]={}", error.section, error.message);
            }
        }
    }

    if report.ok {
        ExitCode::SUCCESS
    } else {
        ExitCode::from(2)
    }
}

fn build_check_only_report(app: &AppState, client: &MemphisClient) -> CheckOnlyReport {
    let chat_error = client
        .load_chat_session(Some(app.chat_session_id.as_str()), 20)
        .err();

    build_check_only_report_from_parts(app, chat_error)
}

fn build_check_only_report_from_parts(
    app: &AppState,
    chat_error: Option<String>,
) -> CheckOnlyReport {
    let mut errors = collect_snapshot_errors(&app.snapshot);

    if let Some(error) = chat_error {
        errors.push(CheckOnlyError {
            section: "chat",
            message: error,
        });
    }

    CheckOnlyReport {
        mode: "check-only",
        ui_mode: "single-view",
        renderer_mode: ui::renderer_mode(),
        ok: errors.is_empty(),
        data_dir: app.config.data_dir.display().to_string(),
        refresh_interval_ms: app.config.refresh_interval.as_millis() as u64,
        surfaces: app.surfaces(),
        provider_status_count: app.provider_statuses.len(),
        chat_session_id: app.chat_session_id.clone(),
        snapshot: app.snapshot.clone(),
        errors,
    }
}

fn run_command(app: &mut AppState, client: &mut MemphisClient, command: &str, json: bool) -> ExitCode {
    let report = execute_run_command(app, client, command, Duration::from_secs(30));

    if json {
        match serde_json::to_string_pretty(&report) {
            Ok(payload) => println!("{payload}"),
            Err(error) => {
                eprintln!("failed to serialize run-command report: {error}");
                return ExitCode::FAILURE;
            }
        }
    } else {
        println!("memphis-tui run-command");
        println!("command={}", report.command);
        println!("route={}", report.route);
        println!("status={}", if report.ok { "ok" } else { "error" });
        if let Some(error) = &report.error {
            println!("error={error}");
        }
        for line in &report.transcript {
            println!("[{}] {}", line.tone, line.content);
        }
    }

    if report.ok {
        ExitCode::SUCCESS
    } else {
        ExitCode::from(2)
    }
}

fn execute_run_command(
    app: &mut AppState,
    client: &mut MemphisClient,
    command: &str,
    timeout: Duration,
) -> RunCommandReport {
    app.clear_output();
    app.input_buffer = command.trim().to_string();
    let route = classify_input_route(command).unwrap_or(CommandRoute::Unsupported);
    app.execute_input(client);

    let started = Instant::now();
    while app.has_active_command() && started.elapsed() < timeout {
        thread::sleep(Duration::from_millis(10));
        app.poll_active_command();
    }
    app.poll_active_command();

    let mut error = first_error_line(&app.output_buffer);
    if app.has_active_command() {
        if app.interrupt_active_command() {
            thread::sleep(Duration::from_millis(20));
            app.poll_active_command();
        }
        error = Some(format!(
            "timed out waiting for command completion after {}ms",
            timeout.as_millis()
        ));
    }

    let transcript = app
        .output_buffer
        .iter()
        .cloned()
        .map(run_command_line)
        .collect::<Vec<_>>();

    RunCommandReport {
        mode: "run-command",
        command: command.trim().to_string(),
        ok: error.is_none(),
        route: route.as_str(),
        transcript,
        error,
    }
}

fn run_command_line(line: StyledLine) -> RunCommandLine {
    RunCommandLine {
        tone: line.tone.as_str(),
        content: line.content,
    }
}

fn first_error_line(lines: &[StyledLine]) -> Option<String> {
    lines
        .iter()
        .find(|line| line.tone == LineTone::Error)
        .map(|line| line.content.clone())
}

fn collect_snapshot_errors(snapshot: &client::AppSnapshot) -> Vec<CheckOnlyError> {
    [
        ("overview", snapshot.overview_error.as_deref()),
        ("memory", snapshot.memory_error.as_deref()),
        ("sessions", snapshot.sessions_error.as_deref()),
        ("vault", snapshot.vault_error.as_deref()),
        ("cases", snapshot.cases_error.as_deref()),
        ("system", snapshot.system_error.as_deref()),
    ]
    .into_iter()
    .filter_map(|(section, message)| {
        message.map(|message| CheckOnlyError {
            section,
            message: message.to_string(),
        })
    })
    .collect()
}

#[cfg(test)]
mod tests {
    use super::{build_check_only_report_from_parts, execute_run_command, CliArgs};
    use crate::{app::AppState, client::MemphisClient, config::TuiConfig};
    use memphis_operator::{
        MatrixReadinessSummary, OperatorSnapshot, SystemSummary, TelegramReadinessSummary,
    };
    use std::{path::PathBuf, time::Duration};

    #[test]
    fn parses_check_only_and_json_flags() {
        let args = CliArgs::from_env_args(["memphis-tui", "--check-only", "--json"]).unwrap();
        assert!(args.check_only);
        assert!(args.json);
    }

    #[test]
    fn parses_run_command_and_json_flags() {
        let args = CliArgs::from_env_args([
            "memphis-tui",
            "--run-command",
            "/config tools list",
            "--json",
        ])
        .unwrap();
        assert_eq!(args.run_command.as_deref(), Some("/config tools list"));
        assert!(args.json);
    }

    #[test]
    fn rejects_unknown_flags() {
        let error = CliArgs::from_env_args(["memphis-tui", "--bogus"]).unwrap_err();
        assert!(error.contains("unsupported memphis-tui flag"));
    }

    #[test]
    fn rejects_run_command_without_json() {
        let error = CliArgs::from_env_args(["memphis-tui", "--run-command", "/config tools list"])
            .unwrap_err();
        assert!(error.contains("--run-command requires --json"));
    }

    #[test]
    fn rejects_conflicting_check_only_and_run_command() {
        let error = CliArgs::from_env_args([
            "memphis-tui",
            "--check-only",
            "--run-command",
            "/overview",
            "--json",
        ])
        .unwrap_err();
        assert!(error.contains("--check-only and --run-command"));
    }

    #[test]
    fn check_only_report_collects_snapshot_errors() {
        let config = TuiConfig {
            data_dir: PathBuf::from("/tmp/memphis"),
            refresh_interval: Duration::from_millis(750),
        };
        let mut app = AppState::new(config);
        app.snapshot = OperatorSnapshot {
            memory_error: Some("memory unavailable".to_string()),
            ..OperatorSnapshot::default()
        };

        let report = build_check_only_report_from_parts(&app, Some("chat unavailable".to_string()));

        assert!(!report.ok);
        assert_eq!(report.mode, "check-only");
        assert_eq!(report.ui_mode, "single-view");
        assert_eq!(report.renderer_mode, "ratatui");
        assert_eq!(
            report.surfaces,
            vec!["Overview", "Chat", "Memory", "Sessions", "Vault", "Cases", "System"]
        );
        let serialized = serde_json::to_value(&report).expect("serialize report");
        assert!(serialized.get("screens").is_none());
        assert!(report.errors.iter().any(|error| error.section == "memory"));
        assert!(report.errors.iter().any(|error| error.section == "chat"));
    }

    #[test]
    fn check_only_report_preserves_native_integration_status() {
        let config = TuiConfig {
            data_dir: PathBuf::from("/tmp/memphis"),
            refresh_interval: Duration::from_millis(750),
        };
        let mut app = AppState::new(config);
        app.snapshot = OperatorSnapshot {
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
            ..OperatorSnapshot::default()
        };

        let report = build_check_only_report_from_parts(&app, None);

        let system = report.snapshot.system.expect("system snapshot");
        assert_eq!(system.matrix.access_token_source, "vault-ref");
        assert_eq!(system.telegram.state, "ready");
    }

    #[test]
    fn run_command_reports_native_route_and_transcript() {
        let config = TuiConfig {
            data_dir: PathBuf::from("/tmp/memphis"),
            refresh_interval: Duration::from_millis(750),
        };
        let mut client = MemphisClient::new();
        let mut app = AppState::new(config);
        app.refresh(&client);

        let report = execute_run_command(&mut app, &mut client, "/overview", Duration::from_millis(10));

        assert!(report.ok);
        assert_eq!(report.mode, "run-command");
        assert_eq!(report.route, "native");
        assert!(report
            .transcript
            .iter()
            .any(|line| line.content.contains("Overview")));
    }

    #[test]
    fn run_command_reports_fail_closed_errors() {
        let config = TuiConfig {
            data_dir: PathBuf::from("/tmp/memphis"),
            refresh_interval: Duration::from_millis(750),
        };
        let mut client = MemphisClient::new();
        let mut app = AppState::new(config);
        app.refresh(&client);

        let report = execute_run_command(&mut app, &mut client, "/banana", Duration::from_millis(10));

        assert!(!report.ok);
        assert_eq!(report.route, "unsupported");
        assert!(report
            .error
            .as_deref()
            .is_some_and(|error| error.contains("unsupported command")));
    }
}
