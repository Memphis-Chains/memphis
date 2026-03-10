pub mod crypto;
pub mod error;
pub mod keyring;
pub mod types;
pub mod vault;

pub use error::VaultError;
pub use keyring::{derive_master_key, generate_salt};
pub use types::{
    VaultConfig, VaultEntry, VaultInitRequest, VaultInitResult, VaultRetrieveRequest,
    VaultRetrieveResult, VaultStoreRequest, VaultStoreResult, VaultValidationError,
};
pub use vault::Vault;
