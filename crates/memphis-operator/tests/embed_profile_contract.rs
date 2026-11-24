//! The embed profile contract: the runtime's configuration must agree with
//! the index on disk, and must say WHERE every value came from.
//!
//! WHY THIS GATE EXISTS
//! --------------------
//! `RUST_EMBED_DIM` was written as a hard-coded `32` in four places and the
//! index-path default was written twice with two different roots (HOME-based
//! in TypeScript, data-dir-based in Rust). The `32` was never an embedding
//! dimension — it is `DEFAULT_EMBEDDING_DIM`, the width of the local
//! deterministic embedder, the placeholder used when no provider is
//! configured. The configuration builder applied it unconditionally, so a
//! process with a real provider and no explicit dimension asked a 1024-dim
//! model for 32-dim vectors.
//!
//! MEASURED 2026-11-23 on the operator's host: the service (systemd passes
//! the `.env`) reads `embed/bge-m3-20261106/index-v1.json` with dim 1024 and
//! answers `mode: semantic`; a shell, the CLI and every spawned script read
//! `embed/index-v1.json` with dim 768 and answer
//! `index_dimension_mismatch: disk_dim=768 config_dim=32`.
//!
//! The contract this gate pins:
//!
//! 1. with a provider configured and no explicit dimension, the dimension
//!    FOLLOWS THE INDEX on disk — the vectors a query has to match;
//! 2. an explicit `RUST_EMBED_DIM` wins, and a disagreement with the index
//!    is reported as a MISMATCH with a remedy, not as a number;
//! 3. a process without a provider is told so outright, because that is the
//!    actual cause of the degraded half — not the dimension.
//!
//! The owner is `memphis_embed::profile`. This file is the Rust arm: it
//! checks the runtime's own configuration against the owner's answers, and
//! the owner against the ARTEFACT of cases the TypeScript arm also reads.
//!
//! THE ARTEFACT
//! ------------
//! `tests/fixtures/embed-profile-contract.json` holds the cases; it is
//! written by `scripts/sync-embed-profile-contract.mts`, which asks the
//! owner through the built bridge. Neither arm produces it alone, so
//! neither can change it alone. The TypeScript arm is
//! `tests/unit/embed-profile-contract.test.ts`.
//!
//! The cases name their index by a path RELATIVE to the repository root,
//! so the artefact is the same on every machine; the fixture indexes are
//! committed, so a case never reads the operator's disk.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use memphis_operator::OperatorConfig;
use serde_json::Value;

const FIXTURE: &str = include_str!("../../../tests/fixtures/embed-profile-contract.json");

/// The repository root — the directory the artefact's relative paths resolve
/// against. `cargo test` runs the test binary in the CRATE directory, so the
/// root cannot be the working directory.
fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .canonicalize()
        .expect("the repository root must exist")
}

