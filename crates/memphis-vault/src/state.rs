//! Shared reader for the existing TS vault-state formats. No writes or fallback
//! paths: callers own path selection, transaction locking and migration.
use std::{fs, io, path::Path};

use aes_gcm::{
    aead::{Aead, KeyInit},
    Aes256Gcm, Nonce,
};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use scrypt::{scrypt, Params};
use serde_json::Value;
use thiserror::Error;
use zeroize::Zeroizing;

use crate::Vault;

/// Messages are static: never include JSON, credentials, crypto errors or paths.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Error)]
pub enum VaultStateError {
    #[error("VAULT_STATE_MISSING: vault state not found")]
    Missing,
    #[error("VAULT_STATE_UNREADABLE: vault state cannot be read")]
    Unreadable,
    #[error("VAULT_STATE_MALFORMED: vault state is malformed")]
    Malformed,
    #[error("VAULT_STATE_UNSUPPORTED_VERSION: unsupported vault state version")]
    UnsupportedVersion,
    #[error("VAULT_PEPPER_REQUIRED: MEMPHIS_VAULT_PEPPER missing or too short (min 12 chars)")]
    PepperRequired,
    #[error("VAULT_STATE_AUTH_FAILED: failed to decrypt vault state")]
    AuthenticationFailed,
}

impl VaultStateError {
    pub fn code(self) -> &'static str {
        match self {
            Self::Missing => "VAULT_STATE_MISSING",
            Self::Unreadable => "VAULT_STATE_UNREADABLE",
            Self::Malformed => "VAULT_STATE_MALFORMED",
            Self::UnsupportedVersion => "VAULT_STATE_UNSUPPORTED_VERSION",
            Self::PepperRequired => "VAULT_PEPPER_REQUIRED",
            Self::AuthenticationFailed => "VAULT_STATE_AUTH_FAILED",
        }
    }
}

pub struct LoadedVaultState {
    pub vault: Vault,
    pub version: u8,
}

// Match String.prototype.trim used by the existing TS writer. Rust's trim
// additionally removes NEL and does not remove BOM, changing those passwords.
fn trim_js_whitespace(value: &str) -> &str {
    value.trim_matches(|c| {
        matches!(c,
            '\u{0009}'..='\u{000d}' | '\u{0020}' | '\u{00a0}' | '\u{1680}' |
            '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' |
            '\u{205f}' | '\u{3000}' | '\u{feff}'
        )
    })
}

pub fn load_persisted_state(
    path: &Path,
    pepper: &str,
) -> Result<LoadedVaultState, VaultStateError> {
    let raw = Zeroizing::new(fs::read(path).map_err(|error| {
        if error.kind() == io::ErrorKind::NotFound {
            VaultStateError::Missing
        } else {
            VaultStateError::Unreadable
        }
    })?);
    decode_persisted_state(&raw, pepper)
}

fn field<const N: usize>(value: &Value, key: &str) -> Result<[u8; N], VaultStateError> {
    let text = value
        .get(key)
        .and_then(Value::as_str)
        .ok_or(VaultStateError::Malformed)?;
    let bytes = Zeroizing::new(
        STANDARD
            .decode(text)
            .map_err(|_| VaultStateError::Malformed)?,
    );
    bytes
        .as_slice()
        .try_into()
        .map_err(|_| VaultStateError::Malformed)
}

