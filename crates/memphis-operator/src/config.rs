use std::{
    collections::HashMap,
    env,
    path::{Path, PathBuf},
};

use memphis_embed::{EmbedConfig, EmbedMode, EmbedPersistenceConfig};

#[derive(Debug, Clone)]
pub struct OperatorConfig {
    pub raw_env: HashMap<String, String>,
    pub data_dir: PathBuf,
    pub database_path: PathBuf,
    pub case_index_path: PathBuf,
    pub vault_state_path: PathBuf,
    pub vault_entries_path: PathBuf,
    pub embed_persist_path: PathBuf,
    pub embed_persist_enabled: bool,
    pub embed_config: EmbedConfig,
    pub default_provider: String,
    pub rust_chain_enabled: bool,
    pub rust_bridge_path: String,
    pub matrix_enabled: bool,
    pub telegram_enabled: bool,
}

impl OperatorConfig {
    pub fn from_env() -> Self {
        Self::from_iter(env::vars())
    }

    pub fn from_iter<I, K, V>(vars: I) -> Self
    where
        I: IntoIterator<Item = (K, V)>,
        K: Into<String>,
        V: Into<String>,
    {
        let env_map = vars
            .into_iter()
            .map(|(key, value)| (key.into(), value.into()))
            .collect::<HashMap<String, String>>();

        // PR9 of plan #1 (`memphis-architectural-refactor.md`): every
        // path is resolved through the shared `memphis-paths` crate so
        // this config object agrees with the TS-side `vault-paths.ts`
        // bridge consumer down to the byte. Operator's 2026-04-29
        // vault-path-split incident lived in the gap between the two
        // independent resolvers — that gap no longer exists.
        let cwd = env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
        let data_dir = memphis_paths::resolve_data_dir(&env_map, &cwd);
        let database_path = memphis_paths::resolve_database_path(&env_map, &cwd);
        let case_index_path = memphis_paths::resolve_case_index_path(&env_map, &cwd);
        let vault_state_path = memphis_paths::resolve_vault_state_path(&env_map, &cwd);
        let vault_entries_path = memphis_paths::resolve_vault_entries_path(&env_map, &cwd);
        let embed_persist_path = memphis_paths::resolve_embed_index_path(&env_map, &cwd);
        let embed_persist_enabled = parse_bool(
            env_map
                .get("RUST_EMBED_PERSIST_ENABLED")
                .map(String::as_str),
            false,
        ) || embed_persist_path.exists();

        Self {
            raw_env: env_map.clone(),
            data_dir,
            database_path,
            case_index_path,
            vault_state_path,
            vault_entries_path,
            embed_persist_path: embed_persist_path.clone(),
            embed_persist_enabled,
            embed_config: EmbedConfig {
                mode: embed_mode_from_env(&env_map),
                dim: parse_usize(env_map.get("RUST_EMBED_DIM").map(String::as_str), 32),
                max_text_bytes: parse_usize(
                    env_map.get("RUST_EMBED_MAX_TEXT_BYTES").map(String::as_str),
                    4096,
                ),
                provider_url: trim_opt(env_map.get("RUST_EMBED_PROVIDER_URL")),
                provider_api_key: trim_opt(env_map.get("RUST_EMBED_PROVIDER_API_KEY")),
                provider_model: trim_opt(env_map.get("RUST_EMBED_PROVIDER_MODEL")),
                provider_timeout_ms: parse_u64(
                    env_map
                        .get("RUST_EMBED_PROVIDER_TIMEOUT_MS")
                        .map(String::as_str),
                    8000,
                ),
            },
            default_provider: env_map
                .get("DEFAULT_PROVIDER")
                .cloned()
                .unwrap_or_else(|| "ollama".to_string()),
            rust_chain_enabled: parse_bool(
                env_map.get("RUST_CHAIN_ENABLED").map(String::as_str),
                true,
            ),
            rust_bridge_path: env_map
                .get("RUST_CHAIN_BRIDGE_PATH")
                .cloned()
                .unwrap_or_else(|| "./crates/memphis-napi".to_string()),
            matrix_enabled: parse_bool(
                env_map.get("MEMPHIS_MATRIX_ENABLED").map(String::as_str),
                false,
            ),
            telegram_enabled: trim_opt(env_map.get("MEMPHIS_TELEGRAM_BOT_TOKEN")).is_some(),
        }
    }

    pub fn embed_persistence(&self) -> EmbedPersistenceConfig {
        EmbedPersistenceConfig {
            enabled: self.embed_persist_enabled,
            index_path: self.embed_persist_path.clone(),
        }
    }

    pub fn env(&self, key: &str) -> Option<&str> {
        self.raw_env
            .get(key)
            .map(String::as_str)
            .filter(|value| !value.trim().is_empty())
    }
}

fn trim_opt(value: Option<&String>) -> Option<String> {
    value.and_then(|inner| {
        let trimmed = inner.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        }
    })
}

fn parse_bool(value: Option<&str>, default: bool) -> bool {
    value
        .map(|inner| inner.trim().eq_ignore_ascii_case("true"))
        .unwrap_or(default)
}

fn parse_usize(value: Option<&str>, default: usize) -> usize {
    value
        .and_then(|inner| inner.trim().parse::<usize>().ok())
        .unwrap_or(default)
}

fn parse_u64(value: Option<&str>, default: u64) -> u64 {
    value
        .and_then(|inner| inner.trim().parse::<u64>().ok())
        .unwrap_or(default)
}

fn embed_mode_from_env(env_map: &HashMap<String, String>) -> EmbedMode {
    let mode = env_map
        .get("RUST_EMBED_MODE")
        .map(String::as_str)
        .unwrap_or("local")
        .trim()
        .to_ascii_lowercase();

    match mode.as_str() {
        "provider" | "openai-compatible" => EmbedMode::Provider("openai-compatible".to_string()),
        "ollama" => EmbedMode::Provider("ollama".to_string()),
        "cohere" => EmbedMode::Provider("cohere".to_string()),
        "voyage" => EmbedMode::Provider("voyage".to_string()),
        "jina" => EmbedMode::Provider("jina".to_string()),
        "mistral" => EmbedMode::Provider("mistral".to_string()),
        "together" => EmbedMode::Provider("together".to_string()),
        "nvidia" => EmbedMode::Provider("nvidia".to_string()),
        "mixedbread" => EmbedMode::Provider("mixedbread".to_string()),
        _ => EmbedMode::LocalDeterministic,
    }
}

pub fn format_path(path: &Path) -> String {
    path.to_string_lossy().to_string()
}

#[cfg(test)]
mod tests {
    use super::OperatorConfig;

    #[test]
    fn derives_paths_and_embed_defaults() {
        let config = OperatorConfig::from_iter([
            ("HOME", "/tmp/home"),
            ("MEMPHIS_DATA_DIR", "~/runtime"),
            ("DATABASE_URL", "file:./data/custom.db"),
            ("RUST_EMBED_MODE", "ollama"),
            ("RUST_EMBED_PERSIST_ENABLED", "true"),
        ]);

        assert!(config.data_dir.ends_with("runtime"));
        assert!(config.database_path.ends_with("data/custom.db"));
        assert!(config.embed_persist_enabled);
        assert_eq!(config.default_provider, "ollama");
    }
}
