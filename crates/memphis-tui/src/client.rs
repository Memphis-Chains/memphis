use memphis_operator::{
    ChatExchange, ChatSessionView, MemoryQueryResult, OperatorRuntime, OperatorSnapshot,
    ProviderStatus, VaultSecretView,
};

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

    pub fn load_chat_session(
        &self,
        session_id: Option<&str>,
        limit: usize,
    ) -> Result<ChatSessionView, String> {
        self.runtime
            .chat_session(session_id, limit)
            .map_err(|error| error.to_string())
    }

    pub fn send_chat(
        &self,
        session_id: Option<&str>,
        prompt: &str,
        provider: Option<&str>,
        model: Option<&str>,
    ) -> Result<ChatExchange, String> {
        self.runtime
            .chat(session_id, prompt, provider, model)
            .map_err(|error| error.to_string())
    }

    pub fn provider_statuses(&self) -> Vec<ProviderStatus> {
        self.runtime.provider_statuses()
    }
}
