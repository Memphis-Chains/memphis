use memphis_vault::{Vault, VaultEntry, VaultInitConfig, VaultInitResult};
use napi::bindgen_prelude::Buffer;
use napi_derive::napi;

#[napi(object)]
pub struct JsVaultStateResult {
    pub vault: Option<JsVault>,
    pub version: Option<u32>,
    #[napi(js_name = "error_code")]
    pub error_code: Option<String>,
    pub error: Option<String>,
}

#[napi(js_name = "vault_load_state")]
pub fn vault_load_state(path: String, pepper: String) -> JsVaultStateResult {
    match memphis_vault::state::load_persisted_state(std::path::Path::new(&path), &pepper) {
        Ok(state) => JsVaultStateResult {
            vault: Some(state.vault.into()),
            version: Some(state.version.into()),
            error_code: None,
            error: None,
        },
        Err(error) => JsVaultStateResult {
            vault: None,
            version: None,
            error_code: Some(error.code().into()),
            error: Some(error.to_string()),
        },
    }
}

#[napi(object)]
pub struct JsEntriesResult {
    pub entries_json: Option<String>,
    pub entry: Option<JsVaultEntry>,
    pub error_code: Option<String>,
}

#[napi(js_name = "vault_parse_entries")]
pub fn vault_parse_entries(raw: String, key: Option<String>, latest: bool) -> JsEntriesResult {
    use memphis_vault::entries::{parse_entries, select_entries};
    match parse_entries(&raw) {
        Ok(entries) => JsEntriesResult {
            entries_json: Some(
                serde_json::to_string(&select_entries(entries, key.as_deref(), latest))
                    .expect("serializing entry metadata cannot fail"),
            ),
            entry: None,
            error_code: None,
        },
        Err(error) => JsEntriesResult {
            entries_json: None,
            entry: None,
            error_code: Some(error.code().into()),
        },
    }
}

#[napi(js_name = "vault_decode_entry")]
pub fn vault_decode_entry(raw: String) -> JsEntriesResult {
    use memphis_vault::entries::parse_entry;
    match parse_entry(&raw).and_then(|entry| entry.to_vault_entry()) {
        Ok(entry) => JsEntriesResult {
            entries_json: None,
            entry: Some(entry.into()),
            error_code: None,
        },
        Err(error) => JsEntriesResult {
            entries_json: None,
            entry: None,
            error_code: Some(error.code().into()),
        },
    }
}

#[napi(object)]
pub struct JsVault {
    pub salt: Buffer,
    #[napi(js_name = "master_key")]
    pub master_key: Buffer,
}

#[napi(object)]
pub struct JsVaultEntry {
    pub id: String,
    pub key: String,
    pub ciphertext: Buffer,
    pub nonce: Buffer,
    pub tag: Buffer,
    #[napi(js_name = "created_at")]
    pub created_at: String,
}

impl From<Vault> for JsVault {
    fn from(vault: Vault) -> Self {
        let (salt, master_key) = vault.parts();
        Self {
            salt: Buffer::from(salt.to_vec()),
            master_key: Buffer::from(master_key.to_vec()),
        }
    }
}

impl JsVault {
    fn to_inner(&self) -> Result<Vault, napi::Error> {
        let salt: [u8; 32] = self
            .salt
            .as_ref()
            .try_into()
            .map_err(|_| napi::Error::from_reason("invalid salt size"))?;
        let master_key: [u8; 32] = self
            .master_key
            .as_ref()
            .try_into()
            .map_err(|_| napi::Error::from_reason("invalid master_key size"))?;

        Ok(Vault::from_parts(salt, master_key))
    }
}

impl From<VaultEntry> for JsVaultEntry {
    fn from(entry: VaultEntry) -> Self {
        Self {
            id: entry.id,
            key: entry.key,
            ciphertext: Buffer::from(entry.ciphertext),
            nonce: Buffer::from(entry.nonce),
            tag: Buffer::from(entry.tag),
            created_at: entry.created_at.to_rfc3339(),
        }
    }
}

impl JsVaultEntry {
    fn to_inner(&self) -> Result<VaultEntry, napi::Error> {
        Ok(VaultEntry {
            id: self.id.clone(),
            key: self.key.clone(),
            ciphertext: self.ciphertext.to_vec(),
            nonce: self.nonce.to_vec(),
            tag: self.tag.to_vec(),
            created_at: chrono::DateTime::parse_from_rfc3339(&self.created_at)
                .map_err(|e| napi::Error::from_reason(format!("invalid created_at: {e}")))?
                .with_timezone(&chrono::Utc),
        })
    }
}

#[napi(object)]
pub struct JsVaultInitResult {
    pub vault: JsVault,
    pub did: String,
    #[napi(js_name = "qa_question")]
    pub qa_question: String,
}

impl From<VaultInitResult> for JsVaultInitResult {
    fn from(result: VaultInitResult) -> Self {
        Self {
            vault: JsVault::from(result.vault),
            did: result.did.did,
            qa_question: result.qa_challenge.question,
        }
    }
}

#[napi(js_name = "vault_init_full")]
pub fn vault_init_full(
    passphrase: String,
    qa_question: String,
    qa_answer: String,
) -> Result<JsVaultInitResult, napi::Error> {
    let config = VaultInitConfig {
        passphrase,
        qa_question,
        qa_answer,
    };

    let result = Vault::init_full(config).map_err(|e| napi::Error::from_reason(e.to_string()))?;

    Ok(JsVaultInitResult::from(result))
}

#[napi(js_name = "vault_store")]
pub fn vault_store(
    vault: JsVault,
    key: String,
    plaintext: Buffer,
) -> Result<JsVaultEntry, napi::Error> {
    let inner = vault.to_inner()?;
    let entry = inner
        .store(&key, &plaintext)
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    Ok(JsVaultEntry::from(entry))
}

#[napi(js_name = "vault_retrieve")]
pub fn vault_retrieve(vault: JsVault, entry: JsVaultEntry) -> Result<Buffer, napi::Error> {
    let inner = vault.to_inner()?;
    let plaintext = inner
        .retrieve(&entry.to_inner()?)
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    Ok(Buffer::from(plaintext))
}
