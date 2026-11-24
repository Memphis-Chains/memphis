//! The embed PROFILE: one resolver for the index path, the embedding
//! dimension and the model, with the SOURCE of every value attached.
//!
//! WHY THIS EXISTS
//! ---------------
//! "Which embedding profile is in force?" had four answers on this host, and
//! the answers contradicted each other:
//!
//!   1. `crates/memphis-operator/src/config.rs` — the dimension default was
//!      `32`, hard-coded;
//!   2. `crates/memphis-napi/src/lib.rs` — the same `32`, hard-coded again,
//!      and the same mode vocabulary copied a second time;
//!   3. `src/infra/http/health.ts` — the dimension default was `32` again,
//!      and the index-path default was `~/.memphis/embed/index-v1.json`
//!      (HOME-based) while the Rust side used `<data_dir>/embed/index-v1.json`
//!      (data-dir-based) — two different files whenever `MEMPHIS_DATA_DIR`
//!      is not `~/.memphis`;
//!   4. `src/infra/tensors/status.ts` — `32` a fourth time, and the
//!      HOME-based path a third time.
//!
//! MEASURED 2026-11-23 on the operator's host:
//!
//! | process | index it reads | dim | result |
//! | --- | --- | --- | --- |
//! | the service (systemd passes `.env`) | `embed/bge-m3-20261106/index-v1.json` | 1024 | `mode: semantic` |
//! | a shell, the CLI, a spawned script | `embed/index-v1.json` (stale) | 768 on disk vs **32** configured | `index_dimension_mismatch` |
//!
//! The `32` was never an embedding dimension. It is
//! `DEFAULT_EMBEDDING_DIM` — the width of the LOCAL DETERMINISTIC embedder,
//! the placeholder used when no provider is configured. The configuration
//! builder applied it unconditionally, so a process with a real provider and
//! no explicit `RUST_EMBED_DIM` asked for 32-dim vectors from a model that
//! produces 1024.
//!
//! THE RULE
//! --------
//! One function answers, for a given environment and a given mode:
//!
//! * **path** — `RUST_EMBED_PERSIST_PATH`, else `<data_dir>/embed/index-v1.json`;
//! * **dimension** — `RUST_EMBED_DIM`; else the dimension recorded IN THE INDEX
//!   at that path; else `DEFAULT_EMBEDDING_DIM` (only reached when there is no
//!   index to contradict, so nothing can mismatch);
//! * **model** — `RUST_EMBED_PROVIDER_MODEL`, else unknown;
//! * **verdict** — what the combination means, in the words the operator
//!   needs: `ok`, `no-provider`, `no-index` or `dimension-mismatch`.
//!
//! The dimension default follows the index on disk because the index is what
//! the queries have to match. A wrong width costs two different ways, and
//! they are NOT the same failure:
//!
//! * With a PROVIDER configured, the provider's own width is the truth.
//!   `crates/memphis-embed/src/pipeline.rs` validates the returned array
//!   strictly (`parse_embedding_vector`, since PR #749), so a 1024-wide
//!   answer to a 32-wide configuration is a LOUD error — "ollama returned
//!   embedding dimension 1024, expected 32" — and every embed fails.
//! * With the LOCAL deterministic embedder, the vector is always exactly
//!   `dim` wide, so nothing fails at all: a 32-wide query is compared
//!   against a 768-wide stored vector, and `cosine_similarity` returns 0.0
//!   for vectors of unequal length. That is the SILENT half — recall
//!   returns hits, and none of them mean anything.
//!
//! (An earlier version of this file claimed the provider's vector was
//! "truncated without warning". That was true on 2026-10-25 and stopped
//! being true on 2026-11-06, when the provider path became strict. The
//! comment in `src/infra/http/health.ts` still carried the old claim until
//! this contract replaced it.)
//!
//! Every value carries its source (`env`, `index`, `local-deterministic`,
//! `unknown`) so the surfaces can say WHERE they disagree instead of only
//! that they do. The operator's problem is not the mismatch; it is that the
//! mismatch was reported without a cause.
//!
//! This module is the OWNER. The TypeScript side reads the rule through the
//! bridge (`bridge_embed_profile_manifest`) and the live values through
//! `bridge_embed_profile_facts`; the projection writes the rule into
//! `src/infra/storage/embed-profile.generated.ts`.

