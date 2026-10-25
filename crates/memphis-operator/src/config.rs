use std::{
    collections::HashMap,
    env,
    path::{Path, PathBuf},
};

use memphis_embed::{EmbedConfig, EmbedMode, EmbedPersistenceConfig};

const DEFAULT_MEMPHIS_DATA_DIR: &str = "~/.memphis";
const DEFAULT_DATABASE_URL: &str = "file:./data/memphis.db";

#[derive(Clone)]
pub struct OperatorConfig {
    pub raw_env: HashMap<String, String>,
    pub runtime_root: PathBuf,
    pub runtime_root_source: String,
    pub env_file_path: Option<PathBuf>,
    pub config_generation: u64,
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

// Debug is a diagnostic projection; serialized credential contracts stay unchanged.
impl std::fmt::Debug for OperatorConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("OperatorConfig")
            .field("config_generation", &self.config_generation)
            .field("rust_chain_enabled", &self.rust_chain_enabled)
            .field("matrix_enabled", &self.matrix_enabled)
            .field("telegram_enabled", &self.telegram_enabled)
            .field("embed_config", &self.embed_config)
            .finish_non_exhaustive()
    }
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

        let runtime_root = env_map
            .get("MEMPHIS_RUNTIME_ROOT")
            .map(PathBuf::from)
            .unwrap_or_else(|| env::current_dir().unwrap_or_else(|_| PathBuf::from(".")));
        let runtime_root_source = env_map
            .get("MEMPHIS_RUNTIME_ROOT_SOURCE")
            .cloned()
            .unwrap_or_else(|| "native-default".to_string());
        let env_file_path = env_map
            .get("MEMPHIS_ENV_FILE")
            .map(|path| resolve_config_path(path, &runtime_root));
        let config_generation = env_map
            .get("MEMPHIS_CONFIG_GENERATION")
            .and_then(|value| value.parse::<u64>().ok())
            .unwrap_or(0);

        let data_dir = resolve_data_dir(&env_map, &runtime_root);
        let database_path = resolve_database_path(&env_map, &runtime_root);
        let case_index_path = data_dir.join("case-index.sqlite");
        // Align with src/infra/storage/vault-paths.ts: vault files live under
        // data_dir (i.e. ~/.memphis/) by default. The previous Rust defaults
        // ./data/vault-state.json and ./data/vault-entries.json resolved
        // against cwd — when memphis ran from anywhere outside the repo
        // checkout, the Rust runtime pointed at non-existent files while the
        // TS layer (and operator's actual files) lived under ~/.memphis/.
        // Operator's 2026-04-29 vault-path-split incident traced to exactly
        // this divergence; fix is to make the two layers agree at the
        // default-resolution step.
        let vault_state_path = env_map
            .get("MEMPHIS_VAULT_STATE_PATH")
            .map(|path| resolve_config_path(path, &runtime_root))
            .unwrap_or_else(|| data_dir.join("vault-state.json"));
        let vault_entries_path = env_map
            .get("MEMPHIS_VAULT_ENTRIES_PATH")
            .map(|path| resolve_config_path(path, &runtime_root))
            .unwrap_or_else(|| data_dir.join("vault-entries.json"));
        let embed_persist_path = env_map
            .get("RUST_EMBED_PERSIST_PATH")
            .map(|path| resolve_config_path(path, &runtime_root))
            .unwrap_or_else(|| data_dir.join("embed").join("index-v1.json"));
        let embed_persist_enabled = parse_bool(
            env_map
                .get("RUST_EMBED_PERSIST_ENABLED")
                .map(String::as_str),
            false,
        ) || embed_persist_path.exists()
            || embed_persist_path.with_extension("ndjson").exists();

        Self {
            raw_env: env_map.clone(),
            runtime_root,
            runtime_root_source,
            env_file_path,
            config_generation,
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
                // Same env var the TypeScript provider reads
                // (`src/providers/index.ts`). Without it the Rust side omits
                // `keep_alive` from the Ollama request, so the server
                // unloads the model after 5 idle minutes and every embed
                // pays a cold load.
                provider_keep_alive: trim_opt(env_map.get("OLLAMA_KEEP_ALIVE")),
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

fn expand_home(input: &str, home: &str) -> PathBuf {
    if input == "~" {
        return PathBuf::from(home);
    }

    if let Some(suffix) = input.strip_prefix("~/") {
        return PathBuf::from(home).join(suffix);
    }

    PathBuf::from(input)
}

fn resolve_data_dir(env_map: &HashMap<String, String>, runtime_root: &Path) -> PathBuf {
    let configured = env_map
        .get("MEMPHIS_DATA_DIR")
        .map(String::as_str)
        .unwrap_or(DEFAULT_MEMPHIS_DATA_DIR);

    let home = env_map
        .get("HOME")
        .cloned()
        .or_else(|| env::var("HOME").ok())
        .unwrap_or_else(|| ".".to_string());
    resolve_config_path(
        &expand_home(configured, &home).to_string_lossy(),
        runtime_root,
    )
}

fn resolve_database_path(env_map: &HashMap<String, String>, runtime_root: &Path) -> PathBuf {
    let database_url = env_map
        .get("DATABASE_URL")
        .map(String::as_str)
        .unwrap_or(DEFAULT_DATABASE_URL);

    let raw = database_url
        .strip_prefix("file:")
        .unwrap_or(database_url)
        .to_string();

    resolve_config_path(&raw, runtime_root)
}

fn resolve_config_path(path: &str, runtime_root: &Path) -> PathBuf {
    let path = PathBuf::from(path);
    if path.is_absolute() {
        path
    } else {
        runtime_root.join(path)
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
    use std::path::PathBuf;

    #[test]
    fn derives_paths_and_embed_defaults() {
        let config = OperatorConfig::from_iter([
            ("HOME", "/tmp/home"),
            ("MEMPHIS_RUNTIME_ROOT", "/tmp/runtime"),
            ("MEMPHIS_RUNTIME_ROOT_SOURCE", "env-override"),
            ("MEMPHIS_ENV_FILE", "/tmp/runtime/.env"),
            ("MEMPHIS_CONFIG_GENERATION", "42"),
            ("MEMPHIS_DATA_DIR", "~/runtime"),
            ("DATABASE_URL", "file:./data/custom.db"),
            ("RUST_EMBED_MODE", "ollama"),
            ("RUST_EMBED_PERSIST_ENABLED", "true"),
        ]);

        assert!(config.data_dir.ends_with("runtime"));
        assert!(config.database_path.ends_with("data/custom.db"));
        assert!(config.embed_persist_enabled);
        assert_eq!(config.default_provider, "ollama");
        assert_eq!(config.runtime_root, PathBuf::from("/tmp/runtime"));
        assert_eq!(config.runtime_root_source, "env-override");
        assert_eq!(
            config.env_file_path,
            Some(PathBuf::from("/tmp/runtime/.env"))
        );
        assert_eq!(config.config_generation, 42);
        assert_eq!(
            config.vault_state_path,
            PathBuf::from("/tmp/home/runtime/vault-state.json")
        );
        assert_eq!(
            config.database_path,
            PathBuf::from("/tmp/runtime/data/custom.db")
        );
    }
    #[test]
    fn credential_debug_operator_config_omits_environment_values() {
        let secret = "synthetic-native-private-debug-material";
        let config = OperatorConfig::from_iter([
            ("MEMPHIS_RUNTIME_ROOT", "/synthetic-runtime"),
            ("HOME", "/synthetic-home"),
            ("MEMPHIS_VAULT_PEPPER", secret),
            ("MINIMAX_API_KEY", secret),
            ("SYNTHETIC_UNKNOWN_FIELD", secret),
            ("MEMPHIS_CONFIG_GENERATION", "7"),
        ]);
        for debug in [format!("{config:?}"), format!("{config:#?}")] {
            assert!(!debug.contains(secret));
            assert!(!debug.contains(&secret[..16]));
            assert!(!debug.contains(&secret[secret.len() - 16..]));
        }
        assert_eq!(
            config
                .raw_env
                .get("MEMPHIS_VAULT_PEPPER")
                .map(String::as_str),
            Some(secret)
        );
        assert_eq!(config.config_generation, 7);
    }
}
