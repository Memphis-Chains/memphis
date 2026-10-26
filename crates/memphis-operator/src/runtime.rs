use std::{fs, path::Path};

use memphis_case_index::CaseIndex;
use memphis_core::case_entry::CaseQuery;
use memphis_embed::{EmbedPersistenceLoadState, EmbedPipeline};
use memphis_vault::{
    entries::{load_entries as load_vault_entries, select_entries, EntryError, StoredEntry},
    state::{decode_persisted_state, VaultStateError},
    Vault,
};
use rusqlite::{params, Connection};
use serde::Serialize;
use sha2::{Digest, Sha256};
use thiserror::Error;
use zeroize::Zeroizing;

use crate::config::{format_path, OperatorConfig};

#[path = "vault_snapshot.rs"]
mod vault_snapshot;

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
    #[error("vault: {0}")]
    VaultState(#[from] VaultStateError),
    #[error("vault: {0}")]
    VaultEntry(#[from] EntryError),
    #[error("embed: {0}")]
    Embed(String),
    /// The provider rejected the request because the prompt + history exceeded
    /// the model's context window. Distinct from a generic provider error so
    /// the TUI can render an actionable hint ("use /clear to drop history")
    /// instead of the generic "provider X failed" message.
    ///
    /// `tokens_used` and `context_window` are best-effort — providers don't
    /// always echo them in their error response. Both Optional; either
    /// missing means "not parsed from the upstream response". When BOTH
    /// are None (e.g. MiniMax `context window exceeds limit (2013)` where
    /// 2013 is an internal code, not a token count), the rendered message
    /// omits the parenthesized hint entirely — operator 2026-05-10 hit
    /// the prior `(None / None tokens)` ugly variant.
    #[error(
        "provider {provider} context window exceeded {}— use /clear in the TUI to drop history",
        format_overflow_label(tokens_used, context_window)
    )]
    ContextOverflow {
        provider: String,
        tokens_used: Option<u32>,
        context_window: Option<u32>,
    },
}