use std::collections::HashMap;
use std::fs::File;
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::pipeline::{EmbedMode, DEFAULT_EMBEDDING_DIM};

/// The environment variable that points at the persisted index.
pub const ENV_INDEX_PATH: &str = "RUST_EMBED_PERSIST_PATH";
/// The environment variable that pins the embedding dimension.
pub const ENV_DIMENSION: &str = "RUST_EMBED_DIM";
/// The environment variable that names the embedding model.
pub const ENV_MODEL: &str = "RUST_EMBED_PROVIDER_MODEL";
/// The environment variable that selects the embedding mode.
pub const ENV_MODE: &str = "RUST_EMBED_MODE";

/// The mode word that means "no provider".
pub const LOCAL_MODE: &str = "local";

/// The provider names `RUST_EMBED_MODE` accepts, and the owner resolves to.
///
/// ONE LIST. The vocabulary used to live in two places in Rust
/// (`crates/memphis-operator/src/config.rs` and `crates/memphis-napi/src/lib.rs`)
/// with the same words and the same order, and a third and fourth and fifth
/// reader on the TypeScript side. Two Rust copies of one vocabulary is one
/// copy too many: the moment a name is added to one, the other answers
/// "local deterministic" and the profile's verdict flips to `no-provider`.
pub const PROVIDER_MODE_NAMES: &[&str] = &[
    "openai-compatible",
    "ollama",
    "cohere",
    "voyage",
    "jina",
    "mistral",
    "together",
    "nvidia",
    "mixedbread",
];

/// The mode word that means "the OpenAI-compatible provider".
///
/// A word, not a provider: `RUST_EMBED_MODE=provider` is how the mode was
/// spelled before the provider's name was known.
pub const PROVIDER_ALIAS: &str = "provider";

/// The dimension came from the environment.
pub const SOURCE_ENV: &str = "env";
/// The dimension came from the index on disk.
pub const SOURCE_INDEX: &str = "index";
/// The dimension is the local deterministic embedder's own width.
pub const SOURCE_LOCAL: &str = "local-deterministic";
/// Nothing declared a model.
pub const SOURCE_UNKNOWN: &str = "unknown";

/// Provider configured, dimension matches the index.
pub const VERDICT_OK: &str = "ok";
/// No embedding provider is configured for this process.
pub const VERDICT_NO_PROVIDER: &str = "no-provider";
/// A provider is configured and no index exists yet.
pub const VERDICT_NO_INDEX: &str = "no-index";
/// A provider is configured and the dimensions disagree.
pub const VERDICT_DIMENSION_MISMATCH: &str = "dimension-mismatch";

/// The resolved profile, with the source of every value.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EmbedProfile {
    /// The schema version of this projection.
    pub schema_version: u8,
    /// The index the runtime reads and writes.
    pub index_path: String,
    /// The dimension recorded in the index on disk, if the index is readable.
    pub index_dimension: Option<usize>,
    /// The dimension the operator configured explicitly.
    pub configured_dimension: Option<usize>,
    /// The dimension the embedder must produce.
    pub dimension: usize,
    /// Where `dimension` came from: `env`, `index` or `local-deterministic`.
    pub dimension_source: String,
    /// The embedding model, if one is configured.
    pub model: Option<String>,
    /// Where `model` came from: `env` or `unknown`.
    pub model_source: String,
    /// Whether a provider is configured for this process.
    pub provider_configured: bool,
    /// Whether the configured dimension disagrees with the index on disk.
    ///
    /// A FACT, separate from the verdict: the verdict names the PRIMARY
    /// cause (a process without a provider is told that first), but the
    /// dimension disagreement is a second, independent problem — and a
    /// surface that only reads the verdict would lose it.
    pub dimension_mismatch: bool,
    /// The mode in force: `local`, a provider name, or `cascade[...]`.
    pub mode: String,
    /// `ok`, `no-provider`, `no-index` or `dimension-mismatch`.
    pub verdict: String,
    /// What to do about the verdict, in one sentence.
    pub remedy: Option<String>,
    /// What to do about the dimension disagreement, in one sentence.
    ///
    /// A SECOND remedy, because the verdict names the PRIMARY cause: a
    /// process without a provider is told that first, and a surface that
    /// only read the verdict's remedy would lose the dimension fix.
    pub dimension_remedy: Option<String>,
}

