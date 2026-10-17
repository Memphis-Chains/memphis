//! Coordinate native snapshots with the TypeScript configuration journal.
use std::{
    fs,
    path::{Path, PathBuf},
    time::Duration,
};

use rusqlite::Connection;

use crate::{OperatorConfig, OperatorError};

pub(super) struct VaultReadGuard(Vec<Connection>);

fn failure() -> OperatorError {
    OperatorError::Vault("unable to acquire the vault configuration lock".into())
}

impl VaultReadGuard {
    pub(super) fn acquire(
        config: &OperatorConfig,
        effective_state: &Path,
    ) -> Result<Self, OperatorError> {
        // New TS intent uses the state journal; older rotations used dotenv.
        // Both surfaces lock the entire set in canonical path order, preserving
        // pending recovery and coordination with either historical journal.
        let mut bases = vec![
            config.vault_state_path.clone(),
            effective_state.to_path_buf(),
        ];
        if let Some(path) = config
            .raw_env
            .get("MEMPHIS_ENV_FILE")
            .map(|p| p.trim())
            .filter(|p| !p.is_empty())
        {
            bases.push(PathBuf::from(path));
        } else if let Some(root) = config
            .raw_env
            .get("MEMPHIS_RUNTIME_ROOT")
            .map(|p| p.trim())
            .filter(|p| !p.is_empty())
        {
            bases.push(PathBuf::from(root).join(".env"));
        }
        let cwd = std::env::current_dir().map_err(|_| failure())?;
        let mut journals = bases
            .into_iter()
            .map(|base| {
                let base = if base.is_absolute() {
                    base
                } else {
                    cwd.join(base)
                };
                let mut directory = base.into_os_string();
                directory.push(".transactions");
                PathBuf::from(directory).join("journal.sqlite")
            })
            .collect::<Vec<_>>();
        if !effective_state.exists()
            && !config.vault_entries_path.exists()
            && !journals.iter().any(|path| path.exists())
        {
            return Ok(Self(Vec::new()));
        }
        // Create empty private journals before resolving aliases, so different
        // spellings of one journal cannot make us acquire our own lock twice.
        for journal in &journals {
            let directory = journal.parent().ok_or_else(failure)?;
            fs::create_dir_all(directory).map_err(|_| failure())?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
                fs::set_permissions(directory, fs::Permissions::from_mode(0o700))
                    .map_err(|_| failure())?;
                fs::OpenOptions::new()
                    .create(true)
                    .append(true)
                    .mode(0o600)
                    .open(journal)
                    .map_err(|_| failure())?;
                fs::set_permissions(journal, fs::Permissions::from_mode(0o600))
                    .map_err(|_| failure())?;
            }
            #[cfg(not(unix))]
            fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(journal)
                .map_err(|_| failure())?;
        }
        journals = journals
            .into_iter()
            .map(fs::canonicalize)
            .collect::<Result<Vec<_>, _>>()
            .map_err(|_| failure())?;
        journals.sort();
        journals.dedup();
        let mut guard = Self(Vec::new());
        for journal in journals {
            let connection = Connection::open(journal).map_err(|_| failure())?;
            connection
                .busy_timeout(Duration::from_secs(10))
                .map_err(|_| failure())?;
            // A shared SQLite read transaction is insufficient: TS generic
            // writers publish files inside BEGIN IMMEDIATE, before DB commit.
            connection
                .execute_batch("BEGIN IMMEDIATE")
                .map_err(|_| failure())?;
            let has_table: bool = connection.query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='transactions')",
                [], |row| row.get(0),
            ).map_err(|_| failure())?;
            if has_table {
                let pending: bool = connection
                    .query_row(
                        "SELECT EXISTS(SELECT 1 FROM transactions WHERE status='prepared')",
                        [],
                        |row| row.get(0),
                    )
                    .map_err(|_| failure())?;
                if pending {
                    return Err(OperatorError::Vault(
                        "pending configuration transaction; restart through the Memphis CLI to recover before retrying".into(),
                    ));
                }
            }
            guard.0.push(connection);
        }
        Ok(guard)
    }
}

