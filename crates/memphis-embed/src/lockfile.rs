//! Stable cross-process advisory lock for the embed index.
//!
//! Every writer of an embed index — the NAPI bridge and the native
//! operator runtime — must hold this lock for the whole
//! `read-current-index → merge → persist` sequence. Without it two
//! processes that loaded the same index snapshot overwrite each other:
//! each holds a stale copy of the index and writes it back whole, so
//! the slower writer silently drops the faster writer's documents.
//!
//! The lock is an OS advisory lock (`flock(2)` on unix) on a dedicated
//! sidecar file. It is never deleted: unlinking the lock file would let
//! a later process create a *different* inode and take a lock that does
//! not exclude the holder of the old one.

use std::fs::{self, File, OpenOptions};
use std::path::{Path, PathBuf};

use crate::error::EmbedError;

/// How long a writer waits for the lock before failing closed.
const LOCK_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);

/// Stable lock path derived from the index path.
///
/// The extension is *replaced* (not appended) so the v1 `.json` path and
/// its v2 `.ndjson` sibling resolve to the SAME lock file. Otherwise a
/// format switch would let two writers hold different locks over the
/// same logical index.
pub fn lock_path_for(index_path: &Path) -> PathBuf {
    index_path.with_extension("lock")
}

/// An exclusive advisory lock over an embed index.
///
/// The lock is released when the guard is dropped (including on the
/// error paths), and the lock file itself is left in place.
///
/// `Debug` is derived so a failed acquisition can be reported with the
/// guard in scope (`expect_err` / `unwrap_err` on a `Result` needs the
/// `Ok` type to be `Debug`).
#[derive(Debug)]
pub struct IndexFileLock {
    #[allow(dead_code)]
    file: File,
}

impl IndexFileLock {
    /// Acquire the exclusive lock for `index_path`.
    ///
    /// The lock file is created if missing and is never removed.
    pub fn acquire(index_path: &Path) -> Result<Self, EmbedError> {
        Self::acquire_with_timeout(index_path, LOCK_TIMEOUT)
    }

    /// Acquire the exclusive lock, waiting at most `timeout`.
    ///
    /// The timeout is a parameter so the contention path can be
    /// exercised synthetically in tests without waiting for the
    /// production timeout.
    pub fn acquire_with_timeout(
        index_path: &Path,
        timeout: std::time::Duration,
    ) -> Result<Self, EmbedError> {
        let path = lock_path_for(index_path);
        if let Some(parent) = path.parent() {
            if !parent.as_os_str().is_empty() {
                fs::create_dir_all(parent).map_err(|error| {
                    EmbedError::DiskError(format!(
                        "index_lock_dir_failed: {}: {error}",
                        parent.display()
                    ))
                })?;
            }
        }

        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(&path)
            .map_err(|error| {
                EmbedError::DiskError(format!(
                    "index_lock_open_failed: {}: {error}",
                    path.display()
                ))
            })?;

        backend::acquire(&file, &path, timeout)?;
        Ok(Self { file })
    }
}

impl Drop for IndexFileLock {
    fn drop(&mut self) {
        backend::release(&self.file);
    }
}

#[cfg(unix)]
mod backend {
    use std::fs::File;
    use std::io;
    use std::os::unix::io::AsRawFd;
    use std::path::Path;
    use std::time::{Duration, Instant};

    use crate::error::EmbedError;

    const LOCK_EX: i32 = 2;
    const LOCK_NB: i32 = 4;
    const LOCK_UN: i32 = 8;

    extern "C" {
        fn flock(fd: i32, operation: i32) -> i32;
    }

    fn try_lock(file: &File) -> Result<bool, EmbedError> {
        // SAFETY: `file` owns a valid descriptor for the duration of the
        // call; `flock` only records a lock on that descriptor.
        let rc = unsafe { flock(file.as_raw_fd(), LOCK_EX | LOCK_NB) };
        if rc == 0 {
            return Ok(true);
        }
        let error = io::Error::last_os_error();
        // `WouldBlock` is the portable spelling of "somebody else holds
        // the lock". The numeric errno is NOT portable — EWOULDBLOCK is
        // 11 on Linux and 35 on macOS — so the error KIND is used and
        // no errno constant is hard-coded anywhere.
        if error.kind() == io::ErrorKind::WouldBlock {
            return Ok(false);
        }
        Err(EmbedError::DiskError(format!("index_lock_failed: {error}")))
    }

    pub(super) fn acquire(file: &File, path: &Path, timeout: Duration) -> Result<(), EmbedError> {
        let deadline = Instant::now() + timeout;
        loop {
            if try_lock(file)? {
                return Ok(());
            }
            if Instant::now() >= deadline {
                return Err(EmbedError::DiskError(format!(
                    "index_lock_timeout: {}",
                    path.display()
                )));
            }
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    pub(super) fn release(file: &File) {
        // SAFETY: the descriptor is still open here — the guard owns it.
        unsafe {
            flock(file.as_raw_fd(), LOCK_UN);
        }
    }
}

#[cfg(not(unix))]
mod backend {
    use std::fs::File;
    use std::path::Path;
    use std::time::Duration;

    use crate::error::EmbedError;

    /// No portable advisory file lock exists off unix. Fail closed: a
    /// writer that cannot take the lock must NOT write the index.
    pub(super) fn acquire(
        _file: &File,
        _path: &Path,
        _timeout: Duration,
    ) -> Result<(), EmbedError> {
        Err(EmbedError::DiskError(
            "index_lock_unsupported: advisory file locking requires a unix host".to_string(),
        ))
    }

    pub(super) fn release(_file: &File) {}
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use std::time::{Duration, Instant};

    fn temp_lock_path(name: &str) -> PathBuf {
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        std::env::temp_dir()
            .join(format!(
                "memphis-embed-lock-{name}-{}-{stamp}",
                std::process::id()
            ))
            .join("index-v1.json")
    }

    /// A second holder of the same lock must NOT get it: the
    /// contention path has to be reachable and must fail closed with a
    /// timeout instead of a raw errno.
    #[test]
    fn second_holder_times_out_instead_of_getting_the_lock() {
        let path = temp_lock_path("contention");
        let _first = IndexFileLock::acquire(&path).expect("first lock");

        let started = Instant::now();
        let error = IndexFileLock::acquire_with_timeout(&path, Duration::from_millis(200))
            .expect_err("the second holder must not get the lock");
        assert!(
            matches!(&error, EmbedError::DiskError(message) if message.contains("index_lock_timeout")),
            "unexpected error: {error:?}"
        );
        assert!(
            started.elapsed() >= Duration::from_millis(150),
            "the second holder must wait for the timeout"
        );
    }

    /// A released lock can be taken again.
    #[test]
    fn lock_is_released_and_reacquirable() {
        let path = temp_lock_path("release");
        {
            let _first = IndexFileLock::acquire(&path).expect("first lock");
        }
        let _second = IndexFileLock::acquire_with_timeout(&path, Duration::from_secs(5))
            .expect("second lock");
    }

    /// A waiting writer gets the lock once the holder releases it.
    #[test]
    fn waiting_writer_acquires_after_the_holder_releases() {
        let path = temp_lock_path("wait");
        let held = Arc::new(IndexFileLock::acquire(&path).expect("first lock"));
        let path_for_thread = path.clone();
        let handle = std::thread::spawn(move || {
            IndexFileLock::acquire_with_timeout(&path_for_thread, Duration::from_secs(5))
        });
        std::thread::sleep(Duration::from_millis(150));
        drop(held);
        let acquired = handle.join().expect("join").expect("second lock");
        drop(acquired);
    }
}