/// Pretty-print the `(used / window tokens)` segment of a `ContextOverflow`
/// error. Returns:
///   * `"(N / M tokens) "` when both numbers are known (OpenAI format)
///   * `"(used: N tokens) "` when only used is known
///   * `"(limit: M tokens) "` when only window is known
///   * `""` when both are None — drops the parenthesized hint entirely
///     instead of rendering the ugly `(None / None tokens)` variant
///     operator hit 2026-05-10 with MiniMax `context window exceeds
///     limit (2013)` (where 2013 was an internal code, not a token
///     count, so parser correctly returned (None, None) but the
///     thiserror format string still tried to interpolate them).
fn format_overflow_label(tokens_used: &Option<u32>, context_window: &Option<u32>) -> String {
    match (tokens_used, context_window) {
        (Some(used), Some(window)) => format!("({used} / {window} tokens) "),
        (Some(used), None) => format!("(used: {used} tokens) "),
        (None, Some(window)) => format!("(limit: {window} tokens) "),
        (None, None) => String::new(),
    }
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

#[derive(Clone, Serialize)]
pub struct VaultSecretView {
    pub key: String,
    pub created_at: String,
    pub plaintext: String,
}

// Debug is a diagnostic projection; serialized credential contracts stay unchanged.
impl std::fmt::Debug for VaultSecretView {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("VaultSecretView")
            .field("key", &self.key)
            .field("created_at", &self.created_at)
            .finish_non_exhaustive()
    }
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
        with_vault_read_snapshot(&self.config, false, |vault| {
            let vault = vault.expect("strict vault load should return a vault instance");
            let entries = load_vault_entries(&self.config.vault_entries_path)?;
            let entry = select_entries(entries, Some(key), true)
                .pop()
                .ok_or(EntryError::NotFound)?;
            let key = entry.key.clone();
            let created_at = entry.created_at.clone().unwrap_or_default();
            let plaintext = read_vault_entry_plaintext(&vault, entry)?;
            Ok(VaultSecretView {
                key,
                created_at,
                plaintext,
            })
        })
    }

    /// Cached `(doc_count, load_state)` for the embed persistence index.
    ///
    /// 2026-09-30: `load_memory_summary` built a full `EmbedPipeline`,
    /// which reads and parses the whole on-disk index — 107 MB of JSON,
    /// 10057 documents on this operator's runtime — to produce three
    /// values, and the expensive two (`len`, `persistence_load_state`)
    /// come from that load. `snapshot()` calls this, the TUI calls
    /// `snapshot()` twice at startup and again on every refresh, and
    /// `health` calls it too.
    ///
    /// Measured: 5.2 s for the first `load_memory_summary`, 4.7 s again
    /// for the second. So a single `--check-only` probe - a liveness
    /// check, by its own name - spent ~10 s parsing JSON.
    ///
    /// Memoised on the index file's (size, mtime), the same signal
    /// `load_vault_cached` uses. A reindex rewrites the file and changes
    /// both, so the cache misses exactly when the answer would change.
    fn embed_persistence_stats(
        &self,
    ) -> Result<(usize, memphis_embed::EmbedPersistenceLoadState), OperatorError> {
        use std::collections::HashMap;
        use std::sync::Mutex;
        use std::sync::OnceLock;

        static STATS: OnceLock<
            Mutex<HashMap<String, (usize, memphis_embed::EmbedPersistenceLoadState)>>,
        > = OnceLock::new();
        let cache = STATS.get_or_init(|| Mutex::new(HashMap::new()));

        let persistence = self.config.embed_persistence();
        if !persistence.enabled {
            return Ok((0, memphis_embed::EmbedPersistenceLoadState::Disabled));
        }

        // Fingerprint before touching the index: stat is cheap, the read
        // is 107 MB.
        let sibling = persistence.index_path.with_extension("ndjson");
        let active_path = if sibling.exists() {
            &sibling
        } else {
            &persistence.index_path
        };
        let fingerprint = std::fs::metadata(active_path)
            .map(|meta| {
                let mtime = meta
                    .modified()
                    .ok()
                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|d| d.as_nanos())
                    .unwrap_or(0);
                format!("{}:{mtime}", meta.len())
            })
            .unwrap_or_else(|_| "missing".to_string());
        let cache_key = format!("{}|{fingerprint}", active_path.display());

        {
            let guard = cache.lock().unwrap_or_else(|e| e.into_inner());
            if let Some((count, state)) = guard.get(&cache_key) {
                return Ok((*count, state.clone()));
            }
        }

        let metadata = memphis_embed::metadata::inspect_index(&persistence.index_path);
        let state = match metadata.state.as_str() {
            "loaded" => memphis_embed::EmbedPersistenceLoadState::Loaded,
            "empty" => memphis_embed::EmbedPersistenceLoadState::Empty,
            "missing" => memphis_embed::EmbedPersistenceLoadState::Missing,
            _ => memphis_embed::EmbedPersistenceLoadState::Corrupt,
        };
        let stats = (metadata.documents, state);
        let mut guard = cache.lock().unwrap_or_else(|e| e.into_inner());
        if guard.len() >= 16 {
            guard.clear();
        }
        guard.insert(cache_key, stats.clone());
        Ok(stats)
    }

    fn load_memory_summary(&self) -> Result<MemorySummary, OperatorError> {
        let (semantic_docs, load_state) = self.embed_persistence_stats()?;
        // Provider name is a config field, not index state - do not pay
        // the index read for it. `with_provider_only` builds the same
        // provider with an empty document set.
        let semantic_provider = EmbedPipeline::with_provider_only(self.config.embed_config.clone())
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
            semantic_provider: semantic_provider.provider_name().to_string(),
            semantic_docs,
            semantic_persistence_state: persistence_label(load_state).to_string(),
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
        let _snapshot = vault_snapshot::VaultReadGuard::acquire(
            &self.config,
            &resolve_vault_state_path(&self.config),
        )?;
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
                    key: entry.key.clone(),
                    created_at: entry.created_at.clone().unwrap_or_default(),
                    fingerprint: entry.fingerprint.clone().unwrap_or_default(),
                    integrity_ok: entry.integrity_ok(),
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
        .filter(|name| is_active_chain_name(name))
        .collect::<Vec<_>>();
    names.sort();
    names
}

