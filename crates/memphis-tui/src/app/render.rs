//! Per-screen and per-status renderers — the "pull state out of `AppState`,
//! return `Vec<StyledLine>`" layer of the TUI. Also covers the helpers that
//! append transcript entries / provider rows / model rows directly to the
//! output buffer.
//!
//! Extracted from `app/mod.rs` (S4 PR 5). Pure rendering: each method takes
//! `&self` (or `&mut self` only to push lines), reads config/snapshot, and
//! emits styled lines. No I/O. No host RPC. No state mutation outside of
//! line-buffer pushes.
//!
//! Visibility: 11 entry points are `pub(super)` (called from `execute_command`
//! and `surface_lines` in mod.rs). Two helpers (`telegram_send_record_lines`,
//! `provider_rows_as_lines`) stay private to this module — only used by the
//! sibling renderers in this file.

use memphis_operator::ChatTranscriptEntry;

use super::{
    blank, derive_context_pressure_summary, dim, error_line, estimate_tokens_from_chars,
    format_degradation_summary, format_full_context_headroom, format_full_token_usage,
    format_token_count, info, plain, section, styled, success, telegram_state_line,
    warning, yes_no, AppState, LineTone, StyledLine, TelegramSendOutcome, TelegramSendRecord,
};

impl AppState {
    pub(super) fn append_transcript_entry(&mut self, message: &ChatTranscriptEntry) {
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

    pub(super) fn append_provider_status_rows(&mut self, title_text: &str) {
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

    pub(super) fn append_model_rows(&mut self) {
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

    pub(super) fn render_overview(&self) -> Vec<StyledLine> {
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
            let mode_label = match overview.cognitive_mode_name.as_deref() {
                Some(name) if !name.is_empty() => {
                    format!("{} ({})", overview.cognitive_mode, name)
                }
                _ => overview.cognitive_mode.clone(),
            };
            lines.push(plain(format!(
                "Cognitive mode: {}  PULSE: {}",
                mode_label, overview.pulse_health
            )));
            let mut tune_parts: Vec<String> = Vec::new();
            if let Some(temp) = overview.cognitive_mode_temperature {
                tune_parts.push(format!("temp {:.1}", temp));
            }
            if let Some(style) = overview.cognitive_mode_style.as_ref() {
                if !style.is_empty() {
                    tune_parts.push(format!("style {}", style));
                }
            }
            if let Some(pattern) = overview.cognitive_mode_pattern.as_ref() {
                if !pattern.is_empty() {
                    tune_parts.push(format!("pattern {}", pattern));
                }
            }
            if !tune_parts.is_empty() {
                lines.push(dim(format!("  {}", tune_parts.join("  ·  "))));
            }
            if let Some(last_modified) = overview.cognitive_mode_last_modified.as_ref() {
                if !last_modified.is_empty() {
                    lines.push(dim(format!("  last changed: {}", last_modified)));
                }
            }
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

    pub(super) fn render_chat_summary(&self) -> Vec<StyledLine> {
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

    pub(super) fn render_memory_summary(&self) -> Vec<StyledLine> {
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

    pub(super) fn render_sessions_summary(&self) -> Vec<StyledLine> {
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

    pub(super) fn render_vault_summary(&self) -> Vec<StyledLine> {
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

    pub(super) fn render_cases_summary(&self) -> Vec<StyledLine> {
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

    pub(super) fn render_system_summary(&self) -> Vec<StyledLine> {
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

    pub(super) fn telegram_status_lines(&self) -> Vec<StyledLine> {
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
        lines.push(dim(
            "Use /guide to inspect the shared operator design and Telegram companion policy from this console.",
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
}
