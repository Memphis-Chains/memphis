//! Isolated integration-test reader. Never prints credential values.
use memphis_operator::OperatorRuntime;

fn main() {
    if let Some(path) = std::env::args().nth(1) {
        std::fs::write(path, "ready").expect("fixture ready signal");
    }
    let key = std::env::var("MEMPHIS_FIXTURE_VAULT_KEY").unwrap_or_else(|_| "first".into());
    let expected = std::env::var("MEMPHIS_FIXTURE_VAULT_EXPECTED")
        .unwrap_or_else(|_| "synthetic-first-credential".into());
    match OperatorRuntime::from_env().read_vault_secret(&key) {
        Ok(secret) if secret.plaintext == expected => {
            println!("NATIVE_VAULT_OK");
        }
        Ok(_) => std::process::exit(2),
        Err(error) => {
            eprintln!("{error}");
            std::process::exit(3);
        }
    }
}