fn is_active_chain_name(name: &str) -> bool {
    let Some((_, suffix)) = name.rsplit_once(".backup-") else {
        return true;
    };
    !suffix.is_empty() && !suffix.chars().all(|ch| ch.is_ascii_digit())
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
    // Best-effort busy_timeout so a concurrent writer doesn't return false
    // merely because the probe read hit a transient lock. 5000ms matches
    // open_sqlite() and the node-side createSqliteClient.
    let _ = conn.pragma_update(None, "busy_timeout", 5000i64);

    conn.query_row(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'agent_peers' LIMIT 1",
        [],
        |row| row.get::<_, i64>(0),
    )
    .map(|value| value == 1)
    .unwrap_or(false)
}

fn open_sqlite(path: &Path) -> Result<Connection, OperatorError> {
    let conn = Connection::open(path).map_err(|error| OperatorError::Sqlite(error.to_string()))?;
    // Match node-side createSqliteClient in src/infra/storage/sqlite/client.ts:
    // rusqlite default busy_timeout is 0 (= immediate SQLITE_BUSY), and the
    // rust side opens the same memphis.db the node writers use. Without this
    // PRAGMA, any write transaction holding a lock would surface as a hard
    // "database is locked" instead of waiting up to 5s like the TS adapter.
    conn.pragma_update(None, "busy_timeout", 5000i64)
        .map_err(|e| OperatorError::Sqlite(e.to_string()))?;
    conn.pragma_update(None, "journal_mode", "WAL")
        .map_err(|e| OperatorError::Sqlite(e.to_string()))?;
    Ok(conn)
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

fn read_vault_state_version(path: &Path) -> Option<u8> {
    let raw = fs::read_to_string(path).ok()?;
    let parsed = serde_json::from_str::<serde_json::Value>(raw.as_str()).ok()?;
    parsed
        .get("version")
        .and_then(|value| value.as_u64())
        .map(|value| value as u8)
        .or(Some(1))
}

/// Auto-resolve the vault-state path with fallbacks. The configured path
/// (from MEMPHIS_VAULT_STATE_PATH or default ./data/vault-state.json) wins
/// when it exists. Otherwise, before failing, look in two well-known places:
///   1. the directory containing vault_entries_path (operator probably moved
///      entries via env override and the state moved with them)
///   2. ~/.memphis/vault-state.json (the legacy / TS-side default)
/// Returns the configured path unchanged if neither fallback exists, so the
/// caller can produce the existing operator-actionable error message.
///
/// Notice is process-once via FALLBACK_NOTICE_EMITTED — load_vault is hit
/// many times per process (chat init, status probes, vault reads), and
/// printing the same notice 4+ times per TUI launch is hostile.
fn resolve_vault_state_path(config: &OperatorConfig) -> std::path::PathBuf {
    // Explicit configuration must never silently select another vault.
    if config
        .raw_env
        .get("MEMPHIS_VAULT_STATE_PATH")
        .is_some_and(|p| !p.trim().is_empty())
        || config.vault_state_path.exists()
    {
        return config.vault_state_path.clone();
    }
    if let Some(parent) = config.vault_entries_path.parent() {
        let sibling = parent.join("vault-state.json");
        if sibling.exists() {
            emit_fallback_notice_once(&format!(
                "[memphis-vault] using sibling vault-state at {} (configured path {} does not exist)",
                sibling.display(),
                config.vault_state_path.display(),
            ));
            return sibling;
        }
    }
    if let Some(home) = std::env::var_os("HOME") {
        let legacy = std::path::PathBuf::from(home)
            .join(".memphis")
            .join("vault-state.json");
        if legacy.exists() {
            emit_fallback_notice_once(&format!(
                "[memphis-vault] using legacy ~/.memphis/vault-state.json (configured path {} does not exist); set MEMPHIS_VAULT_STATE_PATH to silence this notice",
                config.vault_state_path.display(),
            ));
            return legacy;
        }
    }
    config.vault_state_path.clone()
}

static FALLBACK_NOTICE_EMITTED: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);

