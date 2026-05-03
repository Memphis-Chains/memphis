//! Memphis runtime path resolution — single source of truth.
//!
//! Background: Memphis stores runtime state under a "data dir" (default
//! `~/.memphis/`) with a few well-known sub-paths:
//!   - `vault-state.json`        — encrypted master-key envelope
//!   - `vault-entries.json`      — encrypted secrets store
//!   - `chains/<chain-name>/`    — append-only block files
//!   - `embed/index-v1.json`     — HNSW vector index persistence
//!   - `case-index.sqlite`       — case-chain SQLite index
//!
//! Before this crate, these paths were resolved independently in two
//! places: a TypeScript stack under `src/config/paths.ts` +
//! `src/infra/storage/vault-paths.ts`, and a Rust stack inside
//! `crates/memphis-operator/src/config.rs` plus the band-aid auto-resolver
//! `crates/memphis-operator/src/runtime.rs:1075-1103`. Any operator
//! who overrode one without overriding the other (e.g. moved the vault
//! via `MEMPHIS_VAULT_ENTRIES_PATH` but left `MEMPHIS_VAULT_STATE_PATH`
//! at its default) ended up with a silent split: `vault list` (TS)
//! showed entries that the runtime (Rust) couldn't decrypt.
//!
//! This crate provides **pure** resolver functions. Every function takes
//! the environment as an explicit `&HashMap<String, String>` so callers
//! control determinism, tests don't depend on the host environment, and
//! the TS layer (via the NAPI bridge in `memphis-napi`) plus the Rust
//! `memphis-operator` agree on the path policy down to the byte.
//!
//! Override priority for every file is:
//!   1. Explicit env override for that specific file (e.g.
//!      `MEMPHIS_VAULT_STATE_PATH`).
//!   2. `MEMPHIS_DATA_DIR` joined with the canonical filename.
//!   3. `~/.memphis/` joined with the canonical filename (default).
//!
//! `~` is expanded against `$HOME` (`HOME` env var). When `HOME` is
//! unset, `~` resolves to `.` so paths remain valid PathBufs and the
//! caller can still surface a useful error message — we don't panic on
//! a missing `HOME` because that's recoverable per call site.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

/// Default data dir (canonical, operator-overridable via `MEMPHIS_DATA_DIR`).
const DEFAULT_DATA_DIR: &str = "~/.memphis";

/// Default `DATABASE_URL` shape — `file:./data/memphis.db` is what
/// `src/infra/config/schema.ts` ships, retained here for compatibility.
const DEFAULT_DATABASE_URL: &str = "file:./data/memphis.db";

const VAULT_STATE_FILENAME: &str = "vault-state.json";
const VAULT_ENTRIES_FILENAME: &str = "vault-entries.json";
const CHAINS_SUBDIR: &str = "chains";
const EMBED_SUBDIR: &str = "embed";
const EMBED_INDEX_FILENAME: &str = "index-v1.json";
const CASE_INDEX_FILENAME: &str = "case-index.sqlite";

/// Chain name aliases shared with `src/config/paths.ts`.
/// Keep this table in sync when adding chain-name sugar to either side.
/// (Singular → canonical plural.)
const CHAIN_NAME_ALIASES: &[(&str, &str)] = &[
    ("case", "cases"),
    ("decision", "decisions"),
    ("pattern", "patterns"),
    ("reflection", "reflections"),
];

/// Read a value from the env map, treating empty strings as absent.
fn env_get<'a>(env: &'a HashMap<String, String>, key: &str) -> Option<&'a str> {
    env.get(key)
        .map(String::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
}

/// Expand a leading `~` against the env map's `HOME`. If the input does
/// not start with `~`, returns the input verbatim. If `HOME` is missing,
/// substitutes `.` so the caller still gets a non-panicking PathBuf.
pub fn expand_home(input: &str, env: &HashMap<String, String>) -> PathBuf {
    let home = env_get(env, "HOME").unwrap_or(".");
    if input == "~" {
        return PathBuf::from(home);
    }
    if let Some(suffix) = input.strip_prefix("~/") {
        return PathBuf::from(home).join(suffix);
    }
    PathBuf::from(input)
}

/// Resolve a path string to an absolute form. Relative paths are
/// joined against the caller-supplied `cwd_for_relative` so we don't
/// silently capture `std::env::current_dir()` here.
fn make_absolute(input: PathBuf, cwd_for_relative: &Path) -> PathBuf {
    if input.is_absolute() {
        input
    } else {
        cwd_for_relative.join(input)
    }
}

