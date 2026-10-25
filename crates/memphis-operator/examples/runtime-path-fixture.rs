//! Isolated launch-path acceptance fixture; emits metadata and a read verdict only.
use memphis_operator::OperatorRuntime;
use std::path::PathBuf;

fn main() {
    assert_eq!(std::env::var("NODE_ENV").as_deref(), Ok("test"));
    let root = PathBuf::from(std::env::var("MEMPHIS_RUNTIME_ROOT").unwrap())
        .canonicalize()
        .unwrap();
    assert!(root.starts_with(std::env::temp_dir().canonicalize().unwrap()));
    assert!(root
        .file_name()
        .unwrap()
        .to_string_lossy()
        .starts_with("memphis-vitest-"));
    let runtime = OperatorRuntime::from_env();
    let config = runtime.config();
    for path in [
        &config.runtime_root,
        &config.data_dir,
        &config.vault_state_path,
        &config.vault_entries_path,
        config.env_file_path.as_ref().unwrap(),
    ] {
        assert!(path.canonicalize().unwrap().starts_with(&root));
    }
    let expected = std::env::var("MEMPHIS_FIXTURE_EXPECTED").unwrap();
    let readable = runtime
        .read_vault_secret("first")
        .is_ok_and(|secret| secret.plaintext == expected);
    assert!(
        readable,
        "isolated native credential fixture was not readable"
    );
    println!(
        "{}",
        serde_json::json!({
            "runtimeRoot": config.runtime_root,
            "runtimeRootSource": config.runtime_root_source,
            "dotenv": config.env_file_path,
            "dataDir": config.data_dir,
            "vaultState": config.vault_state_path,
            "vaultEntries": config.vault_entries_path,
            "generation": config.config_generation,
            "readable": readable,
        })
    );
}
