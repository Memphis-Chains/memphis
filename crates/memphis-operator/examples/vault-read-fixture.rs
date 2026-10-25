//! Isolated integration-test reader. Never prints credential values.
use memphis_operator::OperatorRuntime;

fn main() {
    if let Some(path) = std::env::args().nth(1) {
        std::fs::write(path, "ready").expect("fixture ready signal");
    }
    let key = std::env::var("MEMPHIS_FIXTURE_VAULT_KEY").unwrap_or_else(|_| "first".into());
    let expected = std::env::var("MEMPHIS_FIXTURE_VAULT_EXPECTED")
        .unwrap_or_else(|_| "synthetic-first-credential".into());
    let runtime = OperatorRuntime::from_env();
    match runtime.read_vault_secret(&key) {
        Ok(secret) if secret.plaintext == expected => {
            if let Ok(ready) = std::env::var("MEMPHIS_FIXTURE_CACHE_READY") {
                let release = std::env::var("MEMPHIS_FIXTURE_CACHE_RELEASE").unwrap();
                let root = std::path::PathBuf::from(std::env::var("MEMPHIS_RUNTIME_ROOT").unwrap());
                assert_eq!(std::env::var("NODE_ENV").as_deref(), Ok("test"));
                assert!(root
                    .file_name()
                    .unwrap()
                    .to_string_lossy()
                    .starts_with("memphis-vitest-"));
                assert!(std::path::Path::new(&ready).starts_with(&root));
                assert!(std::path::Path::new(&release).starts_with(&root));
                std::fs::write(ready, "cache-warm").unwrap();
                let deadline = std::time::Instant::now() + std::time::Duration::from_secs(60);
                while !std::path::Path::new(&release).exists() {
                    assert!(
                        std::time::Instant::now() < deadline,
                        "fixture release deadline"
                    );
                    std::thread::sleep(std::time::Duration::from_millis(20));
                }
                let result = runtime.read_vault_secret(&key);
                match std::env::var("MEMPHIS_FIXTURE_CACHE_EXPECT_ERROR") {
                    Ok(code) => assert!(result
                        .err()
                        .is_some_and(|error| error.to_string().contains(&code))),
                    Err(_) => assert!(result.is_ok_and(|value| value.plaintext == expected)),
                }
            }
            println!("NATIVE_VAULT_OK");
        }
        Ok(_) => std::process::exit(2),
        Err(error) => {
            eprintln!("{error}");
            std::process::exit(3);
        }
    }
}