/// The static rule, for the TypeScript projection.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EmbedProfileManifest {
    /// The schema version of this projection.
    pub schema_version: u8,
    /// The environment variables the profile reads.
    pub env: EmbedProfileEnv,
    /// The defaults, and where each one comes from.
    pub defaults: EmbedProfileDefaults,
    /// The dimension sources, in precedence order.
    pub dimension_sources: Vec<String>,
    /// The verdicts the profile can report.
    pub verdicts: Vec<String>,
    /// The mode vocabulary.
    pub modes: EmbedProfileModes,
}

/// The environment variables the profile reads.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EmbedProfileEnv {
    /// The variable that points at the persisted index.
    pub index_path: String,
    /// The variable that pins the embedding dimension.
    pub dimension: String,
    /// The variable that names the embedding model.
    pub model: String,
    /// The variable that selects the embedding mode.
    pub mode: String,
}

/// The defaults, and where each one comes from.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EmbedProfileDefaults {
    /// The index path when the environment does not name one.
    pub index_path: String,
    /// The dimension when the environment does not name one.
    pub dimension: String,
    /// The model when the environment does not name one.
    pub model: String,
    /// The width of the local deterministic embedder.
    ///
    /// This is NOT an embedding dimension of the operator's provider — it is
    /// the width of the placeholder embedder, used only when no index exists
    /// to contradict it. The TypeScript side used to hard-code the same
    /// number in five places, which is why a process without
    /// `RUST_EMBED_DIM` asked a 1024-dim provider for 32-dim vectors.
    pub local_dimension: usize,
}

/// The mode vocabulary, for the TypeScript projection.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EmbedProfileModes {
    /// The mode word that means "no provider".
    pub local: String,
    /// The mode word that means "the OpenAI-compatible provider".
    pub alias: String,
    /// The provider names the mode accepts.
    pub providers: Vec<String>,
}

/// Read the dimension recorded in the index at `path`.
///
/// CHEAP BY DESIGN. The bge-m3 index on the operator's host is 165 MB with
/// 12 943 documents, so the full inspection (`crate::metadata::inspect_index`)
/// is the wrong cost for a configuration question — the dimension lives in
/// the header of both formats:
///
/// * v2 (`*.ndjson` sibling) — the first line, `{"version":2,"dim":N}`;
/// * v1 (a single JSON object) — the head, `{"version":1,"dim":N,"docs":[…}`.
///
/// The v1 head is matched ANCHORED at the start of the file, so a document
/// whose text contains `"dim":` cannot be mistaken for the header.
pub fn index_dimension(path: &Path) -> Option<usize> {
    let sibling = path.with_extension("ndjson");
    if sibling.exists() {
        return ndjson_header_dimension(&sibling);
    }
    v1_header_dimension(path)
}

/// The dimension from the first line of a v2 (ndjson) index.
fn ndjson_header_dimension(path: &Path) -> Option<usize> {
    let file = File::open(path).ok()?;
    let mut line = String::new();
    BufReader::new(file).read_line(&mut line).ok()?;
    // `{"version":2,"dim":768}` — parse the header as a small object.
    let value: serde_json::Value = serde_json::from_str(line.trim()).ok()?;
    dimension_from_value(&value)
}

