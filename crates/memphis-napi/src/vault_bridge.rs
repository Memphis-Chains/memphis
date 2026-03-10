use memphis_vault::{Vault, VaultEntry};
use napi::bindgen_prelude::Buffer;
use napi_derive::napi;

#[napi(object)]
pub struct JsVault {
    pub salt: Buffer,
    pub master_key: Buffer,
}

#[napi(object)]
pub struct JsVaultEntry {
    pub id: String,
    pub key: String,
    pub ciphertext: Buffer,
    pub nonce: Buffer,
    pub tag: Buffer,
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

#[napi]
pub fn vault_init(passphrase: String) -> Result<JsVault, napi::Error> {
    let vault = Vault::init(&passphrase).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    Ok(JsVault::from(vault))
}

#[napi]
pub fn vault_store(vault: JsVault, key: String, plaintext: Buffer) -> Result<JsVaultEntry, napi::Error> {
    let inner = vault.to_inner()?;
    let entry = inner
        .store(&key, &plaintext)
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    Ok(JsVaultEntry::from(entry))
}

#[napi]
pub fn vault_retrieve(vault: JsVault, entry: JsVaultEntry) -> Result<Buffer, napi::Error> {
    let inner = vault.to_inner()?;
    let plaintext = inner
        .retrieve(&entry.to_inner()?)
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    Ok(Buffer::from(plaintext))
}
