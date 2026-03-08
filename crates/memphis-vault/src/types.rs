use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VaultInitRequest {
    pub passphrase: String,
    pub recovery_question: String,
    pub recovery_answer: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VaultInitResult {
    pub version: u8,
    pub did: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VaultEntry {
    pub key: String,
    pub encrypted: String,
    pub iv: String,
}

#[cfg(test)]
mod tests {
    use super::{VaultEntry, VaultInitRequest, VaultInitResult};

    #[test]
    fn init_request_serializes_required_fields() {
        let req = VaultInitRequest {
            passphrase: "VeryStrongPassphrase!123".to_string(),
            recovery_question: "first pet?".to_string(),
            recovery_answer: "nori".to_string(),
        };

        let json = serde_json::to_string(&req).expect("serialize request");
        assert!(json.contains("passphrase"));
        assert!(json.contains("recovery_question"));
        assert!(json.contains("recovery_answer"));
    }

    #[test]
    fn result_and_entry_roundtrip_json() {
        let result = VaultInitResult {
            version: 1,
            did: "did:memphis:test-123".to_string(),
        };
        let entry = VaultEntry {
            key: "openai_api_key".to_string(),
            encrypted: "base64cipher".to_string(),
            iv: "001122".to_string(),
        };

        let result_json = serde_json::to_string(&result).expect("serialize result");
        let entry_json = serde_json::to_string(&entry).expect("serialize entry");

        let result_back: VaultInitResult =
            serde_json::from_str(&result_json).expect("deserialize result");
        let entry_back: VaultEntry = serde_json::from_str(&entry_json).expect("deserialize entry");

        assert_eq!(result_back.version, 1);
        assert_eq!(result_back.did, "did:memphis:test-123");
        assert_eq!(entry_back.key, "openai_api_key");
    }
}