/// The dimension from the head of a v1 (single JSON object) index.
fn v1_header_dimension(path: &Path) -> Option<usize> {
    let mut file = File::open(path).ok()?;
    let mut head = vec![0u8; 4096];
    let count = file.read(&mut head).ok()?;
    let text = String::from_utf8_lossy(&head[..count]);
    // Anchored: the header is the FIRST thing in the file, so nothing inside
    // a document's text can match it.
    let rest = text.trim_start();
    let rest = rest.strip_prefix('{')?;
    let after_version = rest.trim_start().strip_prefix("\"version\"")?;
    let after_version = after_version.trim_start().strip_prefix(':')?;
    let after_version = after_version.trim_start();
    let after_version = after_version.strip_prefix("1")?;
    let after_version = after_version.trim_start().strip_prefix(',')?;
    let after_dim = after_version.trim_start().strip_prefix("\"dim\"")?;
    let after_dim = after_dim.trim_start().strip_prefix(':')?.trim_start();
    let digits: String = after_dim.chars().take_while(|c| c.is_ascii_digit()).collect();
    if digits.is_empty() {
        return None;
    }
    let dim: usize = digits.parse().ok()?;
    if dim == 0 {
        return None;
    }
    Some(dim)
}

/// The dimension from a parsed header object.
fn dimension_from_value(value: &serde_json::Value) -> Option<usize> {
    let dim = value.get("dim")?.as_u64()?;
    if dim == 0 {
        return None;
    }
    Some(dim as usize)
}

/// Whether `mode` names a real embedding provider.
fn provider_configured(mode: &EmbedMode) -> bool {
    match mode {
        EmbedMode::LocalDeterministic => false,
        EmbedMode::Provider(_) => true,
        // A cascade ends in the local deterministic embedder, so semantic
        // recall depends on the chain reaching a provider.
        EmbedMode::Cascade(modes) => modes.iter().any(provider_configured),
    }
}

/// The mode of a profile, as a stable lowercase name.
pub fn mode_name(mode: &EmbedMode) -> String {
    match mode {
        EmbedMode::LocalDeterministic => "local".to_string(),
        EmbedMode::Provider(name) => name.clone(),
        EmbedMode::Cascade(modes) => {
            let names: Vec<String> = modes.iter().map(mode_name).collect();
            format!("cascade[{}]", names.join(","))
        }
    }
}

/// The mode named by `RUST_EMBED_MODE`.
///
/// ONE COPY. The vocabulary used to live in two places in Rust
/// (`crates/memphis-operator/src/config.rs` and `crates/memphis-napi/src/lib.rs`)
/// with the same words and the same order, and a third and fourth and fifth
/// reader on the TypeScript side. Two Rust copies of one vocabulary is one
/// copy too many: the moment a name is added to one, the other answers
/// "local deterministic" and the profile's verdict flips to `no-provider`.
pub fn embed_mode_from_env(env: &HashMap<String, String>) -> EmbedMode {
    let mode = env
        .get(ENV_MODE)
        .map(|raw| raw.trim().to_ascii_lowercase())
        .unwrap_or_else(|| LOCAL_MODE.to_string());

    if mode == LOCAL_MODE {
        return EmbedMode::LocalDeterministic;
    }
    if mode == PROVIDER_ALIAS {
        return EmbedMode::Provider("openai-compatible".to_string());
    }
    match PROVIDER_MODE_NAMES.iter().find(|name| **name == mode) {
        Some(name) => EmbedMode::Provider((*name).to_string()),
        None => EmbedMode::LocalDeterministic,
    }
}

