//! Tests for the `app` module — slash command parsing, host-result
//! rendering, worker-event handling, screen state.
//!
//! Extracted from the inline `#[cfg(test)] mod tests` block in
//! `app/mod.rs` (S4 PR 3). All `super::*` paths still resolve because
//! this is a child module of `app` and inherits parent's items.

use super::{
    classify_input_route, extension_host_command_for_tokens, legacy_cli_fallback_notice,
    split_command_tokens, unsupported_tui_command_notice, ActiveCommand, ActiveCommandKind,
    AppAction, AppState, CancelBehavior, DegradationState, LineTone, ModelCapabilitySummary,
    Screen, TelegramSendOutcome, TokenUsageSummary, WorkerEvent, HELP_ENTRIES,
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
            cognitive_mode_name: Some("ConsciousCapture".to_string()),
            cognitive_mode_temperature: Some(0.3),
            cognitive_mode_style: Some("fast".to_string()),
            cognitive_mode_pattern: Some("concise".to_string()),
            cognitive_mode_last_modified: None,
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
            cognitive_mode_name: Some("ConsciousCapture".to_string()),
            cognitive_mode_temperature: Some(0.3),
            cognitive_mode_style: Some("fast".to_string()),
            cognitive_mode_pattern: Some("concise".to_string()),
            cognitive_mode_last_modified: None,
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
            cognitive_mode_name: Some("ConsciousCapture".to_string()),
            cognitive_mode_temperature: Some(0.3),
            cognitive_mode_style: Some("fast".to_string()),
            cognitive_mode_pattern: Some("concise".to_string()),
            cognitive_mode_last_modified: None,
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
    assert!(contents.iter().any(|line| line.contains("ollama")
        && line.contains("[up]")
        && line.contains("ctx:8k")));
    assert!(contents.iter().any(|line| line.contains("deepseek")
        && line.contains("[down][!]")
        && line.contains("ctx:64k")));
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

    assert!(contents.iter().any(
        |line| line.contains("Degradation: active via local-fallback (provider cooldown)")
    ));
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
        "/guide",
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
    assert!(contents
        .iter()
        .any(|line| line.contains("allowUrlFetch=true")));
}

