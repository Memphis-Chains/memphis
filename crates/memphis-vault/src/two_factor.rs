use hkdf::Hkdf;
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

/// Legacy XOR-based 2FA derivation (v1). Kept for migration reads only.
#[cfg(test)]
#[deprecated(note = "use derive_vault_key_with_2fa_v2 for new vaults")]
pub fn derive_vault_key_with_2fa_v1(master_key: &[u8; 32], qa_answer: &str) -> [u8; 32] {
    let qa_hash = hash_answer(qa_answer);
    let qa_bytes = hex::decode(&qa_hash).expect("valid hex");

    let mut vault_key = [0u8; 32];
    for i in 0..32 {
        vault_key[i] = master_key[i] ^ qa_bytes[i];
    }
    vault_key
}

/// HKDF-based 2FA derivation (v2). Uses master_key as IKM and QA answer hash as salt.
///
/// Returns Result — production code should never panic on key derivation. Prior
/// versions used `.expect()` on both the hex decode and the HKDF expand; the
/// panics were only reachable via internal-logic corruption (#144), but
/// non-panicking error propagation is table-stakes for the crypto layer.
pub fn derive_vault_key_with_2fa_v2(
    master_key: &[u8; 32],
    qa_answer: &str,
) -> Result<[u8; 32], VaultError> {
    let qa_hash = hash_answer(qa_answer);
    let qa_bytes = hex::decode(&qa_hash)
        .map_err(|e| VaultError::KeyDerivation(format!("2fa qa_hash decode: {e}")))?;
    let hk = Hkdf::<Sha256>::new(Some(&qa_bytes), master_key);
    let mut vault_key = [0u8; 32];
    hk.expand(b"memphis-vault-2fa-v2", &mut vault_key)
        .map_err(|e| VaultError::KeyDerivation(format!("2fa HKDF expand: {e}")))?;
    Ok(vault_key)
}

/// Default 2FA derivation — uses v2 (HKDF).
pub fn derive_vault_key_with_2fa(
    master_key: &[u8; 32],
    qa_answer: &str,
) -> Result<[u8; 32], VaultError> {
    derive_vault_key_with_2fa_v2(master_key, qa_answer)
}

#[cfg(test)]
mod tests {
    #[allow(deprecated)]
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
    #[allow(deprecated)]
    fn test_derive_vault_key_v1_deterministic() {
        let master_key = [42u8; 32];
        let key1 = derive_vault_key_with_2fa_v1(&master_key, "answer1");
        let key2 = derive_vault_key_with_2fa_v1(&master_key, "answer1");
        assert_eq!(key1, key2);
    }

    #[test]
    #[allow(deprecated)]
    fn test_derive_vault_key_v1_different_answers() {
        let master_key = [42u8; 32];
        let key1 = derive_vault_key_with_2fa_v1(&master_key, "answer1");
        let key2 = derive_vault_key_with_2fa_v1(&master_key, "answer2");
        assert_ne!(key1, key2);
    }

    #[test]
    fn test_derive_vault_key_v2_deterministic() {
        let master_key = [42u8; 32];
        let key1 = derive_vault_key_with_2fa_v2(&master_key, "answer1").unwrap();
        let key2 = derive_vault_key_with_2fa_v2(&master_key, "answer1").unwrap();
        assert_eq!(key1, key2);
    }

    #[test]
    fn test_derive_vault_key_v2_different_answers() {
        let master_key = [42u8; 32];
        let key1 = derive_vault_key_with_2fa_v2(&master_key, "answer1").unwrap();
        let key2 = derive_vault_key_with_2fa_v2(&master_key, "answer2").unwrap();
        assert_ne!(key1, key2);
    }

    #[test]
    #[allow(deprecated)]
    fn test_v1_and_v2_produce_different_keys() {
        let master_key = [42u8; 32];
        let v1 = derive_vault_key_with_2fa_v1(&master_key, "answer1");
        let v2 = derive_vault_key_with_2fa_v2(&master_key, "answer1").unwrap();
        assert_ne!(
            v1, v2,
            "v1 and v2 must produce different keys for same input"
        );
    }

    #[test]
    fn test_default_uses_v2() {
        let master_key = [42u8; 32];
        let default_key = derive_vault_key_with_2fa(&master_key, "answer1").unwrap();
        let v2_key = derive_vault_key_with_2fa_v2(&master_key, "answer1").unwrap();
        assert_eq!(default_key, v2_key);
    }

    // Regression net for #144: production code paths must return Result, not
    // panic. hash_answer always produces valid hex today, so the error path
    // is only reachable via internal-logic corruption — we can't easily
    // trigger it without mocking hash_answer. This test instead asserts the
    // Ok-path contract: valid input always yields Ok(...), the function
    // signature is Result, and a caller can use `?`-propagation.
    #[test]
    fn test_derive_vault_key_v2_returns_result() {
        let master_key = [1u8; 32];
        let result: Result<[u8; 32], VaultError> =
            derive_vault_key_with_2fa_v2(&master_key, "sample-answer");
        assert!(result.is_ok(), "valid input must produce Ok(_)");
    }
}