/// Resolve the embed profile for `env`, reading the index at `root`.
///
/// `root` is the directory relative paths are resolved against: the operator
/// passes its runtime root, the bridge passes the working directory.
pub fn resolve_embed_profile(
    env: &HashMap<String, String>,
    root: &Path,
    mode: &EmbedMode,
) -> EmbedProfile {
    let index_path = memphis_paths::resolve_embed_index_path(env, root);
    let index_dimension = index_dimension(&index_path);
    let configured_dimension = env
        .get(ENV_DIMENSION)
        .map(|raw| raw.trim())
        .and_then(|raw| raw.parse::<usize>().ok())
        .filter(|dim| *dim > 0);
    let model = env
        .get(ENV_MODEL)
        .map(|raw| raw.trim().to_string())
        .filter(|raw| !raw.is_empty());

    // The dimension the embedder must produce. `env` wins; then the index on
    // disk (the vectors the query has to match); then the local
    // deterministic embedder's own width — which is only reached when there
    // is no index, so nothing can contradict it.
    let (dimension, dimension_source) = match (configured_dimension, index_dimension) {
        (Some(dim), _) => (dim, SOURCE_ENV.to_string()),
        (None, Some(dim)) => (dim, SOURCE_INDEX.to_string()),
        (None, None) => (DEFAULT_EMBEDDING_DIM, SOURCE_LOCAL.to_string()),
    };

    let provider = provider_configured(mode);
    let dimension_mismatch = matches!(
        (configured_dimension, index_dimension),
        (Some(configured), Some(on_disk)) if configured != on_disk
    );
    let (verdict, remedy) = verdict_for(
        provider,
        dimension_mismatch,
        configured_dimension,
        index_dimension,
        &index_path,
    );

    EmbedProfile {
        schema_version: 1,
        index_path: index_path.display().to_string(),
        index_dimension,
        configured_dimension,
        dimension,
        dimension_source,
        model,
        model_source: if env.get(ENV_MODEL).map(|raw| raw.trim()).unwrap_or("").is_empty() {
            SOURCE_UNKNOWN.to_string()
        } else {
            SOURCE_ENV.to_string()
        },
        provider_configured: provider,
        dimension_mismatch,
        mode: mode_name(mode),
        verdict,
        remedy,
        dimension_remedy: dimension_remedy_for(
            dimension_mismatch,
            configured_dimension,
            index_dimension,
            &index_path,
        ),
    }
}

/// The remedy for the dimension disagreement, and nothing else.
fn dimension_remedy_for(
    dimension_mismatch: bool,
    configured_dimension: Option<usize>,
    index_dimension: Option<usize>,
    index_path: &Path,
) -> Option<String> {
    if !dimension_mismatch {
        return None;
    }
    let configured = configured_dimension?;
    let on_disk = index_dimension?;
    Some(format!(
        "RUST_EMBED_DIM={configured} but {} holds dim={on_disk}. The provider's \
         vector is REJECTED because its width does not match the configured one \
         (the provider path is strict), and the local embedder's vectors score 0 \
         against the stored ones. Set RUST_EMBED_DIM={on_disk} to match the \
         existing index, or rebuild it with `memphis embed reindex`.",
        index_path.display()
    ))
}