fn emit_fallback_notice_once(message: &str) {
    if FALLBACK_NOTICE_EMITTED
        .compare_exchange(
            false,
            true,
            std::sync::atomic::Ordering::SeqCst,
            std::sync::atomic::Ordering::SeqCst,
        )
        .is_ok()
    {
        eprintln!("{message}");
    }
}

struct CachedVault {
    fingerprint: [u8; 32],
    vault: Vault,
}

// Only the current handle survives. Replaced/error generations drop their
// Vault immediately, which zeroizes its master key.
type VaultDerivationCache = std::sync::Mutex<Option<CachedVault>>;

// Readers and explicit invalidation must address the same cache instance.
static VAULT_DERIVATION_CACHE: std::sync::OnceLock<VaultDerivationCache> =
    std::sync::OnceLock::new();

/// Decrypted vault handle, memoised on the bytes it was derived from.
///
/// 2026-09-30: `load_vault` runs `scrypt(N=16384, r=8, p=1)` via
/// the shared persisted-state reader. That is ~4 s on this operator's hardware and
/// it is by design - the parameter is the vault's brute-force defence.
/// But it was being paid once PER PROVIDER LOOKUP: `resolve_provider`
/// calls it for minimax, deepseek and glm independently, so building the
/// operator's provider list cost 5.3 s + 3.5 s + 3.5 s = 12.3 s of pure
/// KDF, and `memphis-tui --check-only` measured 15.6 s wall (limit 15 s,
/// hence the long-standing "flaky" tui-binary-smoke timeout).
///
/// The KDF output depends only on (pepper, state-file bytes). Neither
/// changes between the three calls in one process, so memoising on
/// (pepper, path, file contents) is exact - not an approximation, not a
/// TTL. Reading the state file is kept on every call (a few hundred
/// bytes); only the expensive derivation is skipped, and only when the
/// inputs are byte-identical. A vault rotation changes the bytes and
/// misses the cache immediately.
///
/// Measured after: `provider_statuses` 10.6 s -> ~3.5 s, `--check-only`
/// 15.6 s -> ~4.5 s.
struct VaultInputs {
    fingerprint: [u8; 32],
    state: Zeroizing<Vec<u8>>,
    pepper: Zeroizing<String>,
}

fn read_vault_inputs(
    config: &OperatorConfig,
    optional: bool,
) -> Result<Option<VaultInputs>, OperatorError> {
    let state_path = resolve_vault_state_path(config);
    let state = match fs::read(&state_path) {
        Ok(bytes) => Zeroizing::new(bytes),
        Err(error) => {
            clear_vault_derivation_cache();
            if error.kind() == std::io::ErrorKind::NotFound {
                return if optional && !config.vault_entries_path.exists() {
                    Ok(None)
                } else {
                    Err(VaultStateError::Missing.into())
                };
            }
            return Err(VaultStateError::Unreadable.into());
        }
    };
    let pepper = Zeroizing::new(std::env::var("MEMPHIS_VAULT_PEPPER").unwrap_or_default());
    let mut identity = Sha256::new();
    // Internal only: this digest includes credential material. Never log it.
    for bytes in [
        state_path.as_os_str().as_encoded_bytes(),
        pepper.as_bytes(),
        &config.config_generation.to_le_bytes(),
        state.as_slice(),
    ] {
        identity.update((bytes.len() as u64).to_le_bytes());
        identity.update(bytes);
    }
    Ok(Some(VaultInputs {
        fingerprint: identity.finalize().into(),
        state,
        pepper,
    }))
}

fn acquire_vault_snapshot(
    config: &OperatorConfig,
) -> Result<vault_snapshot::VaultReadGuard, OperatorError> {
    vault_snapshot::VaultReadGuard::acquire(config, &resolve_vault_state_path(config))
        .inspect_err(|_| clear_vault_derivation_cache())
}