/// Resolve `MEMPHIS_DATA_DIR` (default `~/.memphis`) to an absolute path.
/// `cwd` is used only when the caller has set `MEMPHIS_DATA_DIR` to a
/// relative path; in the default-everything case `~/.memphis` already
/// resolves to absolute via `HOME`.
pub fn resolve_data_dir(env: &HashMap<String, String>, cwd: &Path) -> PathBuf {
    let configured = env_get(env, "MEMPHIS_DATA_DIR").unwrap_or(DEFAULT_DATA_DIR);
    make_absolute(expand_home(configured, env), cwd)
}

/// Resolve the vault-state.json path. Honors `MEMPHIS_VAULT_STATE_PATH`
/// when set, else falls back to `<data_dir>/vault-state.json`.
pub fn resolve_vault_state_path(env: &HashMap<String, String>, cwd: &Path) -> PathBuf {
    if let Some(explicit) = env_get(env, "MEMPHIS_VAULT_STATE_PATH") {
        return make_absolute(expand_home(explicit, env), cwd);
    }
    resolve_data_dir(env, cwd).join(VAULT_STATE_FILENAME)
}

/// Resolve the vault-entries.json path. Honors `MEMPHIS_VAULT_ENTRIES_PATH`
/// when set, else falls back to `<data_dir>/vault-entries.json`.
pub fn resolve_vault_entries_path(env: &HashMap<String, String>, cwd: &Path) -> PathBuf {
    if let Some(explicit) = env_get(env, "MEMPHIS_VAULT_ENTRIES_PATH") {
        return make_absolute(expand_home(explicit, env), cwd);
    }
    resolve_data_dir(env, cwd).join(VAULT_ENTRIES_FILENAME)
}

/// Resolve the canonical chains directory (`<data_dir>/chains`).
pub fn resolve_chains_dir(env: &HashMap<String, String>, cwd: &Path) -> PathBuf {
    resolve_data_dir(env, cwd).join(CHAINS_SUBDIR)
}

/// Resolve a specific chain's directory, honoring the alias table
/// (`case` → `cases`, `decision` → `decisions`, etc.). Caller passes the
/// pre-validated chain name; an empty name yields the bare chains dir
/// so the alias table never widens accepted input.
pub fn resolve_chain_path(
    env: &HashMap<String, String>,
    cwd: &Path,
    chain_name: &str,
) -> PathBuf {
    let trimmed = chain_name.trim();
    if trimmed.is_empty() {
        return resolve_chains_dir(env, cwd);
    }
    let normalized = normalize_chain_name(trimmed);
    resolve_chains_dir(env, cwd).join(normalized)
}

/// Normalize a chain name through the alias table. Returns the input
/// verbatim when no alias applies. Pure function for sharing with TS.
pub fn normalize_chain_name(input: &str) -> &str {
    for (alias, canonical) in CHAIN_NAME_ALIASES {
        if input == *alias {
            return canonical;
        }
    }
    input
}

/// Resolve the embed-index path. Honors `RUST_EMBED_PERSIST_PATH` when
/// set, else falls back to `<data_dir>/embed/index-v1.json`.
pub fn resolve_embed_index_path(env: &HashMap<String, String>, cwd: &Path) -> PathBuf {
    if let Some(explicit) = env_get(env, "RUST_EMBED_PERSIST_PATH") {
        return make_absolute(expand_home(explicit, env), cwd);
    }
    resolve_data_dir(env, cwd)
        .join(EMBED_SUBDIR)
        .join(EMBED_INDEX_FILENAME)
}

/// Resolve the case-index SQLite path. Always at `<data_dir>/case-index.sqlite`
/// today; kept as a function so future overrides slot in without site changes.
pub fn resolve_case_index_path(env: &HashMap<String, String>, cwd: &Path) -> PathBuf {
    resolve_data_dir(env, cwd).join(CASE_INDEX_FILENAME)
}

