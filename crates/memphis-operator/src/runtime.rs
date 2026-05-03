use std::{fs, path::Path};

use aes_gcm::{
    aead::{Aead, KeyInit},
    Aes256Gcm, Nonce,
};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use chrono::{DateTime, Utc};
use memphis_case_index::CaseIndex;
use memphis_core::case_entry::CaseQuery;
use memphis_embed::{EmbedPersistenceLoadState, EmbedPipeline};
use memphis_vault::{types::VaultEntry, Vault};
use rusqlite::{params, Connection};
use scrypt::{scrypt, Params as ScryptParams};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use thiserror::Error;

use crate::config::{format_path, OperatorConfig};

#[derive(Debug, Error)]
pub enum OperatorError {
    #[error("{0}")]
    Message(String),
    #[error("cancelled")]
    Cancelled,
    #[error("io: {0}")]
    Io(String),
    #[error("sqlite: {0}")]
    Sqlite(String),
    #[error("json: {0}")]
    Json(String),
    #[error("vault: {0}")]
    Vault(String),
    #[error("embed: {0}")]
    Embed(String),
    /// The provider rejected the request because the prompt + history exceeded
    /// the model's context window. Distinct from a generic provider error so
    /// the TUI can render an actionable hint ("use /clear to drop history")
    /// instead of the generic "provider X failed" message.
    ///
    /// `tokens_used` and `context_window` are best-effort — providers don't
    /// always echo them in their error response. Both Optional; either
    /// missing means "not parsed from the upstream response".
    #[error(
        "provider {provider} context window exceeded ({tokens_used:?} / {context_window:?} tokens) — use /clear in the TUI to drop history"
    )]
    ContextOverflow {
        provider: String,
        tokens_used: Option<u32>,
        context_window: Option<u32>,
    },
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct OperatorSnapshot {
    pub overview: Option<OverviewSummary>,
    pub overview_error: Option<String>,
    pub memory: Option<MemorySummary>,
    pub memory_error: Option<String>,
    pub sessions: Option<SessionSummary>,
    pub sessions_error: Option<String>,
    pub vault: Option<VaultSummary>,
    pub vault_error: Option<String>,
    pub cases: Option<CaseSummary>,
    pub cases_error: Option<String>,
    pub system: Option<SystemSummary>,
    pub system_error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct OverviewSummary {
    pub data_dir: String,
    pub default_provider: String,
    pub embed_mode: String,
    pub cognitive_mode: String,
    pub cognitive_mode_name: Option<String>,
    pub cognitive_mode_temperature: Option<f64>,
    pub cognitive_mode_style: Option<String>,
    pub cognitive_mode_pattern: Option<String>,
    pub cognitive_mode_last_modified: Option<String>,
    pub pulse_health: String,
    pub chains: usize,
    pub blocks: usize,
    pub semantic_docs: usize,
    pub exact_entries: usize,
    pub sessions: usize,
    pub case_rows: usize,
    pub vault_entries: usize,
}

#[derive(Debug, Clone, Serialize)]
pub struct MemorySummary {
    pub semantic_provider: String,
    pub semantic_docs: usize,
    pub semantic_persistence_state: String,
    pub exact_entries: usize,
    pub exact_database_path: String,
    pub indexed_chains: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct SessionSummary {
    pub database_path: String,
    pub count: usize,
    pub sessions: Vec<SessionItem>,
}

#[derive(Debug, Clone, Serialize)]
pub struct SessionItem {
    pub id: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct VaultSummary {
    pub initialized: bool,
    pub state_version: Option<u8>,
    pub state_path: String,
    pub entries_path: String,
    pub count: usize,
    pub entries: Vec<VaultEntryMetadata>,
}

#[derive(Debug, Clone, Serialize)]
pub struct VaultEntryMetadata {
    pub key: String,
    pub created_at: String,
    pub fingerprint: String,
    pub integrity_ok: bool,
    pub id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct VaultSecretView {
    pub key: String,
    pub created_at: String,
    pub plaintext: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct CaseSummary {
    pub index_path: String,
    pub count: usize,
    pub cases: Vec<CaseItem>,
}

#[derive(Debug, Clone, Serialize)]
pub struct CaseItem {
    pub block_index: u64,
    pub case_type: String,
    pub entity: Option<String>,
    pub actor: Option<String>,
    pub target: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct SystemSummary {
    pub data_dir: String,
    pub database_path: String,
    pub rust_chain_enabled: bool,
    pub rust_bridge_path: String,
    pub matrix_enabled: bool,
    pub telegram_enabled: bool,
    pub matrix: MatrixReadinessSummary,
    pub telegram: TelegramReadinessSummary,
    pub vault_initialized: bool,
    pub embed_persist_path: String,
    pub chain_names: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct MatrixReadinessSummary {
    pub federation: String,
    pub trust_mode: String,
    pub enabled: bool,
    pub homeserver_configured: bool,
    pub access_token_configured: bool,
    pub access_token_source: String,
    pub admin_user_configured: bool,
    pub peer_storage_ready: bool,
    pub reasons: Vec<String>,
    pub homeserver: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct TelegramReadinessSummary {
    pub state: String,
    pub gateway_enabled: bool,
    pub configured: bool,
    pub token_source: String,
    pub chat_id_configured: bool,
    pub allowlist_enabled: bool,
    pub allowlist_count: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub enum SearchMode {
    Semantic,
    Exact,
}

#[derive(Debug, Clone, Serialize)]
pub struct SemanticSearchHit {
    pub id: String,
    pub score: f32,
    pub preview: String,
    pub tags: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ExactSearchHit {
    pub source_key: String,
    pub chain: String,
    pub block_index: u64,
    pub block_type: String,
    pub score: f32,
    pub snippet: String,
    pub summary: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct MemoryQueryResult {
    pub mode: SearchMode,
    pub query: String,
    pub count: usize,
    pub semantic_hits: Vec<SemanticSearchHit>,
    pub exact_hits: Vec<ExactSearchHit>,
}

#[derive(Debug, Clone)]
pub struct OperatorRuntime {
    pub(crate) config: OperatorConfig,
}

impl Default for OperatorRuntime {
    fn default() -> Self {
        Self::from_env()
    }
}

impl OperatorRuntime {
    pub fn from_env() -> Self {
        Self {
            config: OperatorConfig::from_env(),
        }
    }

    pub fn config(&self) -> &OperatorConfig {
        &self.config
    }

    pub fn snapshot(&self) -> OperatorSnapshot {
        let memory = self.load_memory_summary();
        let sessions = self.load_sessions();
        let vault = self.load_vault_summary();
        let cases = self.load_cases();
        let system = self.load_system_summary();

        let mut snapshot = OperatorSnapshot::default();

        match &memory {
            Ok(value) => snapshot.memory = Some(value.clone()),
            Err(error) => snapshot.memory_error = Some(error.to_string()),
        }
        match &sessions {
            Ok(value) => snapshot.sessions = Some(value.clone()),
            Err(error) => snapshot.sessions_error = Some(error.to_string()),
        }
        match &vault {
            Ok(value) => snapshot.vault = Some(value.clone()),
            Err(error) => snapshot.vault_error = Some(error.to_string()),
        }
        match &cases {
            Ok(value) => snapshot.cases = Some(value.clone()),
            Err(error) => snapshot.cases_error = Some(error.to_string()),
        }
        match &system {
            Ok(value) => snapshot.system = Some(value.clone()),
            Err(error) => snapshot.system_error = Some(error.to_string()),
        }

        let (cognitive_mode_code, cognitive_mode_last_modified) =
            read_cognitive_mode_summary(&self.config.data_dir);
        let (mode_name, mode_temp, mode_style, mode_pattern) =
            cognitive_mode_config(&cognitive_mode_code);
        let overview = OverviewSummary {
            data_dir: format_path(&self.config.data_dir),
            default_provider: self.config.default_provider.clone(),
            embed_mode: match &self.config.embed_config.mode {
                memphis_embed::EmbedMode::LocalDeterministic => "local".to_string(),
                memphis_embed::EmbedMode::Provider(name) => name.clone(),
                // Summarize a cascade as `cascade[a,b,c]` so operators
                // can read the fallback chain off the overview card.
                memphis_embed::EmbedMode::Cascade(modes) => {
                    let names: Vec<String> = modes
                        .iter()
                        .map(|m| match m {
                            memphis_embed::EmbedMode::LocalDeterministic => "local".to_string(),
                            memphis_embed::EmbedMode::Provider(n) => n.clone(),
                            memphis_embed::EmbedMode::Cascade(_) => "cascade".to_string(),
                        })
                        .collect();
                    format!("cascade[{}]", names.join(","))
                }
            },
            cognitive_mode: cognitive_mode_code.clone(),
            cognitive_mode_name: Some(mode_name.to_string()),
            cognitive_mode_temperature: Some(mode_temp),
            cognitive_mode_style: Some(mode_style.to_string()),
            cognitive_mode_pattern: Some(mode_pattern.to_string()),
            cognitive_mode_last_modified,
            pulse_health: read_pulse_health(&self.config.data_dir),
            chains: list_chain_names(&self.config.data_dir).len(),
            blocks: count_chain_blocks(&self.config.data_dir),
            semantic_docs: memory
                .as_ref()
                .map(|value| value.semantic_docs)
                .unwrap_or(0),
            exact_entries: memory
                .as_ref()
                .map(|value| value.exact_entries)
                .unwrap_or(0),
            sessions: sessions.as_ref().map(|value| value.count).unwrap_or(0),
            case_rows: cases.as_ref().map(|value| value.count).unwrap_or(0),
            vault_entries: vault.as_ref().map(|value| value.count).unwrap_or(0),
        };

        snapshot.overview = Some(overview);
        snapshot
    }

    pub fn search_exact(
        &self,
        query: &str,
        limit: usize,
        chain: Option<&str>,
    ) -> Result<MemoryQueryResult, OperatorError> {
        let conn = open_sqlite(&self.config.database_path)?;
        let sql = if chain.is_some() {
            r#"
            SELECT
              e.source_key,
              e.chain_name,
              e.block_index,
              e.block_type,
              snippet(memory_search_fts, 0, '[', ']', ' ... ', 12) AS snippet,
              e.summary,
              bm25(memory_search_fts, 5.0, 1.2, 2.0) AS rank
            FROM memory_search_fts
            JOIN memory_search_entries e ON memory_search_fts.rowid = e.id
            WHERE memory_search_fts MATCH ? AND e.chain_name = ?
            ORDER BY rank ASC
            LIMIT ?
            "#
        } else {
            r#"
            SELECT
              e.source_key,
              e.chain_name,
              e.block_index,
              e.block_type,
              snippet(memory_search_fts, 0, '[', ']', ' ... ', 12) AS snippet,
              e.summary,
              bm25(memory_search_fts, 5.0, 1.2, 2.0) AS rank
            FROM memory_search_fts
            JOIN memory_search_entries e ON memory_search_fts.rowid = e.id
            WHERE memory_search_fts MATCH ?
            ORDER BY rank ASC
            LIMIT ?
            "#
        };
        let phrase = format!("\"{}\"", query.trim().replace('"', "\"\""));
        let mut stmt = match conn.prepare(sql) {
            Ok(stmt) => stmt,
            Err(error) if is_missing_table_error(&error) => {
                return Ok(MemoryQueryResult {
                    mode: SearchMode::Exact,
                    query: query.to_string(),
                    count: 0,
                    semantic_hits: Vec::new(),
                    exact_hits: Vec::new(),
                });
            }
            Err(error) => return Err(OperatorError::Sqlite(error.to_string())),
        };
        let rows = if let Some(chain_name) = chain {
            stmt.query_map(params![phrase, chain_name, limit.max(1) as i64], |row| {
                let rank: f64 = row.get(6)?;
                Ok(ExactSearchHit {
                    source_key: row.get(0)?,
                    chain: row.get(1)?,
                    block_index: row.get::<_, i64>(2)? as u64,
                    block_type: row.get(3)?,
                    snippet: row.get::<_, Option<String>>(4)?.unwrap_or_default(),
                    summary: row.get(5)?,
                    score: normalize_score(rank),
                })
            })
            .map_err(|error| OperatorError::Sqlite(error.to_string()))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| OperatorError::Sqlite(error.to_string()))?
        } else {
            stmt.query_map(params![phrase, limit.max(1) as i64], |row| {
                let rank: f64 = row.get(6)?;
                Ok(ExactSearchHit {
                    source_key: row.get(0)?,
                    chain: row.get(1)?,
                    block_index: row.get::<_, i64>(2)? as u64,
                    block_type: row.get(3)?,
                    snippet: row.get::<_, Option<String>>(4)?.unwrap_or_default(),
                    summary: row.get(5)?,
                    score: normalize_score(rank),
                })
            })
            .map_err(|error| OperatorError::Sqlite(error.to_string()))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| OperatorError::Sqlite(error.to_string()))?
        };

        Ok(MemoryQueryResult {
            mode: SearchMode::Exact,
            query: query.to_string(),
            count: rows.len(),
            semantic_hits: Vec::new(),
            exact_hits: rows,
        })
    }

    pub fn search_semantic(
        &self,
        query: &str,
        limit: usize,
    ) -> Result<MemoryQueryResult, OperatorError> {
        let pipeline = EmbedPipeline::with_persistence(
            self.config.embed_config.clone(),
            self.config.embed_persistence(),
        )
        .map_err(|error| OperatorError::Embed(error.to_string()))?;
        let hits = pipeline
            .search_tuned(query, limit.max(1))
            .map_err(|error| OperatorError::Embed(error.to_string()))?
            .into_iter()
            .map(|hit| SemanticSearchHit {
                id: hit.id,
                score: hit.score,
                preview: hit.text_preview,
                tags: hit.tags,
            })
            .collect::<Vec<_>>();

        Ok(MemoryQueryResult {
            mode: SearchMode::Semantic,
            query: query.to_string(),
            count: hits.len(),
            semantic_hits: hits,
            exact_hits: Vec::new(),
        })
    }

    pub fn read_vault_secret(&self, key: &str) -> Result<VaultSecretView, OperatorError> {
        let vault = load_vault(&self.config, false)?
            .expect("strict vault load should return a vault instance");

        let entries = load_vault_entries(&self.config.vault_entries_path)?;
        let entry = entries
            .into_iter()
            .filter(|entry| entry.key == key)
            .last()
            .ok_or_else(|| OperatorError::Vault(format!("vault key not found: {key}")))?;

        let key = entry.key.clone();
        let created_at = entry.created_at.clone();
        let plaintext = read_vault_entry_plaintext(&vault, entry)?;

        Ok(VaultSecretView {
            key,
            created_at,
            plaintext,
        })
    }

    fn load_memory_summary(&self) -> Result<MemorySummary, OperatorError> {
        let pipeline = EmbedPipeline::with_persistence(
            self.config.embed_config.clone(),
            self.config.embed_persistence(),
        )
        .map_err(|error| OperatorError::Embed(error.to_string()))?;
        let conn = open_sqlite(&self.config.database_path)?;
        let exact_entries = conn
            .query_row("SELECT COUNT(*) FROM memory_search_entries", [], |row| {
                row.get::<_, i64>(0)
            })
            .map(|value| value as usize)
            .or_else(|error| {
                if is_missing_table_error(&error) {
                    Ok(0)
                } else {
                    Err(OperatorError::Sqlite(error.to_string()))
                }
            })?;

        Ok(MemorySummary {
            semantic_provider: pipeline.provider_name().to_string(),
            semantic_docs: pipeline.len(),
            semantic_persistence_state: persistence_label(pipeline.persistence_load_state())
                .to_string(),
            exact_entries,
            exact_database_path: format_path(&self.config.database_path),
            indexed_chains: list_chain_names(&self.config.data_dir),
        })
    }

    fn load_sessions(&self) -> Result<SessionSummary, OperatorError> {
        let conn = open_sqlite(&self.config.database_path)?;
        let mut stmt = match conn.prepare(
            "SELECT id, created_at, updated_at FROM sessions ORDER BY updated_at DESC LIMIT 20",
        ) {
            Ok(stmt) => stmt,
            Err(error) if is_missing_table_error(&error) => {
                return Ok(SessionSummary {
                    database_path: format_path(&self.config.database_path),
                    count: 0,
                    sessions: Vec::new(),
                });
            }
            Err(error) => return Err(OperatorError::Sqlite(error.to_string())),
        };
        let sessions = stmt
            .query_map([], |row| {
                Ok(SessionItem {
                    id: row.get(0)?,
                    created_at: row.get(1)?,
                    updated_at: row.get(2)?,
                })
            })
            .map_err(|error| OperatorError::Sqlite(error.to_string()))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| OperatorError::Sqlite(error.to_string()))?;

        Ok(SessionSummary {
            database_path: format_path(&self.config.database_path),
            count: sessions.len(),
            sessions,
        })
    }

    fn load_vault_summary(&self) -> Result<VaultSummary, OperatorError> {
        let state_version = read_vault_state_version(&self.config.vault_state_path);
        let entries = load_vault_entries(&self.config.vault_entries_path)?;
        Ok(VaultSummary {
            initialized: state_version.is_some(),
            state_version,
            state_path: format_path(&self.config.vault_state_path),
            entries_path: format_path(&self.config.vault_entries_path),
            count: entries.len(),
            entries: entries
                .into_iter()
                .rev()
                .take(12)
                .collect::<Vec<_>>()
                .into_iter()
                .rev()
                .map(|entry| VaultEntryMetadata {
                    key: entry.key,
                    created_at: entry.created_at,
                    fingerprint: entry.fingerprint,
                    integrity_ok: entry.integrity_ok,
                    id: entry.id,
                })
                .collect(),
        })
    }

    fn load_cases(&self) -> Result<CaseSummary, OperatorError> {
        if !self.config.case_index_path.exists() {
            return Ok(CaseSummary {
                index_path: format_path(&self.config.case_index_path),
                count: 0,
                cases: Vec::new(),
            });
        }

        let index = CaseIndex::open(&self.config.case_index_path)
            .map_err(|error| OperatorError::Message(error.to_string()))?;
        let rows = index
            .query(&CaseQuery {
                limit: Some(20),
                ..CaseQuery::default()
            })
            .map_err(|error| OperatorError::Message(error.to_string()))?;
        let cases = rows
            .into_iter()
            .map(|row| CaseItem {
                block_index: row.block_index,
                case_type: row.case_type,
                entity: row.entry.entity().map(str::to_string),
                actor: row.entry.actor().map(str::to_string),
                target: row.entry.target().map(str::to_string),
            })
            .collect::<Vec<_>>();

        Ok(CaseSummary {
            index_path: format_path(&self.config.case_index_path),
            count: cases.len(),
            cases,
        })
    }

    fn load_system_summary(&self) -> Result<SystemSummary, OperatorError> {
        let matrix = self.load_matrix_readiness_summary();
        let telegram = self.load_telegram_readiness_summary();

        Ok(SystemSummary {
            data_dir: format_path(&self.config.data_dir),
            database_path: format_path(&self.config.database_path),
            rust_chain_enabled: self.config.rust_chain_enabled,
            rust_bridge_path: self.config.rust_bridge_path.clone(),
            matrix_enabled: matrix.enabled,
            telegram_enabled: telegram.configured,
            matrix,
            telegram,
            vault_initialized: self.config.vault_state_path.exists(),
            embed_persist_path: format_path(&self.config.embed_persist_path),
            chain_names: list_chain_names(&self.config.data_dir),
        })
    }

    fn load_matrix_readiness_summary(&self) -> MatrixReadinessSummary {
        let trust_mode = matrix_trust_mode(self.config.env("MEMPHIS_MATRIX_TRUST_MODE"));
        let enabled = env_enabled(self.config.env("MEMPHIS_MATRIX_ENABLED"));
        let homeserver = self
            .config
            .env("MEMPHIS_MATRIX_HOMESERVER")
            .map(str::to_string);
        let homeserver_configured = homeserver
            .as_deref()
            .map(is_configured_url)
            .unwrap_or(false);
        let access_token = self.config.env("MEMPHIS_MATRIX_ACCESS_TOKEN");
        let access_token_configured = access_token.is_some();
        let access_token_source = matrix_access_token_source(access_token).to_string();
        let admin_user_configured = self.config.env("MEMPHIS_MATRIX_ADMIN_USER").is_some();
        let peer_storage_ready = peer_storage_ready(&self.config.database_path);

        let mut reasons = Vec::new();
        if !enabled {
            reasons.push("Matrix federation disabled".to_string());
        }
        if !homeserver_configured {
            reasons.push("MEMPHIS_MATRIX_HOMESERVER not configured".to_string());
        }
        if !access_token_configured {
            reasons.push("MEMPHIS_MATRIX_ACCESS_TOKEN not configured".to_string());
        }
        if !peer_storage_ready {
            reasons.push("Peer storage not initialized".to_string());
        }
        if trust_mode == "public-deferred" {
            reasons.push("Public Matrix federation hardening is deferred".to_string());
        }

        MatrixReadinessSummary {
            federation: if enabled
                && homeserver_configured
                && access_token_configured
                && peer_storage_ready
                && trust_mode == "trusted-pilot"
            {
                "ready".to_string()
            } else {
                "unavailable".to_string()
            },
            trust_mode: trust_mode.to_string(),
            enabled,
            homeserver_configured,
            access_token_configured,
            access_token_source,
            admin_user_configured,
            peer_storage_ready,
            reasons,
            homeserver: homeserver.filter(|value| is_configured_url(value.as_str())),
        }
    }

    fn load_telegram_readiness_summary(&self) -> TelegramReadinessSummary {
        let gateway_enabled = env_enabled(self.config.env("MEMPHIS_CHANNEL_GATEWAY_ENABLED"));
        let token_source = telegram_token_source(&self.config).to_string();
        let configured = token_source != "missing";
        let allowlist_count = self
            .config
            .env("MEMPHIS_TELEGRAM_ALLOWED_USER_IDS")
            .map(parse_csv_count)
            .unwrap_or(0);
        let chat_id_configured = self.config.env("MEMPHIS_TELEGRAM_CHAT_ID").is_some();

        TelegramReadinessSummary {
            state: if configured && !gateway_enabled {
                "configured".to_string()
            } else if !gateway_enabled {
                "disabled".to_string()
            } else if configured {
                "ready".to_string()
            } else {
                "missing-token".to_string()
            },
            gateway_enabled,
            configured,
            token_source,
            chat_id_configured,
            allowlist_enabled: allowlist_count > 0,
            allowlist_count,
        }
    }
}

fn list_chain_names(data_dir: &Path) -> Vec<String> {
    let chains_dir = data_dir.join("chains");
    let mut names = fs::read_dir(chains_dir)
        .ok()
        .into_iter()
        .flat_map(|entries| entries.filter_map(Result::ok))
        .filter(|entry| {
            entry
                .file_type()
                .map(|file_type| file_type.is_dir())
                .unwrap_or(false)
        })
        .map(|entry| entry.file_name().to_string_lossy().to_string())
        .collect::<Vec<_>>();
    names.sort();
    names
}

fn count_chain_blocks(data_dir: &Path) -> usize {
    list_chain_names(data_dir)
        .into_iter()
        .map(|chain| {
            fs::read_dir(data_dir.join("chains").join(chain))
                .ok()
                .into_iter()
                .flat_map(|entries| entries.filter_map(Result::ok))
                .filter(|entry| {
                    entry
                        .path()
                        .extension()
                        .and_then(|value| value.to_str())
                        .map(|value| value == "json")
                        .unwrap_or(false)
                })
                .count()
        })
        .sum()
}

fn read_cognitive_mode_summary(data_dir: &Path) -> (String, Option<String>) {
    // soul-manifest.json lives at <data_dir>/config/soul-manifest.json
    // (matches src/soul/manifest.ts which writes via getConfigPath()).
    // The previous parent-walk computed ~/.memphis/soul-manifest.json
    // (missing the "config" segment) and silently returned the default
    // mode for every read.
    let manifest_path = data_dir.join("config").join("soul-manifest.json");
    if let Ok(content) = fs::read_to_string(&manifest_path) {
        if let Ok(value) = serde_json::from_str::<serde_json::Value>(&content) {
            let mode = value
                .get("cognitiveMode")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
            let updated = value
                .get("cognitiveModeUpdatedAt")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
            if let Some(mode) = mode {
                return (mode, updated);
            }
        }
    }
    (
        std::env::var("MEMPHIS_COGNITIVE_MODE").unwrap_or_else(|_| "A".to_string()),
        None,
    )
}

fn cognitive_mode_config(mode: &str) -> (&'static str, f64, &'static str, &'static str) {
    match mode {
        "A" => ("ConsciousCapture", 0.3, "fast", "concise"),
        "B" => ("InferredDecisions", 0.5, "deliberate", "detailed"),
        "C" => ("PredictivePatterns", 0.7, "reflective", "analogical"),
        "D" => ("CollectiveCoord", 0.4, "collaborative", "socratic"),
        "E" => ("MetaCognitiveRef", 0.2, "meta", "concise"),
        _ => ("ConsciousCapture", 0.3, "fast", "concise"),
    }
}

fn read_pulse_health(data_dir: &Path) -> String {
    // PULSE.md lives in `<data_dir>/config/PULSE.md`. The previous
    // implementation reconstructed the path as `parent(data_dir)/.memphis/`
    // which broke when `data_dir` was already the `.memphis` directory
    // (the canonical layout): resulting path was `.memphis/PULSE.md`,
    // one directory above the real file. Everyone saw `PULSE: unknown`
    // in the status bar even though PULSE.md was being written to
    // continuously. Observed on operator WSL 2026-04-20.
    let pulse_path = data_dir.join("config").join("PULSE.md");
    let Ok(content) = fs::read_to_string(&pulse_path) else {
        return "unknown".to_string();
    };
    // Status line has a stable `... | Status: <value> | ...` shape but its
    // position can drift (boot event insertions, future format tweaks).
    // Scan up to 50 lines (PULSE.md is bounded via chain rotation) and
    // split on the `|` separator to cleanly stop at the next field.
    for line in content.lines().take(50) {
        if let Some((_, after)) = line.split_once("Status:") {
            return after
                .split('|')
                .next()
                .unwrap_or("unknown")
                .trim()
                .to_string();
        }
    }
    "unknown".to_string()
}

fn env_enabled(value: Option<&str>) -> bool {
    value
        .map(|inner| {
            matches!(
                inner.trim().to_ascii_lowercase().as_str(),
                "1" | "true" | "yes" | "on"
            )
        })
        .unwrap_or(false)
}

fn matrix_trust_mode(value: Option<&str>) -> &'static str {
    match value
        .map(|inner| inner.trim().to_ascii_lowercase())
        .as_deref()
    {
        Some("public") | Some("public-deferred") | Some("untrusted") => "public-deferred",
        _ => "trusted-pilot",
    }
}

fn matrix_access_token_source(value: Option<&str>) -> &'static str {
    match value {
        Some(inner) if inner.trim().starts_with("VAULT:") => "vault-ref",
        Some(_) => "direct",
        None => "missing",
    }
}

fn telegram_token_source(config: &OperatorConfig) -> &'static str {
    if config.env("MEMPHIS_TELEGRAM_TOKEN_OVERRIDE").is_some()
        || config.env("MEMPHIS_TELEGRAM_BOT_TOKEN").is_some()
    {
        "memphis"
    } else if config.env("TELEGRAM_BOT_TOKEN").is_some() {
        "legacy"
    } else {
        "missing"
    }
}

fn is_configured_url(value: &str) -> bool {
    let trimmed = value.trim();
    !trimmed.is_empty() && (trimmed.starts_with("http://") || trimmed.starts_with("https://"))
}

fn parse_csv_count(value: &str) -> usize {
    value
        .split(',')
        .map(str::trim)
        .filter(|inner| !inner.is_empty())
        .count()
}

fn peer_storage_ready(database_path: &Path) -> bool {
    if !database_path.exists() {
        return false;
    }

    let Ok(conn) = Connection::open(database_path) else {
        return false;
    };

    conn.query_row(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'agent_peers' LIMIT 1",
        [],
        |row| row.get::<_, i64>(0),
    )
    .map(|value| value == 1)
    .unwrap_or(false)
}

fn open_sqlite(path: &Path) -> Result<Connection, OperatorError> {
    Connection::open(path).map_err(|error| OperatorError::Sqlite(error.to_string()))
}

fn is_missing_table_error(error: &rusqlite::Error) -> bool {
    error.to_string().contains("no such table:")
}

fn normalize_score(rank: f64) -> f32 {
    if !rank.is_finite() {
        return 0.0;
    }
    if rank <= 0.0 {
        (1.0 / (1.0 + rank.abs())) as f32
    } else {
        (1.0 / (1.0 + rank)) as f32
    }
}

fn persistence_label(state: EmbedPersistenceLoadState) -> &'static str {
    match state {
        EmbedPersistenceLoadState::Disabled => "disabled",
        EmbedPersistenceLoadState::Missing => "missing",
        EmbedPersistenceLoadState::Empty => "empty",
        EmbedPersistenceLoadState::Loaded => "loaded",
        EmbedPersistenceLoadState::Corrupt => "corrupt",
    }
}

#[derive(Debug)]
enum VaultState {
    V1 {
        salt: [u8; 32],
        master_key: [u8; 32],
    },
    V2 {
        salt: [u8; 32],
        encrypted_master_key: Vec<u8>,
        iv: Vec<u8>,
        tag: Vec<u8>,
    },
}

#[derive(Debug, Deserialize)]
struct PersistedVaultStateV1 {
    salt: String,
    #[serde(rename = "masterKey")]
    master_key: String,
}

#[derive(Debug, Deserialize)]
struct PersistedVaultStateV2 {
    salt: String,
    #[serde(rename = "encryptedMasterKey")]
    encrypted_master_key: String,
    iv: String,
    tag: String,
}

#[derive(Debug, Deserialize)]
struct StoredVaultEntry {
    key: String,
    encrypted: String,
    iv: String,
    #[serde(default)]
    tag: Option<String>,
    #[serde(default)]
    id: Option<String>,
    #[serde(rename = "createdAt")]
    created_at: String,
    fingerprint: String,
}

impl StoredVaultEntry {
    fn integrity_ok(&self) -> bool {
        // Key order must match TypeScript JSON.stringify({key, encrypted, iv})
        // which uses insertion order, NOT alphabetical (serde_json default).
        let payload = format!(
            r#"{{"key":"{}","encrypted":"{}","iv":"{}"}}"#,
            self.key, self.encrypted, self.iv
        );
        let digest = Sha256::digest(payload.as_bytes());
        format!("{digest:x}") == self.fingerprint
    }

    fn to_vault_entry(&self) -> Result<VaultEntry, OperatorError> {
        let ciphertext = decode_base64(self.encrypted.as_str())?;
        let nonce = decode_base64(self.iv.as_str())?;
        let tag = match self.tag.as_deref() {
            Some(value) if !value.trim().is_empty() => decode_base64(value)?,
            _ => Vec::new(),
        };
        let created_at = DateTime::parse_from_rfc3339(self.created_at.as_str())
            .map(|value| value.with_timezone(&Utc))
            .map_err(|error| OperatorError::Vault(error.to_string()))?;

        Ok(VaultEntry {
            id: self
                .id
                .clone()
                .unwrap_or_else(|| format!("entry-{}", created_at.timestamp_millis())),
            key: self.key.clone(),
            ciphertext,
            nonce,
            tag,
            created_at,
        })
    }
}

fn load_vault_entries(path: &Path) -> Result<Vec<StoredVaultEntryWithIntegrity>, OperatorError> {
    if !path.exists() {
        return Ok(Vec::new());
    }
    let raw = fs::read_to_string(path).map_err(|error| OperatorError::Io(error.to_string()))?;
    if raw.trim().is_empty() {
        return Ok(Vec::new());
    }
    let entries = serde_json::from_str::<Vec<StoredVaultEntry>>(raw.as_str())
        .map_err(|error| OperatorError::Json(error.to_string()))?;
    Ok(entries
        .into_iter()
        .map(|entry| StoredVaultEntryWithIntegrity {
            integrity_ok: entry.integrity_ok(),
            key: entry.key,
            encrypted: entry.encrypted,
            iv: entry.iv,
            tag: entry.tag,
            id: entry.id,
            created_at: entry.created_at,
            fingerprint: entry.fingerprint,
        })
        .collect())
}

#[derive(Debug, Clone)]
struct StoredVaultEntryWithIntegrity {
    key: String,
    encrypted: String,
    iv: String,
    tag: Option<String>,
    id: Option<String>,
    created_at: String,
    fingerprint: String,
    integrity_ok: bool,
}

impl StoredVaultEntryWithIntegrity {
    fn to_vault_entry(&self) -> Result<VaultEntry, OperatorError> {
        StoredVaultEntry {
            key: self.key.clone(),
            encrypted: self.encrypted.clone(),
            iv: self.iv.clone(),
            tag: self.tag.clone(),
            id: self.id.clone(),
            created_at: self.created_at.clone(),
            fingerprint: self.fingerprint.clone(),
        }
        .to_vault_entry()
    }
}

fn read_vault_state_version(path: &Path) -> Option<u8> {
    let raw = fs::read_to_string(path).ok()?;
    let parsed = serde_json::from_str::<serde_json::Value>(raw.as_str()).ok()?;
    parsed
        .get("version")
        .and_then(|value| value.as_u64())
        .map(|value| value as u8)
        .or(Some(1))
}

// PR9 of plan #1: the legacy `resolve_vault_state_path` band-aid plus its
// `FALLBACK_NOTICE_EMITTED` once-flag are gone. Both vault_state_path and
// vault_entries_path now come from `memphis_paths` (see config.rs), so they
// already resolve under the same `data_dir` — there is no longer any
// "configured path doesn't exist, look beside entries / ~/.memphis"
// asymmetry to detect. The remaining loud "vault path split" diagnostic
// inside `load_vault` still catches the genuinely broken case where an
// operator overrides only one of the two env vars.

fn load_vault(config: &OperatorConfig, optional: bool) -> Result<Option<Vault>, OperatorError> {
    let state_path = config.vault_state_path.clone();
    if optional && !state_path.exists() {
        // Silent-split detection: if the entries file exists at a different
        // path than the missing state file, the operator probably set
        // MEMPHIS_VAULT_ENTRIES_PATH but not MEMPHIS_VAULT_STATE_PATH (or
        // vice versa) — the runtime then cannot decrypt the entries even
        // though `vault list` (TS path) reads them fine. Surface a loud
        // diagnostic instead of silently returning None.
        if config.vault_entries_path.exists() {
            return Err(OperatorError::Vault(format!(
                "vault path split: entries exist at {} but state is missing at {} \
                 (and no fallback found at ~/.memphis/vault-state.json or beside the \
                 entries file). Set MEMPHIS_VAULT_STATE_PATH explicitly.",
                config.vault_entries_path.display(),
                config.vault_state_path.display(),
            )));
        }
        return Ok(None);
    }

    let state = load_vault_state(&state_path)?;
    let vault = match state {
        VaultState::V1 { salt, master_key } => Vault::from_parts(salt, master_key),
        VaultState::V2 {
            salt,
            encrypted_master_key,
            iv,
            tag,
        } => {
            let pepper = std::env::var("MEMPHIS_VAULT_PEPPER")
                .map_err(|_| OperatorError::Vault("MEMPHIS_VAULT_PEPPER missing".to_string()))?;
            if pepper.trim().len() < 12 {
                return Err(OperatorError::Vault(
                    "MEMPHIS_VAULT_PEPPER too short (min 12 chars)".to_string(),
                ));
            }
            let master_key = decrypt_master_key_v2(
                pepper.as_str(),
                encrypted_master_key.as_slice(),
                iv.as_slice(),
                tag.as_slice(),
            )?;
            Vault::from_parts(salt, master_key)
        }
    };

    Ok(Some(vault))
}

fn read_vault_entry_plaintext(
    vault: &Vault,
    entry: StoredVaultEntryWithIntegrity,
) -> Result<String, OperatorError> {
    if !entry.integrity_ok {
        return Err(OperatorError::Vault(format!(
            "vault entry failed integrity check: {}",
            entry.key
        )));
    }

    let plaintext = vault
        .retrieve(&entry.to_vault_entry()?)
        .map_err(|error| OperatorError::Vault(error.to_string()))?;

    String::from_utf8(plaintext).map_err(|error| OperatorError::Vault(error.to_string()))
}

pub(crate) fn try_read_vault_secret_plaintext(
    config: &OperatorConfig,
    key: &str,
) -> Result<Option<String>, OperatorError> {
    let Some(vault) = load_vault(config, true)? else {
        return Ok(None);
    };

    let entries = load_vault_entries(&config.vault_entries_path)?;
    let Some(entry) = entries.into_iter().filter(|entry| entry.key == key).last() else {
        return Ok(None);
    };

    let plaintext = read_vault_entry_plaintext(&vault, entry)?;
    if plaintext.trim().is_empty() {
        return Ok(None);
    }

    Ok(Some(plaintext))
}

fn load_vault_state(path: &Path) -> Result<VaultState, OperatorError> {
    let raw = fs::read_to_string(path).map_err(|error| OperatorError::Io(error.to_string()))?;
    let parsed = serde_json::from_str::<serde_json::Value>(raw.as_str())
        .map_err(|error| OperatorError::Json(error.to_string()))?;

    if parsed
        .get("version")
        .and_then(|value| value.as_u64())
        .map(|value| value == 2)
        .unwrap_or(false)
    {
        let state = serde_json::from_value::<PersistedVaultStateV2>(parsed)
            .map_err(|error| OperatorError::Json(error.to_string()))?;
        return Ok(VaultState::V2 {
            salt: decode_array32(state.salt.as_str())?,
            encrypted_master_key: decode_base64(state.encrypted_master_key.as_str())?,
            iv: decode_base64(state.iv.as_str())?,
            tag: decode_base64(state.tag.as_str())?,
        });
    }

    let state = serde_json::from_value::<PersistedVaultStateV1>(parsed)
        .map_err(|error| OperatorError::Json(error.to_string()))?;
    Ok(VaultState::V1 {
        salt: decode_array32(state.salt.as_str())?,
        master_key: decode_array32(state.master_key.as_str())?,
    })
}

fn decode_base64(value: &str) -> Result<Vec<u8>, OperatorError> {
    STANDARD
        .decode(value)
        .map_err(|error| OperatorError::Vault(error.to_string()))
}

fn decode_array32(value: &str) -> Result<[u8; 32], OperatorError> {
    let bytes = decode_base64(value)?;
    bytes
        .as_slice()
        .try_into()
        .map_err(|_| OperatorError::Vault("expected 32-byte base64 value".to_string()))
}

fn decrypt_master_key_v2(
    pepper: &str,
    encrypted_master_key: &[u8],
    iv: &[u8],
    tag: &[u8],
) -> Result<[u8; 32], OperatorError> {
    let params =
        ScryptParams::new(14, 8, 1, 32).map_err(|error| OperatorError::Vault(error.to_string()))?;
    let mut key = [0u8; 32];
    scrypt(
        pepper.as_bytes(),
        b"memphis-vault-state-v2",
        &params,
        &mut key,
    )
    .map_err(|error| OperatorError::Vault(error.to_string()))?;

    let cipher = Aes256Gcm::new_from_slice(key.as_slice())
        .map_err(|error| OperatorError::Vault(error.to_string()))?;
    let nonce = Nonce::from_slice(iv);
    let mut payload = encrypted_master_key.to_vec();
    payload.extend_from_slice(tag);
    let plaintext = cipher
        .decrypt(nonce, payload.as_slice())
        .map_err(|_| OperatorError::Vault("failed to decrypt vault state".to_string()))?;
    plaintext
        .as_slice()
        .try_into()
        .map_err(|_| OperatorError::Vault("vault state master key had invalid length".to_string()))
}

#[cfg(test)]
mod tests {
    use super::{open_sqlite, SearchMode};
    use std::{
        fs,
        path::{Path, PathBuf},
        time::{SystemTime, UNIX_EPOCH},
    };

    struct TestRuntimeDir {
        path: PathBuf,
    }

    impl TestRuntimeDir {
        fn new(label: &str) -> Self {
            let unique = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("system time before unix epoch")
                .as_nanos();
            let path = std::env::temp_dir().join(format!("memphis-operator-{label}-{unique}"));
            fs::create_dir_all(path.join("chains").join("journal")).expect("create chains dir");
            fs::write(
                path.join("chains").join("journal").join("000001.json"),
                "{}",
            )
            .expect("seed block");
            Self { path }
        }

        fn data_dir(&self) -> &Path {
            &self.path
        }

        fn database_path(&self) -> PathBuf {
            self.path.join("memphis.db")
        }
    }

    impl Drop for TestRuntimeDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.path);
        }
    }

    #[test]
    fn snapshot_reads_native_runtime_state() {
        let runtime_dir = TestRuntimeDir::new("snapshot");
        let database_url = format!("file:{}", runtime_dir.database_path().display());
        let vault_state_path = runtime_dir.data_dir().join("vault-state.json");
        let vault_entries_path = runtime_dir.data_dir().join("vault-entries.json");
        let custom = super::OperatorConfig::from_iter([
            ("HOME", "/tmp/home"),
            (
                "MEMPHIS_DATA_DIR",
                runtime_dir.data_dir().to_string_lossy().as_ref(),
            ),
            ("DATABASE_URL", database_url.as_str()),
            (
                "MEMPHIS_VAULT_STATE_PATH",
                vault_state_path.to_string_lossy().as_ref(),
            ),
            (
                "MEMPHIS_VAULT_ENTRIES_PATH",
                vault_entries_path.to_string_lossy().as_ref(),
            ),
            ("DEFAULT_PROVIDER", "ollama"),
        ]);
        let runtime = super::OperatorRuntime { config: custom };
        let snapshot = runtime.snapshot();

        let overview = snapshot.overview.expect("overview");
        assert_eq!(overview.default_provider, "ollama");
        assert_eq!(overview.chains, 1);
        assert_eq!(overview.blocks, 1);
        assert_eq!(overview.vault_entries, 0);

        let system = snapshot.system.expect("system");
        assert!(system
            .data_dir
            .ends_with(runtime_dir.data_dir().to_string_lossy().as_ref()));
        assert_eq!(system.chain_names, vec!["journal".to_string()]);
        assert_eq!(system.matrix.federation, "unavailable");
        assert_eq!(system.matrix.trust_mode, "trusted-pilot");
        assert_eq!(system.telegram.state, "disabled");

        let memory = snapshot.memory.expect("memory");
        assert_eq!(memory.exact_entries, 0);

        let sessions = snapshot.sessions.expect("sessions");
        assert_eq!(sessions.count, 0);

        let cases = snapshot.cases.expect("cases");
        assert_eq!(cases.count, 0);
    }

    #[test]
    fn system_summary_reports_native_channel_and_federation_readiness() {
        let runtime_dir = TestRuntimeDir::new("system-readiness");
        let database_path = runtime_dir.database_path();
        let conn = open_sqlite(&database_path).expect("open sqlite");
        conn.execute_batch(
            r#"
            CREATE TABLE agent_peers (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              did TEXT NOT NULL
            );
            "#,
        )
        .expect("create agent_peers table");

        let database_url = format!("file:{}", database_path.display());
        let custom = super::OperatorConfig::from_iter([
            ("HOME", "/tmp/home"),
            (
                "MEMPHIS_DATA_DIR",
                runtime_dir.data_dir().to_string_lossy().as_ref(),
            ),
            ("DATABASE_URL", database_url.as_str()),
            ("MEMPHIS_MATRIX_ENABLED", "true"),
            (
                "MEMPHIS_MATRIX_HOMESERVER",
                "https://matrix.internal.example",
            ),
            (
                "MEMPHIS_MATRIX_ACCESS_TOKEN",
                "VAULT:MEMPHIS_MATRIX_ACCESS_TOKEN",
            ),
            ("MEMPHIS_MATRIX_ADMIN_USER", "memphis_admin"),
            ("MEMPHIS_CHANNEL_GATEWAY_ENABLED", "true"),
            ("MEMPHIS_TELEGRAM_BOT_TOKEN", "telegram-token"),
            ("MEMPHIS_TELEGRAM_CHAT_ID", "123456"),
            ("MEMPHIS_TELEGRAM_ALLOWED_USER_IDS", "1, 2"),
        ]);
        let runtime = super::OperatorRuntime { config: custom };

        let system = runtime.load_system_summary().expect("system summary");

        assert_eq!(system.matrix.federation, "ready");
        assert_eq!(system.matrix.trust_mode, "trusted-pilot");
        assert_eq!(system.matrix.access_token_source, "vault-ref");
        assert!(system.matrix.peer_storage_ready);
        assert_eq!(system.matrix.reasons, Vec::<String>::new());

        assert_eq!(system.telegram.state, "ready");
        assert_eq!(system.telegram.token_source, "memphis");
        assert!(system.telegram.chat_id_configured);
        assert!(system.telegram.allowlist_enabled);
        assert_eq!(system.telegram.allowlist_count, 2);
    }

    #[test]
    fn exact_search_reads_fts_index() {
        let runtime_dir = TestRuntimeDir::new("exact");
        let database_path = runtime_dir.database_path();
        let conn = open_sqlite(&database_path).expect("open sqlite");
        conn.execute_batch(
            r#"
            CREATE TABLE memory_search_entries (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              source_key TEXT NOT NULL,
              chain_name TEXT NOT NULL,
              block_index INTEGER NOT NULL,
              block_type TEXT NOT NULL,
              summary TEXT NOT NULL
            );
            CREATE VIRTUAL TABLE memory_search_fts USING fts5(content);
            "#,
        )
        .expect("create fts tables");
        conn.execute(
            "INSERT INTO memory_search_entries (source_key, chain_name, block_index, block_type, summary) VALUES (?1, ?2, ?3, ?4, ?5)",
            ("journal:1", "journal", 1_i64, "journal", "alpha phrase summary"),
        )
        .expect("insert search entry");
        let row_id = conn.last_insert_rowid();
        conn.execute(
            "INSERT INTO memory_search_fts(rowid, content) VALUES (?1, ?2)",
            (row_id, "alpha phrase with precise marker"),
        )
        .expect("insert fts row");

        let database_url = format!("file:{}", database_path.display());
        let vault_state_path = runtime_dir.data_dir().join("vault-state.json");
        let vault_entries_path = runtime_dir.data_dir().join("vault-entries.json");
        let config = super::OperatorConfig::from_iter([
            ("HOME", "/tmp/home"),
            (
                "MEMPHIS_DATA_DIR",
                runtime_dir.data_dir().to_string_lossy().as_ref(),
            ),
            ("DATABASE_URL", database_url.as_str()),
            (
                "MEMPHIS_VAULT_STATE_PATH",
                vault_state_path.to_string_lossy().as_ref(),
            ),
            (
                "MEMPHIS_VAULT_ENTRIES_PATH",
                vault_entries_path.to_string_lossy().as_ref(),
            ),
        ]);
        let runtime = super::OperatorRuntime { config };
        let result = runtime
            .search_exact("precise marker", 5, None)
            .expect("exact search");

        assert_eq!(result.mode, SearchMode::Exact);
        assert_eq!(result.count, 1);
        assert_eq!(result.exact_hits[0].chain, "journal");
        assert!(result.exact_hits[0].snippet.contains("precise"));
    }
}