/// Capture inputs under the journal locks, derive outside them, then validate
/// again before selecting/decrypting an entry. An expensive KDF must not hold
/// every other process's configuration lock or publish an old key as new state.
fn with_vault_read_snapshot<T>(
    config: &OperatorConfig,
    optional: bool,
    read: impl FnOnce(Option<Vault>) -> Result<T, OperatorError>,
) -> Result<T, OperatorError> {
    let cache = VAULT_DERIVATION_CACHE.get_or_init(Default::default);
    for _ in 0..3 {
        let snapshot = acquire_vault_snapshot(config)?;
        let Some(inputs) = read_vault_inputs(config, optional)? else {
            return read(None);
        };
        {
            let mut guard = cache.lock().unwrap_or_else(|e| e.into_inner());
            if let Some(hit) = guard
                .as_ref()
                .filter(|hit| hit.fingerprint == inputs.fingerprint)
            {
                CACHE_HITS.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                let vault = hit.vault.clone();
                drop(guard);
                return read(Some(vault));
            }
            *guard = None;
        }
        drop(snapshot);
        DERIVATIONS.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let loaded = decode_persisted_state(&inputs.state, &inputs.pepper);
        let _snapshot = acquire_vault_snapshot(config)?;
        let Some(current) = read_vault_inputs(config, optional)? else {
            return read(None);
        };
        if inputs.fingerprint != current.fingerprint {
            continue;
        }
        let vault = loaded?.vault;
        *cache.lock().unwrap_or_else(|e| e.into_inner()) = Some(CachedVault {
            fingerprint: inputs.fingerprint,
            vault: vault.clone(),
        });
        return read(Some(vault));
    }
    Err(OperatorError::Vault(
        "vault state changed during loading; retry operation".into(),
    ))
}

#[cfg(test)]
fn load_vault_cached(
    config: &OperatorConfig,
    optional: bool,
) -> Result<Option<Vault>, OperatorError> {
    with_vault_read_snapshot(config, optional, Ok)
}

/// How many times the scrypt KDF actually ran, and how many times the
/// memo answered instead. Exposed for tests only.
///
/// Correctness tests cannot tell "the cache answered" from "the cache was
/// never consulted": both return the same decrypted secret. Mutants that
/// disable the cache write (M4) or the cache read (M3) pass every
/// correctness assertion while reintroducing the 4-second KDF three times
/// over. Counting makes the performance contract a test instead of a
/// comment.
static DERIVATIONS: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
static CACHE_HITS: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
// Used only by `provider::tests`, which live in the same crate.
#[cfg_attr(not(test), allow(dead_code))]
pub(crate) fn vault_derivation_count() -> (usize, usize) {
    (
        DERIVATIONS.load(std::sync::atomic::Ordering::Relaxed),
        CACHE_HITS.load(std::sync::atomic::Ordering::Relaxed),
    )
}

/// Drop every memoised vault. Exists for tests and for the rare
/// in-process vault rotation; a real rotation changes the state-file bytes
/// and misses the cache on its own.
// Used only by `provider::tests`, which live in the same crate.
#[cfg_attr(not(test), allow(dead_code))]
pub(crate) fn clear_vault_derivation_cache() {
    if let Some(cache) = VAULT_DERIVATION_CACHE.get() {
        *cache.lock().unwrap_or_else(|e| e.into_inner()) = None;
    }
}

fn read_vault_entry_plaintext(vault: &Vault, entry: StoredEntry) -> Result<String, OperatorError> {
    entry.decrypt_text(vault).map_err(Into::into)
}

