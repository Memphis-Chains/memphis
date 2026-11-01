//! The path rules of the read tools, on the native surface.
//!
//! The scope is the TIER (2, vault passphrase), not a whitelist of
//! directories: `memphis_exec` at the same tier could `cat` any file on
//! the host, so a directory whitelist protected nothing — it only made the
//! tool refuse work the operator asked for. The operator asked for
//! "Memphis must be able to read everything on this computer", so the
//! whitelist is gone and `MEMPHIS_CODE_READ_ROOTS` is the way to narrow it
//! back down.
//!
//! Vault material (`.env`, `.env.*`, `vault-state.json`,
//! `vault-entries.json`) is still refused on the READ path, because the
//! output of these tools is indexed: it lands in the journal and in the
//! semantic embed index, i.e. a plaintext copy of a secret outside the
//! encrypted vault.
//!
//! The WRITE path is stricter: it refuses vault material, `.git/` and
//! `node_modules/`, and stays inside `~/memphis/`. Writing into a `.git`
//! directory corrupts the source of truth; reading it does not.
//!
//! The order is the same on both sides: resolve, block, contain, read.

use std::path::{Component, Path, PathBuf};

/// The path segments whose CONTENT is vault material.
fn secret_material_segment(segment: &str) -> Option<&'static str> {
    match segment {
        ".env" => Some(".env"),
        "vault-state.json" => Some("vault-state.json"),
        "vault-entries.json" => Some("vault-entries.json"),
        _ if segment.starts_with(".env.") => Some(".env.*"),
        _ => None,
    }
}

/// The path segments the WRITE path additionally refuses.
fn write_blocked_segment(segment: &str) -> Option<&'static str> {
    match segment {
        ".git" => Some(".git"),
        "node_modules" => Some("node_modules"),
        _ => secret_material_segment(segment),
    }
}

/// The hard cap on the size of the returned content, in characters.
pub const CODE_READ_MAX_CONTENT_CHARS: usize = 500_000;

/// The label of a path segment that is never readable, if it is one.
///
/// The list lives here so the read path and the write path cannot
/// drift apart: the write path used to carry its own copy, whose
/// `node_modules/` pattern never matched a path segment.
pub(crate) fn blocked_segment(segment: &str) -> Option<&'static str> {
    secret_material_segment(segment)
}

/// The label of a path segment the WRITE path refuses, if it is one.
pub(crate) fn write_blocked_segment_label(segment: &str) -> Option<&'static str> {
    write_blocked_segment(segment)
}

