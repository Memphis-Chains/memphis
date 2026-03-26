use crossterm::event::{KeyCode, KeyEvent};
use memphis_operator::{MemoryQueryResult, VaultSecretView};

use crate::client::{AppSnapshot, MemphisClient};
use crate::config::TuiConfig;

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

    pub fn from_digit(digit: char) -> Option<Self> {
        match digit {
            '1' => Some(Screen::Overview),
            '2' => Some(Screen::Chat),
            '3' => Some(Screen::Memory),
            '4' => Some(Screen::Sessions),
            '5' => Some(Screen::Vault),
            '6' => Some(Screen::Cases),
            '7' => Some(Screen::System),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InputMode {
    Normal,
    Command,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AppAction {
    None,
    Refresh,
    Quit,
    ExecuteCommand,
}

#[derive(Debug, Clone)]
pub struct AppState {
    pub config: TuiConfig,
    pub active_screen: Screen,
    pub snapshot: AppSnapshot,
    pub input_mode: InputMode,
    pub command_buffer: String,
    pub status_line: Option<String>,
    pub memory_result: Option<MemoryQueryResult>,
    pub vault_secret: Option<VaultSecretView>,
}

impl AppState {
    pub fn new(config: TuiConfig) -> Self {
        Self {
            config,
            active_screen: Screen::Overview,
            snapshot: AppSnapshot::default(),
            input_mode: InputMode::Normal,
            command_buffer: String::new(),
            status_line: None,
            memory_result: None,
            vault_secret: None,
        }
    }

    pub fn refresh(&mut self, client: &MemphisClient) {
        self.snapshot = client.fetch_snapshot();
    }

    pub fn handle_key(&mut self, key: KeyEvent) -> AppAction {
        if self.input_mode == InputMode::Command {
            return match key.code {
                KeyCode::Esc => {
                    self.input_mode = InputMode::Normal;
                    self.command_buffer.clear();
                    AppAction::None
                }
                KeyCode::Enter => {
                    self.input_mode = InputMode::Normal;
                    AppAction::ExecuteCommand
                }
                KeyCode::Backspace => {
                    self.command_buffer.pop();
                    AppAction::None
                }
                KeyCode::Char(ch) => {
                    self.command_buffer.push(ch);
                    AppAction::None
                }
                _ => AppAction::None,
            };
        }

        match key.code {
            KeyCode::Char('q') => AppAction::Quit,
            KeyCode::Char('r') => AppAction::Refresh,
            KeyCode::Char('/') => {
                self.input_mode = InputMode::Command;
                self.command_buffer.clear();
                AppAction::None
            }
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
        lines.push(format!("Runtime root: {}", self.config.data_dir.display()));
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
        lines.push("Keys: 1-7 switch screens · / command · r refresh · q quit".to_string());
        if let Some(status_line) = &self.status_line {
            lines.push(format!("Status: {status_line}"));
        }
        lines.push(String::new());
        lines.extend(self.render_body());
        lines.push(String::new());
        match self.input_mode {
            InputMode::Normal => lines.push(
                "Commands: /memory semantic <query> · /memory exact <query> · /vault get <key>"
                    .to_string(),
            ),
            InputMode::Command => lines.push(format!("Command> {}", self.command_buffer)),
        }
        lines
    }

    fn render_body(&self) -> Vec<String> {
        match self.active_screen {
            Screen::Overview => self.render_overview(),
            Screen::Chat => self.render_chat(),
            Screen::Memory => self.render_memory(),
            Screen::Sessions => self.render_sessions(),
            Screen::Vault => self.render_vault(),
            Screen::Cases => self.render_cases(),
            Screen::System => self.render_system(),
        }
    }

    fn render_overview(&self) -> Vec<String> {
        let mut lines = vec!["Overview".to_string(), String::new()];

        if let Some(overview) = &self.snapshot.overview {
            lines.push(format!("Data dir: {}", overview.data_dir));
            lines.push(format!("Default provider: {}", overview.default_provider));
            lines.push(format!("Embed mode: {}", overview.embed_mode));
            lines.push(format!(
                "Chains={} blocks={} vault_entries={} sessions={} cases={}",
                overview.chains,
                overview.blocks,
                overview.vault_entries,
                overview.sessions,
                overview.case_rows
            ));
            lines.push(format!(
                "Memory: semantic_docs={} exact_entries={}",
                overview.semantic_docs, overview.exact_entries
            ));
        } else if let Some(error) = &self.snapshot.overview_error {
            lines.push(format!("Overview unavailable: {error}"));
        } else {
            lines.push("Overview not loaded yet.".to_string());
        }

        lines
    }

    fn render_chat(&self) -> Vec<String> {
        let mut lines = vec!["Chat".to_string(), String::new()];
        lines.push("Native chat parity is the remaining major Rust TUI gap.".to_string());
        lines.push(
            "This screen is intentionally not faked through the TS HTTP runtime.".to_string(),
        );
        lines.push(
            "Current slice moved Overview/Memory/Sessions/Vault/Cases/System onto a native seam."
                .to_string(),
        );
        lines
    }

    fn render_memory(&self) -> Vec<String> {
        let mut lines = vec!["Memory".to_string(), String::new()];
        lines.push("Canonical recall contract:".to_string());
        lines.push("- memphis_recall = semantic recall".to_string());
        lines.push("- memphis_search = exact phrase search (FTS5)".to_string());
        lines.push(String::new());

        if let Some(memory) = &self.snapshot.memory {
            lines.push(format!(
                "Semantic provider={} docs={} persistence={}",
                memory.semantic_provider, memory.semantic_docs, memory.semantic_persistence_state
            ));
            lines.push(format!(
                "Exact entries={} database={}",
                memory.exact_entries, memory.exact_database_path
            ));
            lines.push(format!(
                "Indexed chains: {}",
                if memory.indexed_chains.is_empty() {
                    "-".to_string()
                } else {
                    memory.indexed_chains.join(", ")
                }
            ));
        } else if let Some(error) = &self.snapshot.memory_error {
            lines.push(format!("Memory unavailable: {error}"));
        }

        if let Some(result) = &self.memory_result {
            lines.push(String::new());
            lines.push(format!("Last query: {}", result.query));
            match result.mode {
                memphis_operator::SearchMode::Semantic => {
                    for hit in &result.semantic_hits {
                        lines.push(format!(
                            "- {} score={:.3} tags={} preview={}",
                            hit.id,
                            hit.score,
                            if hit.tags.is_empty() {
                                "-".to_string()
                            } else {
                                hit.tags.join(",")
                            },
                            hit.preview
                        ));
                    }
                }
                memphis_operator::SearchMode::Exact => {
                    for hit in &result.exact_hits {
                        lines.push(format!(
                            "- {}:{} type={} score={:.3} {}",
                            hit.chain, hit.block_index, hit.block_type, hit.score, hit.snippet
                        ));
                    }
                }
            }
        }
        lines
    }

    fn render_sessions(&self) -> Vec<String> {
        let mut lines = vec!["Sessions".to_string(), String::new()];
        if let Some(sessions) = &self.snapshot.sessions {
            lines.push(format!(
                "Database={} recent_sessions={}",
                sessions.database_path, sessions.count
            ));
            for session in &sessions.sessions {
                lines.push(format!(
                    "- {} created={} updated={}",
                    session.id, session.created_at, session.updated_at
                ));
            }
        } else if let Some(error) = &self.snapshot.sessions_error {
            lines.push(format!("Sessions unavailable: {error}"));
        } else {
            lines.push("No session data loaded yet.".to_string());
        }
        lines
    }

    fn render_vault(&self) -> Vec<String> {
        let mut lines = vec!["Vault".to_string(), String::new()];

        if let Some(vault) = &self.snapshot.vault {
            lines.push(format!(
                "Initialized={} state_version={:?} entries={}",
                if vault.initialized { "yes" } else { "no" },
                vault.state_version,
                vault.count,
            ));
            lines.push(format!("State path: {}", vault.state_path));
            lines.push(format!("Entries path: {}", vault.entries_path));
            for entry in vault.entries.iter().take(8) {
                let integrity = if entry.integrity_ok { "ok" } else { "bad" };
                let fingerprint = entry.fingerprint.chars().take(10).collect::<String>();
                let entry_id = entry.id.as_deref().unwrap_or("-");
                lines.push(format!(
                    "- {}  integrity={}  created={}  fp={}  id={}",
                    entry.key, integrity, entry.created_at, fingerprint, entry_id
                ));
            }
        } else if let Some(error) = &self.snapshot.vault_error {
            lines.push(format!("Vault unavailable: {error}"));
        } else {
            lines.push("Vault not loaded yet.".to_string());
        }

        lines.push(String::new());
        lines.push("Direct secret reads stay bounded to explicit operator paths.".to_string());
        if let Some(secret) = &self.vault_secret {
            lines.push(format!("Last read key: {}", secret.key));
            lines.push(format!("Created at: {}", secret.created_at));
            lines.push(format!("Plaintext: {}", secret.plaintext));
        }
        lines
    }

    fn render_cases(&self) -> Vec<String> {
        let mut lines = vec!["Cases / Decisions".to_string(), String::new()];
        if let Some(cases) = &self.snapshot.cases {
            lines.push(format!("Index path: {}", cases.index_path));
            lines.push(format!("Recent case rows: {}", cases.count));
            for case in &cases.cases {
                lines.push(format!(
                    "- #{} {} entity={} actor={} target={}",
                    case.block_index,
                    case.case_type,
                    case.entity.as_deref().unwrap_or("-"),
                    case.actor.as_deref().unwrap_or("-"),
                    case.target.as_deref().unwrap_or("-"),
                ));
            }
        } else if let Some(error) = &self.snapshot.cases_error {
            lines.push(format!("Cases unavailable: {error}"));
        } else {
            lines.push("No case data loaded yet.".to_string());
        }
        lines
    }

    fn render_system(&self) -> Vec<String> {
        let mut lines = vec!["System".to_string(), String::new()];

        if let Some(system) = &self.snapshot.system {
            lines.push(format!("Data dir: {}", system.data_dir));
            lines.push(format!("Database: {}", system.database_path));
            lines.push(format!(
                "Rust chain enabled={} bridge={}",
                if system.rust_chain_enabled {
                    "yes"
                } else {
                    "no"
                },
                system.rust_bridge_path
            ));
            lines.push(format!(
                "Matrix={} Telegram={} Vault initialized={}",
                if system.matrix_enabled { "on" } else { "off" },
                if system.telegram_enabled { "on" } else { "off" },
                if system.vault_initialized {
                    "yes"
                } else {
                    "no"
                }
            ));
            lines.push(format!("Embed persist path: {}", system.embed_persist_path));
            lines.push(format!(
                "Chains: {}",
                if system.chain_names.is_empty() {
                    "-".to_string()
                } else {
                    system.chain_names.join(", ")
                }
            ));
        } else if let Some(error) = &self.snapshot.system_error {
            lines.push(format!("System status unavailable: {error}"));
        }

        lines
    }

    pub fn execute_command(&mut self, client: &MemphisClient) {
        let raw = self.command_buffer.trim().to_string();
        self.command_buffer.clear();
        if raw.is_empty() {
            self.status_line = Some("empty command".to_string());
            return;
        }

        if let Some(query) = raw.strip_prefix("memory semantic ") {
            match client.search_semantic(query.trim(), 5) {
                Ok(result) => {
                    self.active_screen = Screen::Memory;
                    self.memory_result = Some(result.clone());
                    self.status_line = Some(format!("semantic hits={}", result.count));
                }
                Err(error) => self.status_line = Some(error),
            }
            return;
        }

        if let Some(query) = raw.strip_prefix("memory exact ") {
            match client.search_exact(query.trim(), 5) {
                Ok(result) => {
                    self.active_screen = Screen::Memory;
                    self.memory_result = Some(result.clone());
                    self.status_line = Some(format!("exact hits={}", result.count));
                }
                Err(error) => self.status_line = Some(error),
            }
            return;
        }

        if let Some(key) = raw.strip_prefix("vault get ") {
            match client.read_vault_secret(key.trim()) {
                Ok(secret) => {
                    self.active_screen = Screen::Vault;
                    self.vault_secret = Some(secret);
                    self.status_line = Some("vault secret loaded".to_string());
                }
                Err(error) => self.status_line = Some(error),
            }
            return;
        }

        self.status_line = Some(
            "unknown command: use /memory semantic <query>, /memory exact <query>, /vault get <key>"
                .to_string(),
        );
    }
}

#[cfg(test)]
mod tests {
    use super::{AppAction, AppState, InputMode, Screen};
    use crate::client::AppSnapshot;
    use crate::config::TuiConfig;
    use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
    use memphis_operator::{MemorySummary, OverviewSummary, SystemSummary, VaultSummary};
    use std::path::PathBuf;
    use std::time::Duration;

    fn config() -> TuiConfig {
        TuiConfig {
            data_dir: PathBuf::from("/tmp/memphis"),
            refresh_interval: Duration::from_secs(3),
        }
    }

    #[test]
    fn switches_screens_by_digit() {
        let mut app = AppState::new(config());
        let key = KeyEvent::new(KeyCode::Char('5'), KeyModifiers::NONE);
        let action = app.handle_key(key);
        assert_eq!(action, AppAction::None);
        assert_eq!(app.active_screen, Screen::Vault);
    }

    #[test]
    fn enters_command_mode() {
        let mut app = AppState::new(config());
        let action = app.handle_key(KeyEvent::new(KeyCode::Char('/'), KeyModifiers::NONE));
        assert_eq!(action, AppAction::None);
        assert_eq!(app.input_mode, InputMode::Command);
    }

    #[test]
    fn renders_native_snapshot_overview() {
        let mut app = AppState::new(config());
        app.snapshot = AppSnapshot {
            overview: Some(OverviewSummary {
                data_dir: "/tmp/memphis".to_string(),
                default_provider: "ollama".to_string(),
                embed_mode: "local".to_string(),
                chains: 5,
                blocks: 42,
                semantic_docs: 12,
                exact_entries: 10,
                sessions: 2,
                case_rows: 3,
                vault_entries: 1,
            }),
            overview_error: None,
            memory: Some(MemorySummary {
                semantic_provider: "local-deterministic".to_string(),
                semantic_docs: 12,
                semantic_persistence_state: "loaded".to_string(),
                exact_entries: 10,
                exact_database_path: "/tmp/memphis.db".to_string(),
                indexed_chains: vec!["journal".to_string(), "decisions".to_string()],
            }),
            memory_error: None,
            sessions: None,
            sessions_error: None,
            vault: Some(VaultSummary {
                initialized: true,
                state_version: Some(2),
                state_path: "/tmp/vault-state.json".to_string(),
                entries_path: "/tmp/vault-entries.json".to_string(),
                count: 1,
                entries: Vec::new(),
            }),
            vault_error: None,
            cases: None,
            cases_error: None,
            system: Some(SystemSummary {
                data_dir: "/tmp/memphis".to_string(),
                database_path: "/tmp/memphis.db".to_string(),
                rust_chain_enabled: true,
                rust_bridge_path: "./crates/memphis-napi".to_string(),
                matrix_enabled: false,
                telegram_enabled: false,
                vault_initialized: true,
                embed_persist_path: "/tmp/embed/index-v1.json".to_string(),
                chain_names: vec!["journal".to_string()],
            }),
            system_error: None,
        };

        let lines = app.render_lines();
        assert!(lines
            .iter()
            .any(|line| line.contains("Default provider: ollama")));
        assert!(lines
            .iter()
            .any(|line| line.contains("Memory: semantic_docs=12 exact_entries=10")));
    }
}