pub fn decode_persisted_state(
    raw: &[u8],
    pepper: &str,
) -> Result<LoadedVaultState, VaultStateError> {
    let mut parsed: Value = serde_json::from_slice(raw).map_err(|_| VaultStateError::Malformed)?;
    if !parsed.is_object() {
        return Err(VaultStateError::Malformed);
    }
    let version = match parsed.get("version") {
        None => 1,
        Some(v) if v.as_u64() == Some(1) => 1,
        Some(v) if v.as_u64() == Some(2) => 2,
        Some(_) => return Err(VaultStateError::UnsupportedVersion),
    };
    let salt = field::<32>(&parsed, "salt")?;
    let master_key = if version == 1 {
        let key = field::<32>(&parsed, "masterKey");
        // Legacy JSON contains the plaintext key. Clear the parsed copy too.
        if let Some(Value::String(text)) = parsed.get_mut("masterKey") {
            use zeroize::Zeroize;
            text.zeroize();
        }
        key?
    } else {
        let encrypted = field::<32>(&parsed, "encryptedMasterKey")?;
        let iv = field::<12>(&parsed, "iv")?;
        let tag = field::<16>(&parsed, "tag")?;
        let pepper = trim_js_whitespace(pepper);
        // Match the existing JavaScript minimum length (UTF-16 code units).
        if pepper.encode_utf16().count() < 12 {
            return Err(VaultStateError::PepperRequired);
        }
        let params = Params::new(14, 8, 1, 32).map_err(|_| VaultStateError::Malformed)?;
        let mut key = Zeroizing::new([0u8; 32]);
        scrypt(
            pepper.as_bytes(),
            b"memphis-vault-state-v2",
            &params,
            key.as_mut(),
        )
        .map_err(|_| VaultStateError::Malformed)?;
        let cipher =
            Aes256Gcm::new_from_slice(key.as_ref()).map_err(|_| VaultStateError::Malformed)?;
        let mut payload = encrypted.to_vec();
        payload.extend_from_slice(&tag);
        let plaintext = Zeroizing::new(
            cipher
                .decrypt(Nonce::from_slice(&iv), payload.as_slice())
                .map_err(|_| VaultStateError::AuthenticationFailed)?,
        );
        plaintext
            .as_slice()
            .try_into()
            .map_err(|_| VaultStateError::Malformed)?
    };
    Ok(LoadedVaultState {
        vault: Vault::from_parts(salt, master_key),
        version,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const V2: &[u8] = include_bytes!("../../../tests/fixtures/vault-state-v2.synthetic.json");
    const PEPPER: &str = "synthetic-state-reader-pepper";

    #[test]
    fn reads_node_generated_v2_and_trims_pepper_consistently() {
        let loaded = decode_persisted_state(V2, &format!(" \u{feff}{PEPPER}\n\u{feff}")).unwrap();
        assert_eq!(loaded.version, 2);
        assert_eq!(loaded.vault.parts(), ([1; 32], [2; 32]));
        assert_eq!(
            trim_js_whitespace("\u{0085}pepper\u{0085}"),
            "\u{0085}pepper\u{0085}"
        );
    }

    #[test]
    fn preserves_legacy_v1_reads() {
        for version in [None, Some(1)] {
            let mut value =
                json!({"salt": STANDARD.encode([1; 32]), "masterKey": STANDARD.encode([2; 32])});
            if let Some(v) = version {
                value["version"] = json!(v);
            }
            let loaded = decode_persisted_state(value.to_string().as_bytes(), "").unwrap();
            assert_eq!(loaded.version, 1);
            assert_eq!(loaded.vault.parts(), ([1; 32], [2; 32]));
        }
    }

    #[test]
    fn classifies_missing_pepper_and_failed_authentication() {
        assert_eq!(
            decode_persisted_state(V2, "short").err(),
            Some(VaultStateError::PepperRequired)
        );
        assert_eq!(
            decode_persisted_state(V2, "different-state-reader-value").err(),
            Some(VaultStateError::AuthenticationFailed)
        );
    }

    #[test]
    fn rejects_malformed_lengths_before_nonce_construction_or_derivation() {
        for (key, size) in [
            ("salt", 32),
            ("encryptedMasterKey", 32),
            ("iv", 12),
            ("tag", 16),
        ] {
            for len in [0, 1, size - 1, size + 1] {
                let mut value: Value = serde_json::from_slice(V2).unwrap();
                value[key] = json!(STANDARD.encode(vec![0; len]));
                assert_eq!(
                    decode_persisted_state(value.to_string().as_bytes(), "").err(),
                    Some(VaultStateError::Malformed),
                    "{key}, {len}"
                );
            }
        }
    }

    #[test]
    fn rejects_bad_json_base64_and_unknown_versions_without_echoing_data() {
        for raw in ["", "{synthetic-secret", "null", "[]", "{}"] {
            assert_eq!(
                decode_persisted_state(raw.as_bytes(), PEPPER).err(),
                Some(VaultStateError::Malformed)
            );
        }
        for version in [json!(0), json!(3), json!("2"), json!(null)] {
            let mut value: Value = serde_json::from_slice(V2).unwrap();
            value["version"] = version;
            // Presence of a legacy key must not turn an unknown schema into v1.
            value["masterKey"] = json!(STANDARD.encode([2; 32]));
            assert_eq!(
                decode_persisted_state(value.to_string().as_bytes(), PEPPER).err(),
                Some(VaultStateError::UnsupportedVersion)
            );
        }
        let mut value: Value = serde_json::from_slice(V2).unwrap();
        value["iv"] = json!("synthetic-private-sentinel");
        let error = decode_persisted_state(value.to_string().as_bytes(), PEPPER)
            .err()
            .unwrap();
        assert_eq!(error, VaultStateError::Malformed);
        assert!(!error.to_string().contains("sentinel"));
    }
}