/// Resolve a caller-supplied path.
///
/// `~/x` expands against `$HOME`, a relative path resolves against the
/// workspace root, and a `~` that is not at the front is a literal
/// character — the old arm replaced every `~/` in the string, so
/// `/tmp/~/x` became `/tmp/$HOME/x`.
pub fn resolve_path(input: &str, home: &Path) -> PathBuf {
    let raw = if let Some(rest) = input.strip_prefix("~/") {
        home.join(rest)
    } else if input.starts_with('~') {
        PathBuf::from(input)
    } else {
        let candidate = Path::new(input);
        if candidate.is_absolute() {
            candidate.to_path_buf()
        } else {
            home.join("memphis").join(candidate)
        }
    };
    let mut out = PathBuf::new();
    for component in raw.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// The refusal message for a blocked path. The same words in both arms.
pub(crate) fn blocked_path_message(path: &str, label: &str) -> String {
    format!(
        "Path '{path}' is blocked because it matches {label} and may contain secrets or generated state"
    )
}

/// Refuse a path that names secret material or generated state.
pub fn assert_not_blocked(resolved: &Path) -> Result<(), String> {
    for segment in resolved.to_string_lossy().split('/') {
        if segment.is_empty() || segment == "." {
            continue;
        }
        if let Some(label) = blocked_segment(segment) {
            return Err(blocked_path_message(&resolved.to_string_lossy(), label));
        }
    }
    Ok(())
}

/// The roots the read tools may look at.
///
/// Empty by default: the whole host is readable. `MEMPHIS_CODE_READ_ROOTS`
/// is a comma-separated list and becomes the complete allowlist — the way
/// back to a narrower setup.
pub fn read_roots() -> Vec<PathBuf> {
    let raw = std::env::var("MEMPHIS_CODE_READ_ROOTS").unwrap_or_default();
    raw.split(',')
        .map(str::trim)
        .filter(|item| !item.is_empty())
        .map(|item| {
            let expanded = match item.strip_prefix("~/") {
                Some(rest) => {
                    let home = std::env::var("HOME").unwrap_or_else(|_| "/home/memphis".to_string());
                    Path::new(&home).join(rest)
                }
                None => PathBuf::from(item),
            };
            expanded
        })
        .collect()
}

/// Refuse a path outside the configured read roots.
///
/// With no roots configured (the default) every path on the host is
/// readable, so this never refuses. It exists so an operator who sets
/// `MEMPHIS_CODE_READ_ROOTS` gets a real boundary, and so both arms
/// refuse the same paths in the same words.
pub fn assert_within_read_roots(resolved: &Path) -> Result<(), String> {
    assert_within_roots(resolved, &read_roots())
}

/// The pure form: the roots are passed in, so the check can be tested
/// without touching the process environment.
///
/// The process environment is global and the tests of one binary run in
/// parallel: a test that set `MEMPHIS_CODE_READ_ROOTS` would change the
/// behaviour of every other test running at that moment.
pub fn assert_within_roots(resolved: &Path, roots: &[PathBuf]) -> Result<(), String> {
    if roots.is_empty() {
        return Ok(());
    }
    let normalized = resolved.to_string_lossy().to_string();
    for root in roots {
        let root_str = root.to_string_lossy().to_string();
        if normalized == root_str
            || normalized
                .strip_prefix(&root_str)
                .is_some_and(|rest| rest.starts_with('/'))
        {
            return Ok(());
        }
    }
    Err(format!(
        "Path '{}' is outside the allowed read roots: {}",
        resolved.to_string_lossy(),
        roots
            .iter()
            .map(|root| root.to_string_lossy().to_string())
            .collect::<Vec<String>>()
            .join(", ")
    ))
}

/// Refuse a path that names vault material OR a segment the write path
/// refuses (`.git/`, `node_modules/`).
///
/// The read path and the write path used to share one list, which meant
/// reading `.git/` was refused too — a directory whitelist protecting
/// nothing while making the tool refuse work the operator asked for. The
/// two lists are separate now: reading `.git/` is fine, writing into it
/// is not.
pub fn assert_not_write_blocked(resolved: &Path) -> Result<(), String> {
    for segment in resolved.to_string_lossy().split('/') {
        if segment.is_empty() || segment == "." {
            continue;
        }
        if let Some(label) = write_blocked_segment_label(segment) {
            return Err(blocked_path_message(&resolved.to_string_lossy(), label));
        }
    }
    Ok(())
}

/// The write path may only touch files inside ~/memphis/.
///
/// The read path is allowed the wider set of roots in `allowed_roots`, so
/// the write path needs a check of its own: the target must resolve --
/// through symlinks -- to a path inside ~/memphis. Without the
/// resolution a symlink inside the workspace was a door out of it, and
/// the native `memphis_self_modify` wrote through it.
pub fn assert_write_contained(resolved: &Path, home: &Path) -> Result<(), String> {
    let root = home.join("memphis");
    let real_root = std::fs::canonicalize(&root).unwrap_or(root);
    let real_target = realpath_resolving_links(resolved, 0);
    if real_target == real_root || real_target.starts_with(&real_root) {
        return Ok(());
    }
    Err(format!(
        "Path '{}' resolves outside ~/memphis/ and must not be written",
        resolved.to_string_lossy()
    ))
}

/// Resolve a path through symlinks even when the target does not exist.
///
/// `std::fs::canonicalize` fails when the last component does not exist,
/// and resolving the nearest EXISTING ancestor -- so a symlink to a file
/// that is about to be written (the create-new case) resolved to ITSELF.
/// A link out of the workspace was therefore invisible to the write path,
/// and the write went through it.
///
/// The walk follows every component that is a link, at any depth, and
/// stops at 40 hops like the kernel does for a link loop.
fn realpath_resolving_links(path: &Path, depth: usize) -> PathBuf {
    if depth > 40 {
        return path.to_path_buf();
    }
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::RootDir => out.push("/"),
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            Component::Prefix(prefix) => out.push(prefix.as_os_str()),
            Component::Normal(part) => {
                out.push(part);
                if let Ok(target) = std::fs::read_link(&out) {
                    let target = if target.is_absolute() {
                        target
                    } else {
                        match out.parent() {
                            Some(parent) => parent.join(target),
                            None => target,
                        }
                    };
                    out = realpath_resolving_links(&target, depth + 1);
                }
            }
        }
    }
    out
}