pub(crate) fn try_read_vault_secret_plaintext(
    config: &OperatorConfig,
    key: &str,
) -> Result<Option<String>, OperatorError> {
    with_vault_read_snapshot(config, true, |vault| {
        let Some(vault) = vault else {
            return Ok(None);
        };
        let entries = load_vault_entries(&config.vault_entries_path)?;
        let Some(entry) = select_entries(entries, Some(key), true).pop() else {
            return Ok(None);
        };
        let plaintext = read_vault_entry_plaintext(&vault, entry)?;
        if plaintext.trim().is_empty() {
            return Ok(None);
        }
        Ok(Some(plaintext))
    })
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
            fs::create_dir_all(path.join("chains").join("journal.backup-123"))
                .expect("create backup chain dir");
            fs::write(
                path.join("chains")
                    .join("journal.backup-123")
                    .join("000001.json"),
                "{}",
            )
            .expect("seed backup block");
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
    fn optional_vault_only_treats_missing_state_without_entries_as_absent() {
        let dir = TestRuntimeDir::new("optional-state-errors");
        let state = dir.path.join("state.json");
        let entries = dir.path.join("entries.json");
        let env = [
            (
                "MEMPHIS_VAULT_STATE_PATH",
                state.to_string_lossy().into_owned(),
            ),
            (
                "MEMPHIS_VAULT_ENTRIES_PATH",
                entries.to_string_lossy().into_owned(),
            ),
        ];
        let config = crate::OperatorConfig::from_iter(env);
        assert!(matches!(super::load_vault_cached(&config, true), Ok(None)));
        fs::write(&entries, "[]").unwrap();
        assert!(matches!(
            super::load_vault_cached(&config, true),
            Err(super::OperatorError::VaultState(
                super::VaultStateError::Missing
            ))
        ));
        fs::write(&state, "{synthetic-private-sentinel").unwrap();
        assert!(matches!(
            super::load_vault_cached(&config, true),
            Err(super::OperatorError::VaultState(
                super::VaultStateError::Malformed
            ))
        ));
    }

    #[test]
    fn format_overflow_label_renders_both_numbers() {
        let s = super::format_overflow_label(&Some(38538), &Some(32768));
        assert_eq!(s, "(38538 / 32768 tokens) ");
    }

    #[test]
    fn format_overflow_label_renders_used_only() {
        let s = super::format_overflow_label(&Some(38538), &None);
        assert_eq!(s, "(used: 38538 tokens) ");
    }

    #[test]
    fn format_overflow_label_renders_window_only() {
        let s = super::format_overflow_label(&None, &Some(32768));
        assert_eq!(s, "(limit: 32768 tokens) ");
    }

    #[test]
    fn format_overflow_label_drops_parens_when_both_none() {
        // Operator 2026-05-10 regression: MiniMax `context window exceeds
        // limit (2013)` (where 2013 is internal code) triggered the
        // explicit-marker path with (None, None) extraction → prior
        // format rendered `(None / None tokens)`. Now: empty string,
        // entire parenthesized hint dropped from the error message.
        let s = super::format_overflow_label(&None, &None);
        assert_eq!(s, "");
    }

    #[test]
    fn context_overflow_error_omits_parens_when_both_none() {
        // End-to-end regression: error Display drops the parenthesized
        // segment entirely when the parser couldn't pin down counts.
        let err = super::OperatorError::ContextOverflow {
            provider: "minimax".to_string(),
            tokens_used: None,
            context_window: None,
        };
        let s = format!("{err}");
        assert_eq!(
            s,
            "provider minimax context window exceeded — use /clear in the TUI to drop history"
        );
        assert!(
            !s.contains("None"),
            "should not leak 'None' tokens to operator"
        );
    }

    #[test]
    fn context_overflow_error_renders_full_counts() {
        let err = super::OperatorError::ContextOverflow {
            provider: "openai".to_string(),
            tokens_used: Some(38538),
            context_window: Some(32768),
        };
        let s = format!("{err}");
        assert_eq!(
            s,
            "provider openai context window exceeded (38538 / 32768 tokens) — use /clear in the TUI to drop history"
        );
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
    #[test]
    fn credential_debug_vault_secret_view_omits_plaintext() {
        let secret = "synthetic-native-private-debug-material";
        let value = super::VaultSecretView {
            key: "first".into(),
            created_at: "2026-10-18T00:00:00Z".into(),
            plaintext: secret.into(),
        };
        for debug in [format!("{value:?}"), format!("{value:#?}")] {
            assert!(!debug.contains(secret));
            assert!(!debug.contains(&secret[..16]));
            assert!(!debug.contains(&secret[secret.len() - 16..]));
        }
        // This remains an explicit authorized export type, not a diagnostic DTO.
        assert_eq!(serde_json::to_value(&value).unwrap()["plaintext"], secret);
    }
}
