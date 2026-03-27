mod app;
mod client;
mod config;
mod ui;

use std::{
    process::ExitCode,
    time::{Duration, Instant},
};

use app::{AppAction, AppState};
use client::MemphisClient;
use config::TuiConfig;
use crossterm::{
    event::{self, Event},
    execute,
    terminal::{disable_raw_mode, enable_raw_mode, EnterAlternateScreen, LeaveAlternateScreen},
};
use serde::Serialize;

struct TerminalGuard;

impl TerminalGuard {
    fn enter() -> std::io::Result<Self> {
        enable_raw_mode()?;
        execute!(std::io::stdout(), EnterAlternateScreen)?;
        Ok(Self)
    }
}

impl Drop for TerminalGuard {
    fn drop(&mut self) {
        let _ = disable_raw_mode();
        let _ = execute!(std::io::stdout(), LeaveAlternateScreen);
    }
}

#[derive(Debug, Clone, Copy, Default)]
struct CliArgs {
    check_only: bool,
    json: bool,
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

        for value in values.into_iter().skip(1).map(Into::into) {
            match value.as_str() {
                "--check-only" => args.check_only = true,
                "--json" => args.json = true,
                "--help" | "-h" => {
                    print_usage();
                    return Err(String::new());
                }
                unknown => return Err(format!("unsupported memphis-tui flag: {unknown}")),
            }
        }

        Ok(args)
    }
}

#[derive(Debug, Serialize)]
struct CheckOnlyReport {
    mode: &'static str,
    #[serde(rename = "uiMode")]
    ui_mode: &'static str,
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
    let client = MemphisClient::new();
    let mut app = AppState::new(config.clone());
    app.refresh(&client);

    if args.check_only {
        return run_check_only(&app, &client, args.json);
    }

    let _terminal = match TerminalGuard::enter() {
        Ok(terminal) => terminal,
        Err(error) => {
            eprintln!("failed to enter terminal mode: {error}");
            return ExitCode::FAILURE;
        }
    };
    let mut last_refresh = Instant::now();

    loop {
        app.poll_active_command();

        if let Err(error) = ui::draw(&app) {
            eprintln!("failed to draw Rust TUI: {error}");
            return ExitCode::FAILURE;
        }

        if last_refresh.elapsed() >= config.refresh_interval {
            app.refresh(&client);
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

            if let Event::Key(key) = next_event {
                match app.handle_key(key) {
                    AppAction::InterruptOrQuit => {
                        if !app.interrupt_active_command() {
                            break;
                        }
                    }
                    AppAction::Refresh => {
                        app.refresh(&client);
                        last_refresh = Instant::now();
                    }
                    AppAction::SubmitInput => {
                        app.execute_input(&client);
                    }
                    AppAction::ClearOutput => {
                        app.clear_output();
                    }
                    AppAction::None => {}
                }
            }
        }
    }

    ExitCode::SUCCESS
}

fn print_usage() {
    println!("memphis-tui [--check-only --json]");
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
    use super::{build_check_only_report_from_parts, CliArgs};
    use crate::{app::AppState, config::TuiConfig};
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
    fn rejects_unknown_flags() {
        let error = CliArgs::from_env_args(["memphis-tui", "--bogus"]).unwrap_err();
        assert!(error.contains("unsupported memphis-tui flag"));
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
}
