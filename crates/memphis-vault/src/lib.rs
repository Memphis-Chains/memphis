pub mod crypto;
pub mod did;
pub mod error;
pub mod keyring;
pub mod two_factor;
pub mod types;
pub mod vault;

pub use did::MemphisDid;
pub use error::VaultError;
pub use keyring::{derive_master_key, derive_master_key_v2, generate_salt, DerivationMeta};
pub use two_factor::{derive_vault_key_with_2fa, derive_vault_key_with_2fa_v2, QAChallenge};
pub use types::{
    VaultConfig, VaultEntry, VaultInitRequest, VaultInitResult as LegacyVaultInitResult,
    VaultRetrieveRequest, VaultRetrieveResult, VaultStoreRequest, VaultStoreResult,
    VaultValidationError,
};
pub use vault::{Vault, VaultInitConfig, VaultInitResult};
