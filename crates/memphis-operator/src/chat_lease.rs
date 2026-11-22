//! Turn lease — the liveness proof that a `running` checkpoint belongs to a
//! live process.
//!
//! ## Why this exists
//!
//! The operator console had a way to wedge itself permanently, and the
//! mechanism was invisible from the outside:
//!
//! ```text
//! chat.rs:  SELECT EXISTS(SELECT 1 FROM operator_turn_checkpoints
//!                          WHERE session_id=? AND status='running')
//!           if running { return Err("a turn is active or was interrupted
//!                                      unexpectedly; inspect `memphis recovery list`") }
//! ```
//!
//! A turn writes a `running` checkpoint before it starts and marks it
//! finished on the way out. The `RunningCheckpointGuard` marks it
//! `interrupted` when the stack unwinds — but a `SIGKILL`, an OOM kill, a
//! `kill -9` from the operator, or a machine reboot never unwinds the
//! stack. The row stays `running` forever.
//!
//! The session id is fixed (`primary::operator:local`), so that one stale
//! row refused **every** subsequent turn in that session. The operator's
//! reaction — kill the process — created the next stale row. The runtime
//! could not be recovered from inside the runtime.
//!
//! ## The rule
//!
//! A `running` checkpoint is evidence of a live turn only while its owner
//! is alive. The owner is recorded as a *process identity*, not a PID:
//!
//! - `pid` — the process ID,
//! - `boot_id` — the kernel boot identity, which catches PID reuse across
//!   a reboot,
//! - `start_time` — the process start time in clock ticks since boot,
//!   which catches PID reuse within one boot.
//!
//! When the recorded owner is gone, the checkpoint is garbage from a
//! process that no longer exists, and it is reclaimed automatically. The
//! operator does not have to run a recovery command to get their console
//! back.
//!
//! This mirrors `src/infra/runtime/process-lock.ts` exactly, so the two
//! runtimes answer "is that process still the same one?" the same way.

use std::process;

/// The identity of a process, as recorded in a turn checkpoint.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ProcessIdentity {
    pub pid: i32,
    pub boot_id: String,
    pub start_time: u64,
}

/// Read the kernel boot identity.
///
/// Linux exposes it in `/proc/sys/kernel/random/boot_id`; macOS exposes a
/// per-boot session UUID. An empty string means "unavailable" — the
/// identity check then falls back to PID plus start time, which is weaker
/// across a reboot but still correct within one.
fn read_boot_id() -> String {
    #[cfg(target_os = "macos")]
    {
        // `kern.bootsessionuuid` is stable for the lifetime of the boot.
        let output = std::process::Command::new("/usr/sbin/sysctl")
            .args(["-n", "kern.bootsessionuuid"])
            .output();
        return match output {
            Ok(out) if out.status.success() => {
                String::from_utf8_lossy(&out.stdout).trim().to_string()
            }
            _ => String::new(),
        };
    }
    #[cfg(not(target_os = "macos"))]
    {
        std::fs::read_to_string("/proc/sys/kernel/random/boot_id")
            .map(|value| value.trim().to_string())
            .unwrap_or_default()
    }
}

/// Read a process's start time in clock ticks since boot.
///
/// Field 22 of `/proc/<pid>/stat`. The `comm` field may itself contain
/// spaces and parentheses, so the fields after it are located from the
/// LAST `)` in the line rather than by splitting the whole line.
#[cfg(not(target_os = "macos"))]
fn read_process_start_time(pid: i32) -> Option<u64> {
    let raw = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    let close = raw.rfind(')')?;
    // Fields after `comm` start at field 3 (state), so starttime is the
    // 20th field after it (index 19).
    let after_comm: Vec<&str> = raw[close + 1..].split_whitespace().collect();
    after_comm.get(19)?.parse::<u64>().ok()
}

#[cfg(target_os = "macos")]
fn read_process_start_time(pid: i32) -> Option<u64> {
    let output = std::process::Command::new("/bin/ps")
        .args(["-p", &pid.to_string(), "-o", "lstart="])
        .env("LC_ALL", "C")
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout).trim().to_string();
    // `ps` prints an absolute start time. Milliseconds since the epoch are
    // stable across repeated probes of the same process.
    chrono::DateTime::parse_from_rfc2822(&text)
        .ok()
        .map(|value| value.timestamp_millis() as u64)
}

/// The identity of the process running this code.
pub(crate) fn current_identity() -> ProcessIdentity {
    let pid = process::id() as i32;
    ProcessIdentity {
        pid,
        boot_id: read_boot_id(),
        start_time: read_process_start_time(pid).unwrap_or(0),
    }
}

/// Is the recorded owner still the same live process?
///
/// The PID being alive is necessary but NOT sufficient: after a reboot the
/// kernel reuses numbers, and an unrelated process may hold the recorded
/// PID. The boot ID catches that, and the start time catches reuse within
/// one boot.
pub(crate) fn identity_is_alive(identity: &ProcessIdentity) -> bool {
    if identity.pid <= 0 {
        return false;
    }

    // Signal 0 delivers nothing but proves the PID exists and is ours to
    // signal. ESRCH means the process is gone; EPERM means it exists but
    // belongs to another user, which counts as alive.
    let probe = unsafe { libc::kill(identity.pid, 0) };
    if probe != 0 {
        let err = std::io::Error::last_os_error();
        match err.raw_os_error() {
            Some(libc::EPERM) => return true,
            _ => return false,
        }
    }

    // The PID exists. It is still the same process only if the boot and
    // the start time are unchanged.
    if !identity.boot_id.is_empty() {
        let current_boot = read_boot_id();
        if !current_boot.is_empty() && current_boot != identity.boot_id {
            return false;
        }
    }
    if identity.start_time > 0 {
        if let Some(current_start) = read_process_start_time(identity.pid) {
            if current_start != identity.start_time {
                return false;
            }
        }
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_current_process_is_alive() {
        assert!(identity_is_alive(&current_identity()));
    }

    #[test]
    fn a_dead_pid_is_not_alive() {
        // PID 0 is never a real process, and a negative PID is invalid.
        assert!(!identity_is_alive(&ProcessIdentity {
            pid: 0,
            boot_id: String::new(),
            start_time: 0,
        }));
        assert!(!identity_is_alive(&ProcessIdentity {
            pid: -1,
            boot_id: String::new(),
            start_time: 0,
        }));
    }

    #[test]
    fn a_stale_start_time_means_the_pid_was_reused() {
        let mut identity = current_identity();
        identity.start_time = identity.start_time.wrapping_add(1);
        assert!(!identity_is_alive(&identity));
    }

    #[test]
    fn a_foreign_boot_id_means_the_process_died_before_a_reboot() {
        let mut identity = current_identity();
        identity.boot_id = "00000000-0000-0000-0000-000000000000".to_string();
        assert!(!identity_is_alive(&identity));
    }
}
