use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use thiserror::Error;

#[derive(Debug, Error, Clone, PartialEq, Eq)]
pub enum VaultValidationError {
    #[error("{0}")]
    InvalidField(&'static str),
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct VaultConfig {
    pub pepper: String,
    pub iterations: u32,
    pub memory: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct VaultInitRequest {
    #[serde(alias = "passphrase")]
    pub pepper: String,
    #[serde(default = "default_iterations")]
    pub iterations: u32,
    #[serde(default = "default_memory")]
    pub memory: u32,
}

fn default_iterations() -> u32 {
    100_000
}

fn default_memory() -> u32 {
    64
}

impl VaultInitRequest {
    pub fn validate(&self) -> Result<(), VaultValidationError> {
        if self.pepper.trim().is_empty() {
            return Err(VaultValidationError::InvalidField(
                "pepper must not be empty",
            ));
        }

        if !(1_000..=1_000_000).contains(&self.iterations) {
            return Err(VaultValidationError::InvalidField(
                "iterations must be between 1_000 and 1_000_000",
            ));
        }

        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct VaultInitResult {
    pub success: bool,
    pub master_key_hash: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct VaultEntry {
    pub id: String,
    pub ciphertext: Vec<u8>,
    pub nonce: Vec<u8>,
    pub tag: Vec<u8>,
    pub created_at: DateTime<Utc>,
}

impl VaultEntry {
    pub fn validate(&self) -> Result<(), VaultValidationError> {
        if self.id.trim().is_empty() {
            return Err(VaultValidationError::InvalidField(
                "id must not be empty",
            ));
        }

        if self.ciphertext.is_empty() {
            return Err(VaultValidationError::InvalidField(
                "ciphertext must not be empty",
            ));
        }

        if self.nonce.is_empty() {
            return Err(VaultValidationError::InvalidField(
                "nonce must not be empty",
            ));
        }

        if self.tag.is_empty() {
            return Err(VaultValidationError::InvalidField(
                "tag must not be empty",
            ));
        }

        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct VaultStoreRequest {
    pub key: String,
    pub plaintext: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct VaultStoreResult {
    pub entry_id: String,
    pub success: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct VaultRetrieveRequest {
    pub entry_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct VaultRetrieveResult {
    pub plaintext: Option<String>,
    pub success: bool,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn roundtrip<T>(value: &T)
    where
        T: Serialize + for<'de> Deserialize<'de> + PartialEq + std::fmt::Debug,
    {
        let encoded = serde_json::to_string(value).expect("serialize should succeed");
        let decoded: T = serde_json::from_str(&encoded).expect("deserialize should succeed");
        assert_eq!(*value, decoded);
    }

    #[test]
    fn roundtrip_vault_init_request() {
        roundtrip(&VaultInitRequest {
            pepper: "pepper".to_string(),
            iterations: 100_000,
            memory: 64,
        });
    }

    #[test]
    fn roundtrip_vault_init_result() {
        roundtrip(&VaultInitResult {
            success: true,
            master_key_hash: Some("hash".to_string()),
            error: None,
        });
    }

    #[test]
    fn roundtrip_vault_entry() {
        roundtrip(&VaultEntry {
            id: "entry-1".to_string(),
            ciphertext: vec![1, 2, 3],
            nonce: vec![4, 5, 6],
            tag: vec![7, 8, 9],
            created_at: Utc::now(),
        });
    }

    #[test]
    fn roundtrip_vault_store_request() {
        roundtrip(&VaultStoreRequest {
            key: "api-key".to_string(),
            plaintext: "secret".to_string(),
        });
    }

    #[test]
    fn roundtrip_vault_store_result() {
        roundtrip(&VaultStoreResult {
            entry_id: "entry-1".to_string(),
            success: true,
        });
    }

    #[test]
    fn roundtrip_vault_retrieve_request() {
        roundtrip(&VaultRetrieveRequest {
            entry_id: "entry-1".to_string(),
        });
    }

    #[test]
    fn roundtrip_vault_retrieve_result() {
        roundtrip(&VaultRetrieveResult {
            plaintext: Some("secret".to_string()),
            success: true,
        });
    }

    #[test]
    fn validate_init_request() {
        let request = VaultInitRequest {
            pepper: "pepper".to_string(),
            iterations: 100_000,
            memory: 64,
        };

        assert_eq!(request.validate(), Ok(()));

        let invalid = VaultInitRequest {
            pepper: "".to_string(),
            iterations: 100_000,
            memory: 64,
        };

        assert!(invalid.validate().is_err());
    }

    #[test]
    fn validate_vault_entry() {
        let entry = VaultEntry {
            id: "entry-1".to_string(),
            ciphertext: vec![1],
            nonce: vec![2],
            tag: vec![3],
            created_at: Utc::now(),
        };

        assert_eq!(entry.validate(), Ok(()));

        let invalid = VaultEntry {
            id: "".to_string(),
            ciphertext: vec![],
            nonce: vec![],
            tag: vec![],
            created_at: Utc::now(),
        };

        assert!(invalid.validate().is_err());
    }
}