fn temp_dir(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "memphis-embed-profile-contract-{}-{}",
        std::process::id(),
        name
    ));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn write_index(path: &PathBuf, dim: usize) {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(
        path,
        format!(r#"{{"version":1,"dim":{dim},"docs":[{{"id":"a","text":"x","vector":[0.1]}}]}}"#),
    )
    .unwrap();
}

fn config_from(pairs: &[(&str, &str)]) -> OperatorConfig {
    let vars: Vec<(String, String)> = pairs
        .iter()
        .map(|(key, value)| ((*key).to_string(), (*value).to_string()))
        .collect();
    OperatorConfig::from_iter(vars)
}

#[test]
fn a_provider_without_an_explicit_dimension_follows_the_index_on_disk() {
    let dir = temp_dir("follow");
    let index = dir.join("embed").join("index-v1.json");
    write_index(&index, 768);

    let config = config_from(&[
        ("MEMPHIS_DATA_DIR", dir.to_str().unwrap()),
        ("RUST_EMBED_MODE", "ollama"),
        ("RUST_EMBED_PERSIST_PATH", index.to_str().unwrap()),
    ]);

    // The index holds 768-dim vectors, so a query has to be 768-dim too.
    assert_eq!(
        config.embed_config.dim, 768,
        "the dimension must follow the index on disk, not the local \
         deterministic embedder's placeholder width"
    );
    assert_eq!(config.embed_persist_path, index);

    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn an_explicit_dimension_wins_over_the_index() {
    let dir = temp_dir("explicit");
    let index = dir.join("embed").join("index-v1.json");
    write_index(&index, 768);

    let config = config_from(&[
        ("MEMPHIS_DATA_DIR", dir.to_str().unwrap()),
        ("RUST_EMBED_MODE", "ollama"),
        ("RUST_EMBED_PERSIST_PATH", index.to_str().unwrap()),
        ("RUST_EMBED_DIM", "1024"),
    ]);

    assert_eq!(config.embed_config.dim, 1024);
    assert_eq!(config.embed_config.provider_model, None);

    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn the_index_path_default_is_the_data_dir_one() {
    let dir = temp_dir("path");

    let config = config_from(&[("MEMPHIS_DATA_DIR", dir.to_str().unwrap())]);

    assert_eq!(
        config.embed_persist_path,
        dir.join("embed").join("index-v1.json"),
        "the default index path must be the data-dir one, so the runtime and \
         the TypeScript side read the same file"
    );

    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn the_mode_is_read_from_the_environment_once() {
    let dir = temp_dir("mode");

    let provider = config_from(&[
        ("MEMPHIS_DATA_DIR", dir.to_str().unwrap()),
        ("RUST_EMBED_MODE", "ollama"),
    ]);
    assert!(matches!(
        provider.embed_config.mode,
        memphis_embed::EmbedMode::Provider(_)
    ));

    let local = config_from(&[("MEMPHIS_DATA_DIR", dir.to_str().unwrap())]);
    assert!(matches!(
        local.embed_config.mode,
        memphis_embed::EmbedMode::LocalDeterministic
    ));

    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn the_owner_and_the_runtime_agree_on_the_profile() {
    let dir = temp_dir("agree");
    let index = dir.join("embed").join("index-v1.json");
    write_index(&index, 1024);

    let vars: Vec<(String, String)> = vec![
        ("MEMPHIS_DATA_DIR".to_string(), dir.to_string_lossy().to_string()),
        ("RUST_EMBED_MODE".to_string(), "ollama".to_string()),
        ("RUST_EMBED_PERSIST_PATH".to_string(), index.to_string_lossy().to_string()),
        ("RUST_EMBED_DIM".to_string(), "1024".to_string()),
    ];
    let env_map: HashMap<String, String> = vars.iter().cloned().collect();

    let config = OperatorConfig::from_iter(vars);
    let profile = memphis_embed::resolve_embed_profile(
        &env_map,
        &std::path::Path::new(&dir),
        &config.embed_config.mode,
    );

    assert_eq!(profile.dimension, config.embed_config.dim);
    assert_eq!(profile.index_path, config.embed_persist_path.to_string_lossy());
    assert_eq!(profile.dimension_source, "env");

    std::fs::remove_dir_all(dir).unwrap();
}

/// The owner's answer, in the root-relative form the artefact records.
fn relativize(root: &Path, absolute: &str) -> String {
    match Path::new(absolute).strip_prefix(root) {
        Ok(relative) => relative.to_string_lossy().to_string(),
        Err(_) => absolute.to_string(),
    }
}

#[test]
fn the_owner_answers_every_case_the_way_the_artefact_says() {
    let fixture: Value =
        serde_json::from_str(FIXTURE).expect("the contract fixture must be valid JSON");
    let cases = fixture["cases"]
        .as_array()
        .expect("the contract fixture must hold a cases array");
    assert!(!cases.is_empty(), "the contract fixture must not be empty");

    let root = repo_root();
    let mut failures: Vec<String> = Vec::new();

    for case in cases {
        let name = case["name"].as_str().expect("every case must carry a name");
        let env_value = case["env"].as_object().expect("every case must carry an env");
        let env_map: HashMap<String, String> = env_value
            .iter()
            .map(|(key, value)| {
                (
                    key.clone(),
                    value.as_str().unwrap_or_default().to_string(),
                )
            })
            .collect();

        let mode = memphis_embed::embed_mode_from_env(&env_map);
        let profile = memphis_embed::resolve_embed_profile(&env_map, &root, &mode);

        let expected_path = case["indexPath"].as_str().expect("every case must carry a path");
        let actual_path = relativize(&root, &profile.index_path);
        if actual_path != expected_path {
            failures.push(format!(
                "{name}: the index is {actual_path:?}, the contract says {expected_path:?}"
            ));
        }

        let expected_dimension = case["dimension"].as_u64().expect("every case must carry a dim");
        if profile.dimension as u64 != expected_dimension {
            failures.push(format!(
                "{name}: the dimension is {}, the contract says {expected_dimension}",
                profile.dimension
            ));
        }

        let expected_source = case["dimensionSource"]
            .as_str()
            .expect("every case must carry a dimension source");
        if profile.dimension_source != expected_source {
            failures.push(format!(
                "{name}: the dimension came from {:?}, the contract says {expected_source:?}",
                profile.dimension_source
            ));
        }

        let expected_verdict = case["verdict"].as_str().expect("every case must carry a verdict");
        if profile.verdict != expected_verdict {
            failures.push(format!(
                "{name}: the verdict is {:?}, the contract says {expected_verdict:?}",
                profile.verdict
            ));
        }

        let expected_mode = case["mode"].as_str().expect("every case must carry a mode");
        if profile.mode != expected_mode {
            failures.push(format!(
                "{name}: the mode is {:?}, the contract says {expected_mode:?}",
                profile.mode
            ));
        }

        let expected_mismatch = case["dimensionMismatch"]
            .as_bool()
            .expect("every case must carry the mismatch flag");
        if profile.dimension_mismatch != expected_mismatch {
            failures.push(format!(
                "{name}: the mismatch flag is {}, the contract says {expected_mismatch}",
                profile.dimension_mismatch
            ));
        }

        let expected_provider = case["providerConfigured"]
            .as_bool()
            .expect("every case must carry the provider flag");
        if profile.provider_configured != expected_provider {
            failures.push(format!(
                "{name}: the provider flag is {}, the contract says {expected_provider}",
                profile.provider_configured
            ));
        }
    }

    assert!(
        failures.is_empty(),
        "the owner disagrees with the contract:\n{}",
        failures.join("\n")
    );
}

#[test]
fn the_manifest_the_contract_records_is_the_one_the_owner_publishes() {
    let fixture: Value =
        serde_json::from_str(FIXTURE).expect("the contract fixture must be valid JSON");
    let manifest = fixture["manifest"].as_object().expect("the contract must record a manifest");

    let published = memphis_embed::embed_profile_manifest();
    let published_json = serde_json::to_value(&published).expect("the manifest must serialize");

    assert_eq!(
        published_json["env"], manifest["env"],
        "the environment names the contract records must be the ones the owner reads"
    );
    assert_eq!(
        published_json["defaults"]["localDimension"], manifest["defaults"]["localDimension"],
        "the local width must be the owner's"
    );
    assert_eq!(
        published_json["dimensionSources"], manifest["dimensionSources"],
        "the dimension sources must be the owner's"
    );
    assert_eq!(
        published_json["verdicts"], manifest["verdicts"],
        "the verdicts must be the owner's"
    );
    assert_eq!(
        published_json["modes"], manifest["modes"],
        "the mode vocabulary must be the owner's"
    );
}
