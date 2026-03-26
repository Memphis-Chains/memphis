use crossterm::event::{KeyCode, KeyEvent};

use crate::client::{AppSnapshot, MemphisClient};
use crate::config::TuiConfig;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Screen {
    Overview,
    Chat,
    Memory,
    Vault,
    System,
}

impl Screen {
    pub fn all() -> [Screen; 5] {
        [
            Screen::Overview,
            Screen::Chat,
            Screen::Memory,
            Screen::Vault,
            Screen::System,
        ]
    }

    pub fn title(self) -> &'static str {
        match self {
            Screen::Overview => "Overview",
            Screen::Chat => "Chat",
            Screen::Memory => "Memory",
            Screen::Vault => "Vault",
            Screen::System => "System",
        }
    }

    pub fn from_digit(digit: char) -> Option<Self> {
        match digit {
            '1' => Some(Screen::Overview),
            '2' => Some(Screen::Chat),
            '3' => Some(Screen::Memory),
            '4' => Some(Screen::Vault),
            '5' => Some(Screen::System),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AppAction {
    None,
    Refresh,
    Quit,
}

#[derive(Debug, Clone)]
pub struct AppState {
    pub config: TuiConfig,
    pub active_screen: Screen,
    pub snapshot: AppSnapshot,
}

impl AppState {
    pub fn new(config: TuiConfig) -> Self {
        Self {
            config,
            active_screen: Screen::Overview,
            snapshot: AppSnapshot::default(),
        }
    }

    pub fn refresh(&mut self, client: &MemphisClient) {
        self.snapshot = client.fetch_snapshot();
    }

    pub fn handle_key(&mut self, key: KeyEvent) -> AppAction {
        match key.code {
            KeyCode::Char('q') => AppAction::Quit,
            KeyCode::Char('r') => AppAction::Refresh,
            KeyCode::Char(digit) => {
                if let Some(screen) = Screen::from_digit(digit) {
                    self.active_screen = screen;
                }
                AppAction::None
            }
            _ => AppAction::None,
        }
    }

    pub fn render_lines(&self) -> Vec<String> {
        let mut lines = Vec::new();
        lines.push("Memphis Rust TUI".to_string());
        lines.push(format!("Endpoint: {}", self.config.base_url));
        lines.push(format!(
            "Tabs: {}",
            Screen::all()
                .iter()
                .enumerate()
                .map(|(idx, screen)| {
                    if *screen == self.active_screen {
                        format!("[{}:{}]", idx + 1, screen.title())
                    } else {
                        format!(" {}:{} ", idx + 1, screen.title())
                    }
                })
                .collect::<Vec<String>>()
                .join(" ")
        ));
        lines.push("Keys: 1-5 switch screens · r refresh · q quit".to_string());
        lines.push(String::new());
        lines.extend(self.render_body());
        lines
    }

    fn render_body(&self) -> Vec<String> {
        match self.active_screen {
            Screen::Overview => self.render_overview(),
            Screen::Chat => self.render_chat(),
            Screen::Memory => self.render_memory(),
            Screen::Vault => self.render_vault(),
            Screen::System => self.render_system(),
        }
    }

    fn render_overview(&self) -> Vec<String> {
        let mut lines = vec!["Overview".to_string(), String::new()];

        if let Some(status) = &self.snapshot.status {
            lines.push(format!("Service: {}", status.service));
            lines.push(format!("Version: {}", status.version));
            lines.push(format!(
                "Runtime ok: {}",
                if status.ok { "yes" } else { "no" }
            ));
            lines.push(format!("Health: {}", status.health.status));
            if let Some(summary) = &status.health.summary {
                lines.push(format!("Summary: {summary}"));
            }
            lines.push(format!("Uptime: {}s", status.uptime));
            lines.push(format!("Providers: {}", status.providers.len()));
            lines.push(format!(
                "Adapters: chain={} vault={} embed={}",
                adapter_state(status.adapters.chain.bridge_loaded),
                adapter_state(status.adapters.vault.bridge_loaded),
                adapter_state(status.adapters.embed.bridge_loaded)
            ));
        } else if let Some(error) = &self.snapshot.status_error {
            lines.push(format!("Status unavailable: {error}"));
        } else {
            lines.push("Status not loaded yet.".to_string());
        }

        lines
    }

    fn render_chat(&self) -> Vec<String> {
        let mut lines = vec!["Chat".to_string(), String::new()];
        lines.push("Rust TUI is now the only active TUI path.".to_string());
        lines.push(
            "Sprint 2 lands interactive multi-turn chat over /v1/chat/completions.".to_string(),
        );
        if let Some(status) = &self.snapshot.status {
            let healthy = status
                .providers
                .iter()
                .filter(|provider| provider.ok)
                .count();
            lines.push(format!(
                "Providers currently healthy: {healthy}/{}",
                status.providers.len()
            ));
        }
        lines
    }

    fn render_memory(&self) -> Vec<String> {
        let mut lines = vec!["Memory".to_string(), String::new()];
        lines.push("Canonical recall contract:".to_string());
        lines.push("- memphis_recall = semantic recall".to_string());
        lines.push("- memphis_search = exact phrase search (FTS5)".to_string());
        if let Some(status) = &self.snapshot.status {
            lines.push(format!(
                "Embedding bridge: {}",
                adapter_state(status.adapters.embed.bridge_loaded)
            ));
        }
        lines
    }

    fn render_vault(&self) -> Vec<String> {
        let mut lines = vec!["Vault".to_string(), String::new()];

        if let Some(vault) = &self.snapshot.vault {
            lines.push(format!(
                "Metadata entries: {} (ok={})",
                vault.count,
                if vault.ok { "yes" } else { "no" }
            ));
            for entry in vault.entries.iter().take(8) {
                let integrity = if entry.integrity_ok { "ok" } else { "bad" };
                let fingerprint = entry.fingerprint.chars().take(8).collect::<String>();
                let entry_id = entry.id.as_deref().unwrap_or("-");
                lines.push(format!(
                    "- {}  integrity={}  created={}  fp={}  id={}",
                    entry.key, integrity, entry.created_at, fingerprint, entry_id
                ));
            }
        } else if let Some(error) = &self.snapshot.vault_error {
            lines.push(format!("Vault metadata unavailable: {error}"));
        } else {
            lines.push("Vault metadata not loaded yet.".to_string());
        }

        lines.push(String::new());
        lines.push("Direct secret reads stay bounded to explicit operator paths.".to_string());
        lines
    }

    fn render_system(&self) -> Vec<String> {
        let mut lines = vec!["System".to_string(), String::new()];

        if let Some(status) = &self.snapshot.status {
            lines.push(format!("Timestamp: {}", status.timestamp));
            lines.push("Adapter state:".to_string());
            lines.push(format!(
                "- chain={}{}",
                adapter_state(status.adapters.chain.bridge_loaded),
                status
                    .adapters
                    .chain
                    .error
                    .as_deref()
                    .map(|value| format!(" ({value})"))
                    .unwrap_or_default()
            ));
            lines.push(format!(
                "- vault={}{}",
                adapter_state(status.adapters.vault.bridge_loaded),
                status
                    .adapters
                    .vault
                    .error
                    .as_deref()
                    .map(|value| format!(" ({value})"))
                    .unwrap_or_default()
            ));
            lines.push(format!(
                "- embed={}{}",
                adapter_state(status.adapters.embed.bridge_loaded),
                status
                    .adapters
                    .embed
                    .error
                    .as_deref()
                    .map(|value| format!(" ({value})"))
                    .unwrap_or_default()
            ));
            lines.push("Provider health:".to_string());
            for provider in &status.providers {
                let state = if provider.ok { "ok" } else { "err" };
                let latency = provider
                    .latency_ms
                    .map(|value| format!("{value}ms"))
                    .unwrap_or_else(|| "-".to_string());
                lines.push(format!(
                    "- {}  {}  latency={}{}",
                    provider.name,
                    state,
                    latency,
                    provider
                        .error
                        .as_deref()
                        .map(|value| format!(" ({value})"))
                        .unwrap_or_default()
                ));
            }
        } else if let Some(error) = &self.snapshot.status_error {
            lines.push(format!("System status unavailable: {error}"));
        }

        lines
    }
}

fn adapter_state(loaded: bool) -> &'static str {
    if loaded {
        "loaded"
    } else {
        "missing"
    }
}

#[cfg(test)]
mod tests {
    use super::{AppAction, AppState, Screen};
    use crate::client::{AdapterSet, AdapterStatus, AppSnapshot, HealthSummary, StatusResponse};
    use crate::config::TuiConfig;
    use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
    use std::time::Duration;

    fn config() -> TuiConfig {
        TuiConfig {
            base_url: "http://127.0.0.1:3000".to_string(),
            api_token: Some("token".to_string()),
            refresh_interval: Duration::from_secs(3),
        }
    }

    #[test]
    fn switches_screens_by_digit() {
        let mut app = AppState::new(config());
        let key = KeyEvent::new(KeyCode::Char('4'), KeyModifiers::NONE);
        let action = app.handle_key(key);
        assert_eq!(action, AppAction::None);
        assert_eq!(app.active_screen, Screen::Vault);
    }

    #[test]
    fn renders_status_overview() {
        let mut app = AppState::new(config());
        app.snapshot = AppSnapshot {
            status: Some(StatusResponse {
                ok: true,
                service: "memphis".to_string(),
                version: "0.4.0".to_string(),
                uptime: 42,
                health: HealthSummary {
                    status: "healthy".to_string(),
                    summary: None,
                },
                adapters: AdapterSet {
                    chain: AdapterStatus {
                        bridge_loaded: true,
                        error: None,
                    },
                    vault: AdapterStatus {
                        bridge_loaded: true,
                        error: None,
                    },
                    embed: AdapterStatus {
                        bridge_loaded: false,
                        error: None,
                    },
                },
                providers: Vec::new(),
                timestamp: "2026-03-26T00:00:00Z".to_string(),
            }),
            status_error: None,
            vault: None,
            vault_error: None,
        };

        let lines = app.render_lines();
        assert!(lines.iter().any(|line| line.contains("Health: healthy")));
        assert!(lines
            .iter()
            .any(|line| line.contains("Adapters: chain=loaded vault=loaded embed=missing")));
    }
}