/// The verdict, and what to do about it.
fn verdict_for(
    provider: bool,
    dimension_mismatch: bool,
    configured_dimension: Option<usize>,
    index_dimension: Option<usize>,
    index_path: &Path,
) -> (String, Option<String>) {
    if !provider {
        // The missing provider is the PRIMARY cause — without one there is
        // no semantic recall at all, whatever the width says. But the
        // dimension disagreement is a second, independent problem, so it is
        // named in the remedy instead of being swallowed by the verdict.
        let mut remedy = String::from(
            "No embedding provider is configured for this process, so the \
             semantic half of recall is unavailable: the vectors would come \
             from the local deterministic embedder, which is a placeholder. \
             Set RUST_EMBED_MODE (and the provider's URL and model) in the \
             environment of the process that runs the query — a shell does \
             not read the service's .env.",
        );
        if let (Some(configured), Some(on_disk)) = (configured_dimension, index_dimension) {
            if configured != on_disk {
                remedy.push_str(&format!(
                    " RUST_EMBED_DIM={configured} also disagrees with the index at \
                     {} (dim={on_disk}); fix that as well.",
                    index_path.display()
                ));
            }
        }
        return (VERDICT_NO_PROVIDER.to_string(), Some(remedy));
    }
    match (configured_dimension, index_dimension, dimension_mismatch) {
        (Some(_), Some(_), true) => (
            VERDICT_DIMENSION_MISMATCH.to_string(),
            dimension_remedy_for(true, configured_dimension, index_dimension, index_path),
        ),
        (Some(_), None, _) => (
            VERDICT_NO_INDEX.to_string(),
            Some(format!(
                "No index at {} yet — it will be built on the first write.",
                index_path.display()
            )),
        ),
        (Some(configured), Some(on_disk), false) => (
            VERDICT_OK.to_string(),
            Some(format!(
                "RUST_EMBED_DIM={configured} matches the index at {} (dim={on_disk}).",
                index_path.display()
            )),
        ),
        (None, Some(_), _) => (
            VERDICT_OK.to_string(),
            Some(
                "RUST_EMBED_DIM is not set, so the dimension follows the index on \
                 disk. Set it explicitly to pin the profile."
                    .to_string(),
            ),
        ),
        (None, None, _) => (
            VERDICT_NO_INDEX.to_string(),
            Some(format!(
                "No index at {} yet — it will be built on the first write. \
                 RUST_EMBED_DIM is not set either, so the dimension falls back \
                 to the local deterministic width ({DEFAULT_EMBEDDING_DIM}); a \
                 provider that answers with a different width is rejected, so \
                 set RUST_EMBED_DIM to the provider's width before the first \
                 write.",
                index_path.display()
            )),
        ),
    }
}

/// The static rule, for the TypeScript projection.
pub fn embed_profile_manifest() -> EmbedProfileManifest {
    EmbedProfileManifest {
        schema_version: 1,
        env: EmbedProfileEnv {
            index_path: ENV_INDEX_PATH.to_string(),
            dimension: ENV_DIMENSION.to_string(),
            model: ENV_MODEL.to_string(),
            mode: ENV_MODE.to_string(),
        },
        defaults: EmbedProfileDefaults {
            index_path: "<data_dir>/embed/index-v1.json".to_string(),
            dimension: "the dimension recorded in the index on disk; \
                         DEFAULT_EMBEDDING_DIM when no index exists"
                .to_string(),
            model: "unknown — a model cannot be derived from an index, so it \
                    must be configured"
                .to_string(),
            local_dimension: DEFAULT_EMBEDDING_DIM,
        },
        dimension_sources: vec![
            SOURCE_ENV.to_string(),
            SOURCE_INDEX.to_string(),
            SOURCE_LOCAL.to_string(),
        ],
        verdicts: vec![
            VERDICT_OK.to_string(),
            VERDICT_NO_PROVIDER.to_string(),
            VERDICT_NO_INDEX.to_string(),
            VERDICT_DIMENSION_MISMATCH.to_string(),
        ],
        modes: EmbedProfileModes {
            local: LOCAL_MODE.to_string(),
            alias: PROVIDER_ALIAS.to_string(),
            providers: PROVIDER_MODE_NAMES
                .iter()
                .map(|name| (*name).to_string())
                .collect(),
        },
    }
}

