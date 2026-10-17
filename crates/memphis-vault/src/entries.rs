//! Existing JSON entry format shared by native readers and TS/NAPI adapters.
use std::{fs, io, path::Path};

use base64::{engine::general_purpose::STANDARD, Engine as _};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use thiserror::Error;

use crate::{Vault, VaultEntry};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Error)]
pub enum EntryError {
    #[error("VAULT_ENTRIES_UNREADABLE: vault entries cannot be read")]
    Unreadable,
    #[error("VAULT_ENTRIES_MALFORMED: vault entries are malformed")]
    Malformed,
    #[error("VAULT_ENTRY_NOT_FOUND: vault entry not found")]
    NotFound,
    #[error("VAULT_ENTRY_INTEGRITY_FAILED: vault entry integrity verification failed")]
    Integrity,
    #[error("VAULT_ENTRY_AUTH_FAILED: vault entry decryption failed")]
    Authentication,
    #[error("VAULT_ENTRY_INVALID_TEXT: vault entry is not valid UTF-8")]
    InvalidText,
}

impl EntryError {
    pub fn code(self) -> &'static str {
        match self {
            Self::Unreadable => "VAULT_ENTRIES_UNREADABLE",
            Self::Malformed => "VAULT_ENTRIES_MALFORMED",
            Self::NotFound => "VAULT_ENTRY_NOT_FOUND",
            Self::Integrity => "VAULT_ENTRY_INTEGRITY_FAILED",
            Self::Authentication => "VAULT_ENTRY_AUTH_FAILED",
            Self::InvalidText => "VAULT_ENTRY_INVALID_TEXT",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StoredEntry {
    pub key: String,
    pub encrypted: String,
    pub iv: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tag: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    #[serde(rename = "createdAt", default, skip_serializing_if = "Option::is_none")]
    pub created_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fingerprint: Option<String>,
    // Metadata owned by other callers must survive read/append/delete cycles.
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

impl StoredEntry {
    pub fn expected_fingerprint(&self) -> String {
        // Struct field order and JSON escaping match JSON.stringify in TS.
        #[derive(Serialize)]
        struct Payload<'a> {
            key: &'a str,
            encrypted: &'a str,
            iv: &'a str,
        }
        let payload = serde_json::to_vec(&Payload {
            key: &self.key,
            encrypted: &self.encrypted,
            iv: &self.iv,
        })
        .expect("serializing strings cannot fail");
        format!("{:x}", Sha256::digest(payload))
    }

    pub fn integrity_ok(&self) -> bool {
        self.fingerprint
            .as_ref()
            .is_none_or(|value| value.is_empty() || *value == self.expected_fingerprint())
    }

    fn normalize(mut self) -> Self {
        if self.fingerprint.as_ref().is_none_or(String::is_empty) {
            self.fingerprint = Some(self.expected_fingerprint());
        }
        self
    }

    pub fn to_vault_entry(&self) -> Result<VaultEntry, EntryError> {
        if !self.integrity_ok() {
            return Err(EntryError::Integrity);
        }
        let decode = |s: &str| STANDARD.decode(s).map_err(|_| EntryError::Malformed);
        let ciphertext = decode(&self.encrypted)?;
        let nonce = decode(&self.iv)?;
        let tag = decode(self.tag.as_deref().unwrap_or_default())?;
        if nonce.len() != 12
            || (tag.is_empty() && ciphertext.len() <= 16)
            || (!tag.is_empty() && (tag.len() != 16 || ciphertext.is_empty()))
        {
            return Err(EntryError::Malformed);
        }
        let created_at = match self.created_at.as_deref() {
            Some(value) => DateTime::parse_from_rfc3339(value)
                .map(|time| time.with_timezone(&Utc))
                .map_err(|_| EntryError::Malformed)?,
            None => DateTime::<Utc>::UNIX_EPOCH,
        };
        Ok(VaultEntry {
            id: self
                .id
                .as_ref()
                .filter(|id| !id.trim().is_empty())
                .cloned()
                .unwrap_or_else(|| "legacy-entry".into()),
            key: self.key.clone(),
            ciphertext,
            nonce,
            tag,
            created_at,
        })
    }

    pub fn decrypt_text(&self, vault: &Vault) -> Result<String, EntryError> {
        let entry = self.to_vault_entry()?;
        let plaintext = vault
            .retrieve(&entry)
            .map_err(|_| EntryError::Authentication)?;
        String::from_utf8(plaintext).map_err(|_| EntryError::InvalidText)
    }
}

pub fn parse_entry(raw: &str) -> Result<StoredEntry, EntryError> {
    serde_json::from_str::<StoredEntry>(raw)
        .map(StoredEntry::normalize)
        .map_err(|_| EntryError::Malformed)
}

pub fn parse_entries(raw: &str) -> Result<Vec<StoredEntry>, EntryError> {
    serde_json::from_str::<Vec<StoredEntry>>(raw)
        .map(|entries| entries.into_iter().map(StoredEntry::normalize).collect())
        .map_err(|_| EntryError::Malformed)
}

pub fn load_entries(path: &Path) -> Result<Vec<StoredEntry>, EntryError> {
    let raw = match fs::read_to_string(path) {
        Ok(raw) => raw,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(_) => return Err(EntryError::Unreadable),
    };
    parse_entries(&raw)
}

/// Last appended matching record wins, independently of timestamps. Never
/// fall back to an older credential if the selected record is corrupt.
pub fn select_entries(
    entries: Vec<StoredEntry>,
    key: Option<&str>,
    latest: bool,
) -> Vec<StoredEntry> {
    let filtered = entries
        .into_iter()
        .filter(|entry| key.is_none_or(|key| entry.key == key));
    if latest {
        filtered.last().into_iter().collect()
    } else {
        filtered.collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn stored(vault: &Vault, key: &str, plaintext: &[u8]) -> StoredEntry {
        let entry = vault.store(key, plaintext).unwrap();
        parse_entry(
            &json!({"key":key,"encrypted":STANDARD.encode(entry.ciphertext),
            "iv":STANDARD.encode(entry.nonce),"tag":STANDARD.encode(entry.tag)})
            .to_string(),
        )
        .unwrap()
    }

    #[test]
    fn preserves_v2_and_legacy_combined_tags_without_metadata() {
        let vault = Vault::from_parts([1; 32], [2; 32]);
        let mut entry = stored(&vault, "synthetic", b"secret");
        assert_eq!(entry.decrypt_text(&vault).unwrap(), "secret");
        let mut combined = STANDARD.decode(&entry.encrypted).unwrap();
        combined.extend(STANDARD.decode(entry.tag.take().unwrap()).unwrap());
        entry.encrypted = STANDARD.encode(combined);
        entry.fingerprint = None;
        assert_eq!(entry.decrypt_text(&vault).unwrap(), "secret");
    }

    #[test]
    fn selects_append_order_and_does_not_fall_back_from_corruption() {
        let vault = Vault::from_parts([1; 32], [2; 32]);
        let older = stored(&vault, "same", b"old");
        let mut newer = stored(&vault, "same", b"new");
        newer.fingerprint = Some("incorrect".into());
        let selected = select_entries(vec![older, newer], Some("same"), true);
        assert_eq!(selected.len(), 1);
        assert_eq!(selected[0].decrypt_text(&vault), Err(EntryError::Integrity));
    }

    #[test]
    fn rejects_bad_shapes_and_retains_unknown_metadata() {
        for raw in [
            "",
            "null",
            "{}",
            "[null]",
            "[{\"key\":123}]",
            "private-sentinel",
        ] {
            let error = parse_entries(raw).unwrap_err();
            assert_eq!(error, EntryError::Malformed);
            assert!(!error.to_string().contains("private-sentinel"));
        }
        let entries =
            parse_entries(r#"[{"key":"x","encrypted":"x","iv":"x","custom":{"retained":true}}]"#)
                .unwrap();
        assert_eq!(entries[0].extra["custom"]["retained"], true);
        assert!(entries[0].fingerprint.is_some());
    }

    #[test]
    fn classifies_malformed_authentication_and_text_errors() {
        let vault = Vault::from_parts([1; 32], [2; 32]);
        let entry = stored(&vault, "x", b"secret");
        assert_eq!(
            entry.decrypt_text(&Vault::from_parts([1; 32], [3; 32])),
            Err(EntryError::Authentication)
        );
        for len in [0, 1, 11, 13, 16] {
            let mut bad = entry.clone();
            bad.iv = STANDARD.encode(vec![0; len]);
            bad.fingerprint = None;
            assert_eq!(bad.decrypt_text(&vault), Err(EntryError::Malformed));
        }
        assert_eq!(
            stored(&vault, "x", &[0xff]).decrypt_text(&vault),
            Err(EntryError::InvalidText)
        );
    }
}
