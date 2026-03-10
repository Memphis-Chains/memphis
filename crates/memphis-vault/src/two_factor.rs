use sha2::{Digest, Sha256};

use crate::error::VaultError;

/// Question + Answer for 2FA recovery
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
pub struct QAChallenge {
    pub question: String,
    /// Hashed answer (SHA-256)
    pub answer_hash: String,
    pub created_at: chrono::DateTime<chrono::Utc>,
}

impl QAChallenge {
    /// Create new Q&A challenge
    pub fn new(question: String, answer: &str) -> Result<Self, VaultError> {
        if question.trim().is_empty() {
            return Err(VaultError::InvalidConfig("question cannot be empty"));
        }
        if answer.trim().len() < 3 {
            return Err(VaultError::InvalidConfig("answer too short (min 3 chars)"));
        }

        let answer_hash = hash_answer(answer);

        Ok(Self {
            question,
            answer_hash,
            created_at: chrono::Utc::now(),
        })
    }

    /// Verify answer matches
    pub fn verify(&self, answer: &str) -> bool {
        hash_answer(answer) == self.answer_hash
    }
}

/// Hash answer with SHA-256 (lowercase, trimmed)
fn hash_answer(answer: &str) -> String {
    let normalized = answer.trim().to_lowercase();
    let mut hasher = Sha256::new();
    hasher.update(normalized.as_bytes());
    format!("{:x}", hasher.finalize())
}

/// Derive vault key from master_key + QA answer (XOR)
/// This provides 2FA: even with master key, need QA answer
pub fn derive_vault_key_with_2fa(master_key: &[u8; 32], qa_answer: &str) -> [u8; 32] {
    let qa_hash = hash_answer(qa_answer);
    let qa_bytes = hex::decode(&qa_hash).expect("valid hex");

    let mut vault_key = [0u8; 32];
    for i in 0..32 {
        vault_key[i] = master_key[i] ^ qa_bytes[i];
    }
    vault_key
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_qa_challenge_verify_correct() {
        let qa = QAChallenge::new("Pet name?".into(), "fluffy").unwrap();
        assert!(qa.verify("fluffy"));
        assert!(qa.verify("  FLUFFY  ")); // case insensitive, trimmed
    }

    #[test]
    fn test_qa_challenge_verify_wrong() {
        let qa = QAChallenge::new("Pet name?".into(), "fluffy").unwrap();
        assert!(!qa.verify("spot"));
        assert!(!qa.verify(""));
    }

    #[test]
    fn test_derive_vault_key_with_2fa() {
        let master_key = [42u8; 32];
        let key1 = derive_vault_key_with_2fa(&master_key, "answer1");
        let key2 = derive_vault_key_with_2fa(&master_key, "answer2");

        // Same master key + different answers = different vault keys
        assert_ne!(key1, key2);
    }
}
