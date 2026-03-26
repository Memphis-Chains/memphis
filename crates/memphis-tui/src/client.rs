use serde::Deserialize;
use thiserror::Error;

#[derive(Debug, Clone, Deserialize, Default)]
pub struct HealthSummary {
    #[serde(default)]
    pub status: String,
    #[serde(default)]
    pub summary: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct AdapterStatus {
    #[serde(default, rename = "bridgeLoaded")]
    pub bridge_loaded: bool,
    #[serde(default)]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct AdapterSet {
    #[serde(default)]
    pub chain: AdapterStatus,
    #[serde(default)]
    pub vault: AdapterStatus,
    #[serde(default)]
    pub embed: AdapterStatus,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct ProviderHealth {
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub ok: bool,
    #[serde(default, rename = "latencyMs")]
    pub latency_ms: Option<u64>,
    #[serde(default)]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct StatusResponse {
    #[serde(default)]
    pub ok: bool,
    #[serde(default)]
    pub service: String,
    #[serde(default)]
    pub version: String,
    #[serde(default)]
    pub uptime: u64,
    #[serde(default)]
    pub health: HealthSummary,
    #[serde(default)]
    pub adapters: AdapterSet,
    #[serde(default)]
    pub providers: Vec<ProviderHealth>,
    #[serde(default)]
    pub timestamp: String,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct VaultEntryMetadata {
    #[serde(default)]
    pub key: String,
    #[serde(default, rename = "createdAt")]
    pub created_at: String,
    #[serde(default)]
    pub fingerprint: String,
    #[serde(default, rename = "integrityOk")]
    pub integrity_ok: bool,
    #[serde(default)]
    pub id: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct VaultEntriesResponse {
    #[serde(default)]
    pub ok: bool,
    #[serde(default)]
    pub count: usize,
    #[serde(default)]
    pub entries: Vec<VaultEntryMetadata>,
}

#[derive(Debug, Clone, Default)]
pub struct AppSnapshot {
    pub status: Option<StatusResponse>,
    pub status_error: Option<String>,
    pub vault: Option<VaultEntriesResponse>,
    pub vault_error: Option<String>,
}

#[derive(Debug, Error)]
pub enum ClientError {
    #[error("{0}")]
    Http(String),
    #[error("{0}")]
    Decode(String),
}

#[derive(Debug, Clone)]
pub struct MemphisClient {
    base_url: String,
    api_token: Option<String>,
}

impl MemphisClient {
    pub fn new(base_url: String, api_token: Option<String>) -> Self {
        Self {
            base_url,
            api_token,
        }
    }

    pub fn fetch_snapshot(&self) -> AppSnapshot {
        let mut snapshot = AppSnapshot::default();

        match self.get_json::<StatusResponse>("/api/status", false) {
            Ok(status) => snapshot.status = Some(status),
            Err(error) => snapshot.status_error = Some(error.to_string()),
        }

        match self.get_json::<VaultEntriesResponse>("/v1/vault/entries", true) {
            Ok(vault) => snapshot.vault = Some(vault),
            Err(error) => snapshot.vault_error = Some(error.to_string()),
        }

        snapshot
    }

    fn get_json<T>(&self, path: &str, auth_required: bool) -> Result<T, ClientError>
    where
        T: for<'de> Deserialize<'de>,
    {
        let url = format!("{}{}", self.base_url, path);
        let request = if auth_required {
            let token = self
                .api_token
                .as_deref()
                .ok_or_else(|| ClientError::Http(format!("missing token for {}", path)))?;
            ureq::get(&url).set("Authorization", &format!("Bearer {token}"))
        } else {
            ureq::get(&url)
        };

        let response = request.call().map_err(|error| match error {
            ureq::Error::Status(code, response) => {
                let body = response.into_string().unwrap_or_default();
                ClientError::Http(format!("{path} returned HTTP {code}: {body}"))
            }
            ureq::Error::Transport(transport) => ClientError::Http(format!("{path}: {transport}")),
        })?;

        response
            .into_json()
            .map_err(|error| ClientError::Decode(format!("{path}: {error}")))
    }
}