/// Split file content into lines.
///
/// A line terminator is not part of the line: `\n` and `\r\n` both end
/// a line, and a trailing newline does not add an empty line. The
/// TypeScript arm counted the trailing empty line (so a three-line file
/// was four lines) and kept the carriage return.
pub fn split_lines(content: &str) -> Vec<&str> {
    if content.is_empty() {
        return Vec::new();
    }
    let mut lines: Vec<&str> = content.split('\n').collect();
    if lines.last() == Some(&"") {
        lines.pop();
    }
    lines
        .into_iter()
        .map(|line| line.strip_suffix('\r').unwrap_or(line))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_tilde_in_the_middle_is_literal() {
        let home = Path::new("/home/memphis");
        assert_eq!(resolve_path("/tmp/~/x", home), PathBuf::from("/tmp/~/x"));
        assert_eq!(
            resolve_path("~/memphis/src", home),
            PathBuf::from("/home/memphis/memphis/src")
        );
    }

    #[test]
    fn a_relative_path_resolves_against_the_workspace_root() {
        let home = Path::new("/home/memphis");
        assert_eq!(
            resolve_path("src/index.ts", home),
            PathBuf::from("/home/memphis/memphis/src/index.ts")
        );
    }

    #[test]
    fn vault_material_is_refused_on_the_read_path() {
        for name in [".env", ".env.production", "vault-state.json", "vault-entries.json"] {
            let path = Path::new("/home/memphis/somewhere").join(name);
            let error = assert_not_blocked(&path).expect_err("must be refused");
            assert!(error.contains("blocked because it matches"), "got: {error}");
        }
    }

    #[test]
    fn node_modules_is_readable_but_not_writable() {
        // Generated state, not a secret: reading it is harmless, writing
        // into it is not.
        let path = Path::new("/home/memphis/memphis/node_modules/pkg/index.js");
        assert!(assert_not_blocked(path).is_ok(), "the read path must allow it");
        let error = assert_not_write_blocked(path).expect_err("the write path must refuse it");
        assert!(error.contains("matches node_modules"), "got: {error}");
    }

    #[test]
    fn the_git_directory_is_readable_but_not_writable() {
        let path = Path::new("/home/memphis/memphis/.git/config");
        assert!(assert_not_blocked(path).is_ok(), "the read path must allow it");
        let error = assert_not_write_blocked(path).expect_err("the write path must refuse it");
        assert!(error.contains("matches .git"), "got: {error}");
    }

    #[test]
    fn every_path_on_the_host_is_readable_when_no_roots_are_configured() {
        // The scope is the tier, not a whitelist: `memphis_exec` at the
        // same tier could read any file anyway.
        let path = Path::new("/etc/hostname");
        assert!(assert_within_roots(path, &[]).is_ok());
    }

    #[test]
    fn a_path_outside_the_configured_roots_is_refused() {
        let path = Path::new("/etc/hostname");
        let roots = vec![PathBuf::from("/home/memphis/memphis")];
        let error = assert_within_roots(path, &roots).expect_err("must be refused");
        assert!(error.contains("outside the allowed read roots"), "got: {error}");
    }

    #[test]
    fn a_path_inside_a_configured_root_is_readable() {
        let path = Path::new("/home/memphis/memphis/src/index.ts");
        let roots = vec![PathBuf::from("/home/memphis/memphis")];
        assert!(assert_within_roots(path, &roots).is_ok());
    }

    #[test]
    fn a_trailing_newline_does_not_add_a_line() {
        assert_eq!(split_lines("alpha\nbeta\n").len(), 2);
        assert_eq!(split_lines("alpha\nbeta").len(), 2);
        assert_eq!(split_lines("").len(), 0);
    }

    #[test]
    fn a_carriage_return_goes_with_its_terminator() {
        assert_eq!(split_lines("alpha\r\nbeta\r\n"), vec!["alpha", "beta"]);
    }
}
