use memphis_operator::{MemoryQueryResult, OperatorRuntime, OperatorSnapshot, VaultSecretView};

pub type AppSnapshot = OperatorSnapshot;

#[derive(Debug, Clone)]
pub struct MemphisClient {
    runtime: OperatorRuntime,
}

impl MemphisClient {
    pub fn new() -> Self {
        Self {
            runtime: OperatorRuntime::from_env(),
        }
    }

    pub fn fetch_snapshot(&self) -> AppSnapshot {
        self.runtime.snapshot()
    }

    pub fn search_exact(&self, query: &str, limit: usize) -> Result<MemoryQueryResult, String> {
        self.runtime
            .search_exact(query, limit, None)
            .map_err(|error| error.to_string())
    }

    pub fn search_semantic(&self, query: &str, limit: usize) -> Result<MemoryQueryResult, String> {
        self.runtime
            .search_semantic(query, limit)
            .map_err(|error| error.to_string())
    }

    pub fn read_vault_secret(&self, key: &str) -> Result<VaultSecretView, String> {
        self.runtime
            .read_vault_secret(key)
            .map_err(|error| error.to_string())
    }
}
