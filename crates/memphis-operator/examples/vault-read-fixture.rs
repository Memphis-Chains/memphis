//! Isolated integration-test reader. Never prints credential values.
use memphis_operator::OperatorRuntime;

fn main() {
    if let Some(path) = std::env::args().nth(1) {
        std::fs::write(path, "ready").expect("fixture ready signal");
    }
    match OperatorRuntime::from_env().read_vault_secret("first") {
        Ok(secret) if secret.plaintext == "synthetic-first-credential" => {
            println!("NATIVE_VAULT_OK");
        }
        Ok(_) => std::process::exit(2),
        Err(error) => {
            eprintln!("{error}");
            std::process::exit(3);
        }
    }
}