#[test]
fn config_surfaces_commands_map_to_host_requests() {
    let guide_tokens = split_command_tokens("guide").expect("guide command tokens");
    let (guide_command, _kind) = extension_host_command_for_tokens(&guide_tokens)
        .expect("guide host mapping parse")
        .expect("guide should resolve through the host");
    assert_eq!(guide_command.command, "guide.show");

    let list_tokens =
        split_command_tokens("config surfaces list").expect("list command tokens");
    let (list_command, _kind) = extension_host_command_for_tokens(&list_tokens)
        .expect("list host mapping parse")
        .expect("config surfaces list should resolve through the host");
    assert_eq!(list_command.command, "config.surfaces.list");

    let check_tokens =
        split_command_tokens("config surfaces check telegram").expect("check command tokens");
    let (check_command, _kind) = extension_host_command_for_tokens(&check_tokens)
        .expect("check host mapping parse")
        .expect("config surfaces check should resolve through the host");
    assert_eq!(check_command.command, "config.surfaces.check");
    assert_eq!(
        check_command.args.get("surface").and_then(Value::as_str),
        Some("telegram")
    );

    let set_tokens = split_command_tokens("config surfaces set telegram allow-url-fetch true")
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

    let reset_tokens = split_command_tokens("config surfaces reset telegram allow-url-fetch")
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
fn guide_host_result_is_normalized_for_operator_output() {
    let mut app = AppState::new(config());

    app.append_extension_host_result(ExtensionHostResult {
        command: "guide.show".to_string(),
        data: json!({
            "agentName": "Memphis Agent",
            "ownerName": "local operator",
            "profileSource": "default",
            "sections": [
                {
                    "title": "Surfaces",
                    "lines": [
                        "Rust TUI is the authoritative operator cockpit.",
                        "Telegram is a companion gateway surface."
                    ]
                }
            ]
        }),
    });

    let contents = app
        .output_buffer
        .iter()
        .map(|line| line.content.as_str())
        .collect::<Vec<_>>();
    assert!(contents.iter().any(|line| *line == "Operator guide"));
    assert!(contents.iter().any(|line| {
        line.contains("Identity: Memphis Agent owned by local operator (source=default)")
    }));
    assert!(contents.iter().any(|line| *line == "Surfaces"));
    assert!(contents
        .iter()
        .any(|line| line.contains("Rust TUI is the authoritative operator cockpit.")));
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
        set_mode_command
            .args
            .get("subcommand")
            .and_then(Value::as_str),
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

fn transcript_lines(app: &AppState) -> Vec<String> {
    app.output_buffer
        .iter()
        .map(|line| line.content.clone())
        .collect()
}

#[test]
fn stream_preserves_newline_between_chunks() {
    // Regression for H2: the previous per-chunk trim flattened
    // the `\n` between `line1` (chunk A) and `line2` (chunk B)
    // because it landed at the chunk boundary. With boundary
    // buffering, the delimiter is re-emitted once chunk B
    // confirms it was paragraph separation, not end padding.
    let mut app = AppState::new(config());
    app.apply_worker_event(WorkerEvent::ChatChunk {
        tone: LineTone::Plain,
        chunk: "line1\n".to_string(),
    });
    app.apply_worker_event(WorkerEvent::ChatChunk {
        tone: LineTone::Plain,
        chunk: "line2".to_string(),
    });

    let lines = transcript_lines(&app);
    let window = lines.iter().skip_while(|l| !l.ends_with("line1")).collect::<Vec<_>>();
    assert!(window.iter().any(|l| l.ends_with("line1")), "line1 not emitted: {lines:?}");
    assert!(window.iter().any(|l| l.ends_with("line2")), "line2 not emitted: {lines:?}");
    let l1 = window.iter().position(|l| l.ends_with("line1")).unwrap();
    let l2 = window.iter().position(|l| l.ends_with("line2")).unwrap();
    assert!(l1 < l2, "line1 should precede line2 in transcript");
    // They must live on separate lines (not concatenated as
    // `line1line2` on the last row).
    assert!(
        !window.iter().any(|l| l.ends_with("line1line2")),
        "chunks got fused instead of separated by a newline",
    );
}

#[test]
fn stream_drops_final_chunk_padding_newlines() {
    // Providers pad the final chunk with `\n\n\n\n`. Those should
    // be dropped by `ChatCompleted`, not fan out to 4 blank
    // transcript rows.
    let mut app = AppState::new(config());
    app.apply_worker_event(WorkerEvent::ChatChunk {
        tone: LineTone::Plain,
        chunk: "Hello, friend.\n\n\n\n".to_string(),
    });
    // Simulate stream completion; we don't care about the full
    // exchange payload, just that buffered newlines get dropped.
    app.stream_trailing_newlines.clear();

    let lines = transcript_lines(&app);
    // The final visible content line should be "Hello, friend.",
    // and there should be no run of empty lines trailing it.
    let last_nonempty_pos = lines.iter().rposition(|l| !l.is_empty()).expect("no content");
    let tail_blanks = lines.len() - last_nonempty_pos - 1;
    assert!(tail_blanks <= 1, "too many trailing blank lines: {tail_blanks}");
}

#[test]
fn stream_drops_newlines_on_cancelled_event() {
    // Setting up an active native chat so the Cancelled branch
    // clears state. If buffered newlines leaked into the
    // transcript after a cancel, the next chat would start with
    // stale padding.
    let mut app = AppState::new(config());
    let (_sender, receiver) = mpsc::channel();
    app.active_command = Some(ActiveCommand {
        label: "chat".to_string(),
        cancel_flag: Arc::new(AtomicBool::new(false)),
        receiver,
        cancel_requested: true,
        cancel_behavior: CancelBehavior::Standard,
        kind: ActiveCommandKind::NativeChat,
    });
    app.live_output_chars = Some(5);
    app.stream_trailing_newlines = "\n\n".to_string();

    app.apply_worker_event(WorkerEvent::Cancelled);

    assert!(
        app.stream_trailing_newlines.is_empty(),
        "cancelled event must clear buffered newlines",
    );
}

// ─────────────────────────────────────────────────────────────────
// Sprint S2 (2026-04-26) — TUI tier 0/1/2 symmetry with Telegram.
// Before this sprint, /tier 0|1|2 fell through to "unsupported
// command", leaving the operator without a way to explicitly demote
// tier 3 except /tier revoke (which always restores tier 2).
// ─────────────────────────────────────────────────────────────────
#[test]
fn tier_zero_dispatches_to_security_tier_set_with_target_zero() {
    let tokens = split_command_tokens("tier 0").expect("command tokens");
    let (command, _kind) = extension_host_command_for_tokens(&tokens)
        .expect("host mapping parse")
        .expect("/tier 0 should resolve through the host");

    assert_eq!(command.command, "security.tier.set");
    assert_eq!(command.args.get("tier").and_then(Value::as_u64), Some(0));
}

#[test]
fn tier_one_dispatches_to_security_tier_set_with_target_one() {
    let tokens = split_command_tokens("tier 1").expect("command tokens");
    let (command, _kind) = extension_host_command_for_tokens(&tokens)
        .expect("host mapping parse")
        .expect("/tier 1 should resolve through the host");

    assert_eq!(command.command, "security.tier.set");
    assert_eq!(command.args.get("tier").and_then(Value::as_u64), Some(1));
}

#[test]
fn tier_two_dispatches_to_security_tier_set_with_target_two() {
    let tokens = split_command_tokens("tier 2").expect("command tokens");
    let (command, _kind) = extension_host_command_for_tokens(&tokens)
        .expect("host mapping parse")
        .expect("/tier 2 should resolve through the host");

    assert_eq!(command.command, "security.tier.set");
    assert_eq!(command.args.get("tier").and_then(Value::as_u64), Some(2));
}