/// The index path the profile resolves to, for a caller that only needs that.
pub fn resolve_profile_index_path(env: &HashMap<String, String>, root: &Path) -> PathBuf {
    memphis_paths::resolve_embed_index_path(env, root)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn env_with(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        pairs
            .iter()
            .map(|(key, value)| ((*key).to_string(), (*value).to_string()))
            .collect()
    }

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "memphis-embed-profile-{}-{}-{:?}",
            std::process::id(),
            name,
            std::thread::current().id()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write_v1_index(path: &Path, dim: usize) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(
            path,
            format!(r#"{{"version":1,"dim":{dim},"docs":[{{"id":"a","text":"x","vector":[0.1]}}]}}"#),
        )
        .unwrap();
    }

    #[test]
    fn reads_the_dimension_from_a_v1_header_without_parsing_the_file() {
        let dir = temp_dir("v1");
        let path = dir.join("index-v1.json");
        write_v1_index(&path, 768);
        assert_eq!(index_dimension(&path), Some(768));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn reads_the_dimension_from_the_v2_ndjson_sibling() {
        let dir = temp_dir("v2");
        let path = dir.join("index-v1.json");
        write_v1_index(&path, 768);
        std::fs::write(
            path.with_extension("ndjson"),
            "{\"version\":2,\"dim\":1024}\n{\"id\":\"a\",\"text\":\"x\",\"vector\":[0.1]}\n",
        )
        .unwrap();
        assert_eq!(index_dimension(&path), Some(1024));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_document_whose_text_mentions_dim_cannot_fake_the_header() {
        let dir = temp_dir("decoy");
        let path = dir.join("index-v1.json");
        std::fs::write(
            &path,
            r#"{"version":1,"dim":96,"docs":[{"id":"a","text":"\"dim\":1,\"dim\":2","vector":[0.1]}]}"#,
        )
        .unwrap();
        assert_eq!(index_dimension(&path), Some(96));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn the_dimension_follows_the_index_when_the_environment_is_silent() {
        let dir = temp_dir("follow");
        let index = dir.join("embed").join("index-v1.json");
        write_v1_index(&index, 768);
        let env = env_with(&[("MEMPHIS_DATA_DIR", dir.to_str().unwrap())]);

        let profile = resolve_embed_profile(&env, &dir, &EmbedMode::Provider("ollama".into()));

        assert_eq!(profile.dimension, 768);
        assert_eq!(profile.dimension_source, SOURCE_INDEX);
        assert_eq!(profile.index_dimension, Some(768));
        assert_eq!(profile.configured_dimension, None);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn an_explicit_dimension_wins_and_a_mismatch_is_reported() {
        let dir = temp_dir("mismatch");
        let index = dir.join("embed").join("index-v1.json");
        write_v1_index(&index, 768);
        let env = env_with(&[
            ("MEMPHIS_DATA_DIR", dir.to_str().unwrap()),
            (ENV_DIMENSION, "32"),
        ]);

        let profile = resolve_embed_profile(&env, &dir, &EmbedMode::Provider("ollama".into()));

        assert_eq!(profile.dimension, 32);
        assert_eq!(profile.dimension_source, SOURCE_ENV);
        assert_eq!(profile.verdict, VERDICT_DIMENSION_MISMATCH);
        assert!(profile.remedy.unwrap().contains("768"));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn without_a_provider_the_verdict_says_so_outright() {
        let dir = temp_dir("noprovider");
        let env = env_with(&[("MEMPHIS_DATA_DIR", dir.to_str().unwrap())]);

        let profile = resolve_embed_profile(&env, &dir, &EmbedMode::LocalDeterministic);

        assert!(!profile.provider_configured);
        assert_eq!(profile.verdict, VERDICT_NO_PROVIDER);
        assert_eq!(profile.dimension_source, SOURCE_LOCAL);
        assert_eq!(profile.model_source, SOURCE_UNKNOWN);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn the_manifest_names_every_source_and_verdict() {
        let manifest = embed_profile_manifest();
        assert_eq!(manifest.env.dimension, ENV_DIMENSION);
        assert_eq!(manifest.dimension_sources.len(), 3);
        assert!(manifest.verdicts.contains(&VERDICT_NO_PROVIDER.to_string()));
        assert!(manifest.verdicts.contains(&VERDICT_DIMENSION_MISMATCH.to_string()));
    }
}
