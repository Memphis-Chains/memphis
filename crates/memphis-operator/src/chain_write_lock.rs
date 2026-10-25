use std::path::Path;
use std::time::Duration;
use rusqlite::Connection;
use sha2::{Digest, Sha256};
use crate::OperatorError;

pub(crate) struct ChainWriteLock(Connection);
impl ChainWriteLock {
    pub(crate) fn acquire(chain: &Path) -> Result<Self, OperatorError> {
        let canonical = std::fs::canonicalize(chain).map_err(|e| OperatorError::Io(e.to_string()))?;
        let parent = canonical.parent().ok_or_else(|| OperatorError::Message("chain has no parent".into()))?;
        let root = if parent.file_name().and_then(|n| n.to_str()) == Some("chains") { parent.parent().unwrap_or(parent) } else { parent };
        let directory = root.join("state").join("chain-locks");
        std::fs::create_dir_all(&directory).map_err(|e| OperatorError::Io(e.to_string()))?;
        let hash = format!("{:x}", Sha256::digest(canonical.to_string_lossy().as_bytes()));
        let path = directory.join(format!("{hash}.sqlite"));
        let connection = Connection::open(&path).map_err(|e| OperatorError::Message(e.to_string()))?;
        #[cfg(unix)] {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&directory, std::fs::Permissions::from_mode(0o700)).map_err(|e| OperatorError::Io(e.to_string()))?;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).map_err(|e| OperatorError::Io(e.to_string()))?;
        }
        connection.busy_timeout(Duration::from_secs(10)).map_err(|e| OperatorError::Message(e.to_string()))?;
        connection.execute_batch("BEGIN IMMEDIATE; PRAGMA user_version = 1;").map_err(|e| OperatorError::Message(e.to_string()))?;
        Ok(Self(connection))
    }
}
impl Drop for ChainWriteLock {
    fn drop(&mut self) { let _ = self.0.execute_batch("ROLLBACK"); }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chain_writer_uses_shared_path_and_releases_on_drop() {
        let root = std::env::temp_dir().join(format!("memphis-native-lock-{}", std::process::id()));
        let chain = root.join("chains").join("journal");
        std::fs::create_dir_all(&chain).unwrap();
        let guard = ChainWriteLock::acquire(&chain).unwrap();
        let canonical = std::fs::canonicalize(&chain).unwrap();
        let hash = format!("{:x}", Sha256::digest(canonical.to_string_lossy().as_bytes()));
        let path = root.join("state").join("chain-locks").join(format!("{hash}.sqlite"));
        let competitor = Connection::open(path).unwrap();
        competitor.busy_timeout(Duration::ZERO).unwrap();
        assert!(competitor.execute_batch("BEGIN IMMEDIATE").is_err());
        drop(guard);
        competitor.execute_batch("BEGIN IMMEDIATE; ROLLBACK").unwrap();
        assert!(std::fs::read_dir(&chain).unwrap().next().is_none());
        drop(competitor);
        std::fs::remove_dir_all(root).unwrap();
    }
}