impl Drop for VaultReadGuard {
    fn drop(&mut self) {
        for connection in self.0.iter().rev() {
            let _ = connection.execute_batch("ROLLBACK");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> (PathBuf, OperatorConfig) {
        let unique = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "memphis-vault-snapshot-{}-{unique}",
            std::process::id()
        ));
        fs::create_dir_all(&root).unwrap();
        let config = OperatorConfig::from_iter([
            (
                "MEMPHIS_ENV_FILE",
                root.join(".env").to_string_lossy().into_owned(),
            ),
            (
                "MEMPHIS_VAULT_STATE_PATH",
                root.join("vault-state.json").to_string_lossy().into_owned(),
            ),
            (
                "MEMPHIS_VAULT_ENTRIES_PATH",
                root.join("vault-entries.json")
                    .to_string_lossy()
                    .into_owned(),
            ),
        ]);
        (root, config)
    }

    #[test]
    fn locks_configured_and_legacy_journals_and_releases_both() {
        let (root, config) = fixture();
        fs::write(&config.vault_state_path, "{}").unwrap();
        let guard = VaultReadGuard::acquire(&config, &config.vault_state_path).unwrap();
        let competitors = [".env.transactions", "vault-state.json.transactions"].map(|dir| {
            let connection = Connection::open(root.join(dir).join("journal.sqlite")).unwrap();
            connection.busy_timeout(Duration::ZERO).unwrap();
            assert!(connection.execute_batch("BEGIN IMMEDIATE").is_err());
            connection
        });
        drop(guard);
        for connection in competitors {
            connection
                .execute_batch("BEGIN IMMEDIATE; ROLLBACK")
                .unwrap();
        }
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn absent_optional_vault_does_not_create_journals() {
        let (root, config) = fixture();
        let guard = VaultReadGuard::acquire(&config, &config.vault_state_path).unwrap();
        assert!(guard.0.is_empty());
        assert_eq!(fs::read_dir(&root).unwrap().count(), 0);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn duplicate_journal_alias_is_locked_once() {
        let (root, mut config) = fixture();
        fs::write(&config.vault_state_path, "{}").unwrap();
        config.raw_env.insert(
            "MEMPHIS_ENV_FILE".into(),
            config.vault_state_path.to_string_lossy().into_owned(),
        );
        let guard = VaultReadGuard::acquire(&config, &config.vault_state_path).unwrap();
        assert_eq!(guard.0.len(), 1);
        drop(guard);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn blank_explicit_path_uses_trimmed_runtime_root() {
        let (root, mut config) = fixture();
        fs::write(&config.vault_state_path, "{}").unwrap();
        config
            .raw_env
            .insert("MEMPHIS_ENV_FILE".into(), "  ".into());
        config.raw_env.insert(
            "MEMPHIS_RUNTIME_ROOT".into(),
            format!(" {} ", root.display()),
        );
        let guard = VaultReadGuard::acquire(&config, &config.vault_state_path).unwrap();
        let connection = Connection::open(root.join(".env.transactions/journal.sqlite")).unwrap();
        connection.busy_timeout(Duration::ZERO).unwrap();
        assert!(connection.execute_batch("BEGIN IMMEDIATE").is_err());
        drop(guard);
        connection
            .execute_batch("BEGIN IMMEDIATE; ROLLBACK")
            .unwrap();
        drop(connection);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn trimmed_explicit_path_takes_precedence_over_runtime_root() {
        let (root, mut config) = fixture();
        fs::write(&config.vault_state_path, "{}").unwrap();
        config.raw_env.insert(
            "MEMPHIS_ENV_FILE".into(),
            format!(" {} ", root.join("custom.env").display()),
        );
        config
            .raw_env
            .insert("MEMPHIS_RUNTIME_ROOT".into(), root.display().to_string());
        let guard = VaultReadGuard::acquire(&config, &config.vault_state_path).unwrap();
        assert!(!root.join(".env.transactions").exists());
        let connection =
            Connection::open(root.join("custom.env.transactions/journal.sqlite")).unwrap();
        connection.busy_timeout(Duration::ZERO).unwrap();
        assert!(connection.execute_batch("BEGIN IMMEDIATE").is_err());
        drop(guard);
        drop(connection);
        fs::remove_dir_all(root).unwrap();
    }
}
