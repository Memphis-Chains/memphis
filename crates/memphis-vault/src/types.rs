use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::two_factor::QAChallenge;

#[derive(Debug, Error, Clone, PartialEq, Eq)]
pub enum VaultValidationError {
    #[error("{0}")]
    InvalidField(&'static str),
}

#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct VaultConfig {
    pub pepper: String,
    pub iterations: u32,
    pub memory: u32,
    #[serde(default)]
    pub qa_challenge: Option<QAChallenge>,
    #[serde(default)]
    pub did: Option<String>,
}

// Debug is a diagnostic projection; serialized credential contracts stay unchanged.
impl std::fmt::Debug for VaultConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("VaultConfig")
            .field("iterations", &self.iterations)
            .field("memory", &self.memory)
            .field("qa_configured", &self.qa_challenge.is_some())
            .finish_non_exhaustive()
    }
}

#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct VaultInitRequest {
    #[serde(alias = "passphrase")]
    pub pepper: String,
    #[serde(default = "default_iterations")]
    pub iterations: u32,
    #[serde(default = "default_memory")]
    pub memory: u32,
}

// Debug is a diagnostic projection; serialized credential contracts stay unchanged.
impl std::fmt::Debug for VaultInitRequest {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("VaultInitRequest")
            .field("iterations", &self.iterations)
            .field("memory", &self.memory)
            .finish_non_exhaustive()
    }
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

#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct VaultInitResult {
    pub success: bool,
    pub master_key_hash: Option<String>,
    pub error: Option<String>,
}

// Debug is a diagnostic projection; serialized credential contracts stay unchanged.
impl std::fmt::Debug for VaultInitResult {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("VaultInitResult")
            .field("success", &self.success)
            .finish_non_exhaustive()
    }
}

#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct VaultEntry {
    pub id: String,
    #[serde(default)]
    pub key: String,
    pub ciphertext: Vec<u8>,
    pub nonce: Vec<u8>,
    pub tag: Vec<u8>,
    pub created_at: DateTime<Utc>,
}

// Debug is a diagnostic projection; serialized credential contracts stay unchanged.
impl std::fmt::Debug for VaultEntry {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("VaultEntry")
            .field("id", &self.id)
            .field("key", &self.key)
            .field("created_at", &self.created_at)
            .finish_non_exhaustive()
    }
}

impl VaultEntry {
    pub fn validate(&self) -> Result<(), VaultValidationError> {
        if self.id.trim().is_empty() {
            return Err(VaultValidationError::InvalidField("id must not be empty"));
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
            return Err(VaultValidationError::InvalidField("tag must not be empty"));
        }

        Ok(())
    }
}

#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct VaultStoreRequest {
    pub key: String,
    pub plaintext: String,
}

// Debug is a diagnostic projection; serialized credential contracts stay unchanged.
impl std::fmt::Debug for VaultStoreRequest {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("VaultStoreRequest")
            .field("key", &self.key)
            .finish_non_exhaustive()
    }
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

#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct VaultRetrieveResult {
    pub plaintext: Option<String>,
    pub success: bool,
}

// Debug is a diagnostic projection; serialized credential contracts stay unchanged.
impl std::fmt::Debug for VaultRetrieveResult {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("VaultRetrieveResult")
            .field("success", &self.success)
            .finish_non_exhaustive()
    }
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
            key: "api-key".to_string(),
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
            key: "api-key".to_string(),
            ciphertext: vec![1],
            nonce: vec![2],
            tag: vec![3],
            created_at: Utc::now(),
        };

        assert_eq!(entry.validate(), Ok(()));

        let invalid = VaultEntry {
            id: "".to_string(),
            key: "".to_string(),
            ciphertext: vec![],
            nonce: vec![],
            tag: vec![],
            created_at: Utc::now(),
        };

        assert!(invalid.validate().is_err());
    }
    fn assert_credential_debug<T: std::fmt::Debug>(value: &T, secret: &str) {
        for debug in [format!("{value:?}"), format!("{value:#?}")] {
            assert!(!debug.contains(secret));
            assert!(!debug.contains(&secret[..16]));
            assert!(!debug.contains(&secret[secret.len() - 16..]));
        }
    }

    #[test]
    fn credential_debug_vault_config_omits_pepper() {
        let secret = "synthetic-native-private-debug-material";
        let value = VaultConfig {
            pepper: secret.into(),
            iterations: 100_000,
            memory: 64,
            qa_challenge: None,
            did: None,
        };
        assert_credential_debug(&value, secret);
        assert_eq!(serde_json::to_value(&value).unwrap()["pepper"], secret);
    }

    #[test]
    fn credential_debug_vault_init_request_omits_pepper() {
        let secret = "synthetic-native-private-debug-material";
        let value = VaultInitRequest {
            pepper: secret.into(),
            iterations: 100_000,
            memory: 64,
        };
        assert_credential_debug(&value, secret);
        assert_eq!(serde_json::to_value(&value).unwrap()["pepper"], secret);
    }

    #[test]
    fn credential_debug_vault_init_result_omits_hash_and_exception_text() {
        let secret = "synthetic-native-private-debug-material";
        let value = VaultInitResult {
            success: true,
            master_key_hash: Some(secret.into()),
            error: Some(secret.into()),
        };
        assert_credential_debug(&value, secret);
        assert_eq!(
            serde_json::to_value(&value).unwrap()["master_key_hash"],
            secret
        );
    }

    #[test]
    fn credential_debug_vault_store_request_omits_plaintext() {
        let secret = "synthetic-native-private-debug-material";
        let value = VaultStoreRequest {
            key: "first".into(),
            plaintext: secret.into(),
        };
        assert_credential_debug(&value, secret);
        assert_eq!(serde_json::to_value(&value).unwrap()["plaintext"], secret);
    }

    #[test]
    fn credential_debug_vault_retrieve_result_omits_plaintext() {
        let secret = "synthetic-native-private-debug-material";
        let value = VaultRetrieveResult {
            success: true,
            plaintext: Some(secret.into()),
        };
        assert_credential_debug(&value, secret);
        assert_eq!(serde_json::to_value(&value).unwrap()["plaintext"], secret);
    }

    #[test]
    fn credential_debug_vault_entry_omits_crypto_payload() {
        let value = VaultEntry {
            id: "fixture".into(),
            key: "first".into(),
            ciphertext: vec![173, 91, 222, 13, 87],
            nonce: vec![19, 173, 111],
            tag: vec![201, 92, 173],
            created_at: Utc::now(),
        };
        for debug in [format!("{value:?}"), format!("{value:#?}")] {
            assert!(!debug.contains(&format!("{:?}", value.ciphertext)));
            assert!(!debug.contains(&format!("{:?}", value.nonce)));
            assert!(!debug.contains(&format!("{:?}", value.tag)));
        }
        assert_eq!(
            serde_json::to_value(&value).unwrap()["ciphertext"],
            serde_json::json!(value.ciphertext)
        );
    }
}