/// Resolve the operator's database path. Honors `DATABASE_URL` (parses
/// the `file:` scheme), else `file:./data/memphis.db`.
pub fn resolve_database_path(env: &HashMap<String, String>, cwd: &Path) -> PathBuf {
    let url = env_get(env, "DATABASE_URL").unwrap_or(DEFAULT_DATABASE_URL);
    let raw = url.strip_prefix("file:").unwrap_or(url);
    make_absolute(expand_home(raw, env), cwd)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env_with(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        pairs
            .iter()
            .map(|(k, v)| ((*k).to_string(), (*v).to_string()))
            .collect()
    }

    #[test]
    fn data_dir_default_expands_home() {
        let env = env_with(&[("HOME", "/home/test")]);
        assert_eq!(
            resolve_data_dir(&env, Path::new("/cwd")),
            PathBuf::from("/home/test/.memphis"),
        );
    }

    #[test]
    fn data_dir_honors_env_override() {
        let env = env_with(&[("HOME", "/home/test"), ("MEMPHIS_DATA_DIR", "/var/memphis")]);
        assert_eq!(
            resolve_data_dir(&env, Path::new("/cwd")),
            PathBuf::from("/var/memphis"),
        );
    }

    #[test]
    fn data_dir_relative_resolves_against_cwd() {
        let env = env_with(&[("HOME", "/home/test"), ("MEMPHIS_DATA_DIR", "./.memphis")]);
        assert_eq!(
            resolve_data_dir(&env, Path::new("/srv/runtime")),
            PathBuf::from("/srv/runtime/./.memphis"),
        );
    }

    #[test]
    fn vault_state_default_under_data_dir() {
        let env = env_with(&[("HOME", "/home/test")]);
        assert_eq!(
            resolve_vault_state_path(&env, Path::new("/cwd")),
            PathBuf::from("/home/test/.memphis/vault-state.json"),
        );
    }

    #[test]
    fn vault_state_explicit_override_wins() {
        let env = env_with(&[
            ("HOME", "/home/test"),
            ("MEMPHIS_VAULT_STATE_PATH", "/secrets/vs.json"),
        ]);
        assert_eq!(
            resolve_vault_state_path(&env, Path::new("/cwd")),
            PathBuf::from("/secrets/vs.json"),
        );
    }

    #[test]
    fn vault_state_override_can_use_tilde() {
        let env = env_with(&[
            ("HOME", "/home/test"),
            ("MEMPHIS_VAULT_STATE_PATH", "~/secrets/vs.json"),
        ]);
        assert_eq!(
            resolve_vault_state_path(&env, Path::new("/cwd")),
            PathBuf::from("/home/test/secrets/vs.json"),
        );
    }

    #[test]
    fn vault_entries_pairs_with_state_under_same_data_dir() {
        let env = env_with(&[("HOME", "/home/test"), ("MEMPHIS_DATA_DIR", "/var/m")]);
        assert_eq!(
            resolve_vault_state_path(&env, Path::new("/cwd")),
            PathBuf::from("/var/m/vault-state.json"),
        );
        assert_eq!(
            resolve_vault_entries_path(&env, Path::new("/cwd")),
            PathBuf::from("/var/m/vault-entries.json"),
        );
    }

    #[test]
    fn split_override_only_moves_targeted_file() {
        // Operator sets only entries — state stays under data_dir. This
        // is the documented escape hatch for vault recovery flows.
        let env = env_with(&[
            ("HOME", "/home/test"),
            ("MEMPHIS_VAULT_ENTRIES_PATH", "/recovery/entries.json"),
        ]);
        assert_eq!(
            resolve_vault_entries_path(&env, Path::new("/cwd")),
            PathBuf::from("/recovery/entries.json"),
        );
        assert_eq!(
            resolve_vault_state_path(&env, Path::new("/cwd")),
            PathBuf::from("/home/test/.memphis/vault-state.json"),
        );
    }

    #[test]
    fn chains_dir_under_data_dir() {
        let env = env_with(&[("HOME", "/home/test")]);
        assert_eq!(
            resolve_chains_dir(&env, Path::new("/cwd")),
            PathBuf::from("/home/test/.memphis/chains"),
        );
    }

    #[test]
    fn chain_path_normalizes_aliases() {
        let env = env_with(&[("HOME", "/home/test")]);
        assert_eq!(
            resolve_chain_path(&env, Path::new("/cwd"), "case"),
            PathBuf::from("/home/test/.memphis/chains/cases"),
        );
        assert_eq!(
            resolve_chain_path(&env, Path::new("/cwd"), "decision"),
            PathBuf::from("/home/test/.memphis/chains/decisions"),
        );
        assert_eq!(
            resolve_chain_path(&env, Path::new("/cwd"), "pattern"),
            PathBuf::from("/home/test/.memphis/chains/patterns"),
        );
        assert_eq!(
            resolve_chain_path(&env, Path::new("/cwd"), "reflection"),
            PathBuf::from("/home/test/.memphis/chains/reflections"),
        );
    }

    #[test]
    fn chain_path_passes_through_unknown_names() {
        let env = env_with(&[("HOME", "/home/test")]);
        assert_eq!(
            resolve_chain_path(&env, Path::new("/cwd"), "journal"),
            PathBuf::from("/home/test/.memphis/chains/journal"),
        );
        assert_eq!(
            resolve_chain_path(&env, Path::new("/cwd"), "audit"),
            PathBuf::from("/home/test/.memphis/chains/audit"),
        );
    }

    #[test]
    fn empty_chain_name_yields_bare_chains_dir() {
        let env = env_with(&[("HOME", "/home/test")]);
        assert_eq!(
            resolve_chain_path(&env, Path::new("/cwd"), ""),
            PathBuf::from("/home/test/.memphis/chains"),
        );
        assert_eq!(
            resolve_chain_path(&env, Path::new("/cwd"), "   "),
            PathBuf::from("/home/test/.memphis/chains"),
        );
    }

    #[test]
    fn embed_index_default_under_data_dir() {
        let env = env_with(&[("HOME", "/home/test")]);
        assert_eq!(
            resolve_embed_index_path(&env, Path::new("/cwd")),
            PathBuf::from("/home/test/.memphis/embed/index-v1.json"),
        );
    }

    #[test]
    fn embed_index_honors_explicit_path() {
        let env = env_with(&[
            ("HOME", "/home/test"),
            ("RUST_EMBED_PERSIST_PATH", "/var/cache/embed.json"),
        ]);
        assert_eq!(
            resolve_embed_index_path(&env, Path::new("/cwd")),
            PathBuf::from("/var/cache/embed.json"),
        );
    }

    #[test]
    fn case_index_default_under_data_dir() {
        let env = env_with(&[("HOME", "/home/test")]);
        assert_eq!(
            resolve_case_index_path(&env, Path::new("/cwd")),
            PathBuf::from("/home/test/.memphis/case-index.sqlite"),
        );
    }

    #[test]
    fn database_path_default_relative() {
        let env = env_with(&[("HOME", "/home/test")]);
        assert_eq!(
            resolve_database_path(&env, Path::new("/srv")),
            PathBuf::from("/srv/./data/memphis.db"),
        );
    }

    #[test]
    fn database_path_honors_url_scheme() {
        let env = env_with(&[
            ("HOME", "/home/test"),
            ("DATABASE_URL", "file:/var/memphis/db.sqlite"),
        ]);
        assert_eq!(
            resolve_database_path(&env, Path::new("/srv")),
            PathBuf::from("/var/memphis/db.sqlite"),
        );
    }

    #[test]
    fn database_path_supports_tilde_in_url() {
        let env = env_with(&[
            ("HOME", "/home/test"),
            ("DATABASE_URL", "file:~/db/memphis.db"),
        ]);
        assert_eq!(
            resolve_database_path(&env, Path::new("/srv")),
            PathBuf::from("/home/test/db/memphis.db"),
        );
    }

    #[test]
    fn empty_string_env_is_treated_as_absent() {
        // Operator runs with `MEMPHIS_DATA_DIR=` (empty) — must NOT
        // resolve to "" (cwd). Behaves identically to unset.
        let env = env_with(&[("HOME", "/home/test"), ("MEMPHIS_DATA_DIR", "")]);
        assert_eq!(
            resolve_data_dir(&env, Path::new("/cwd")),
            PathBuf::from("/home/test/.memphis"),
        );
    }

    #[test]
    fn whitespace_only_env_is_treated_as_absent() {
        let env = env_with(&[("HOME", "/home/test"), ("MEMPHIS_DATA_DIR", "   ")]);
        assert_eq!(
            resolve_data_dir(&env, Path::new("/cwd")),
            PathBuf::from("/home/test/.memphis"),
        );
    }

    #[test]
    fn missing_home_falls_back_to_dot() {
        // We intentionally don't panic on missing HOME — the caller
        // produces a clearer diagnostic from the resulting (relative)
        // path failing to resolve when used.
        let env: HashMap<String, String> = HashMap::new();
        assert_eq!(
            resolve_data_dir(&env, Path::new("/cwd")),
            PathBuf::from("/cwd/./.memphis"),
        );
    }

    #[test]
    fn normalize_chain_name_is_table_complete() {
        assert_eq!(normalize_chain_name("case"), "cases");
        assert_eq!(normalize_chain_name("decision"), "decisions");
        assert_eq!(normalize_chain_name("pattern"), "patterns");
        assert_eq!(normalize_chain_name("reflection"), "reflections");
        // Non-aliased pass through verbatim.
        assert_eq!(normalize_chain_name("cases"), "cases");
        assert_eq!(normalize_chain_name("journal"), "journal");
        assert_eq!(normalize_chain_name("audit"), "audit");
    }
}
