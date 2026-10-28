//! The path rules of `memphis_code_read`, on the native surface.
//!
//! The TypeScript arm has had these rules since the tool landed. The
//! native arm checked only that the path sat under `~/memphis/`, so a
//! symlink inside the workspace could read any file on the host, and
//! `~/` was expanded everywhere rather than at the front. This module
//! is the native arm's copy of the rules the other arm already had.
//!
//! The order is the same on both sides: resolve, block, contain, read.

use std::path::{Component, Path, PathBuf};

/// The hard cap on the size of the returned content, in characters.
pub const CODE_READ_MAX_CONTENT_CHARS: usize = 500_000;

/// The label of a path segment that is never readable or writable, if
/// it is one.
///
/// The list lives here so the read path and the write path cannot
/// drift apart: the write path used to carry its own copy, whose
/// `node_modules/` pattern never matched a path segment.
pub(crate) fn blocked_segment(segment: &str) -> Option<&'static str> {
    match segment {
        ".env" => Some(".env"),
        "vault-state.json" => Some("vault-state.json"),
        "vault-entries.json" => Some("vault-entries.json"),
        ".git" => Some(".git"),
        "node_modules" => Some("node_modules"),
        _ if segment.starts_with(".env.") => Some(".env.*"),
        _ => None,
    }
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

/// Resolve a path through symlinks; when it does not exist, resolve
/// the nearest existing ancestor and re-append the rest.
fn realpath_nearest(path: &Path) -> PathBuf {
    if let Ok(real) = std::fs::canonicalize(path) {
        return real;
    }
    let mut suffix: Vec<std::ffi::OsString> = Vec::new();
    let mut current = path.to_path_buf();
    loop {
        let name = match current.file_name() {
            Some(name) => name.to_os_string(),
            None => break,
        };
        let parent = match current.parent() {
            Some(parent) if !parent.as_os_str().is_empty() => parent.to_path_buf(),
            _ => break,
        };
        suffix.push(name);
        if let Ok(real) = std::fs::canonicalize(&parent) {
            let mut out = real;
            for part in suffix.iter().rev() {
                out.push(part);
            }
            return out;
        }
        current = parent;
    }
    path.to_path_buf()
}

/// The roots the tool may read from.
fn allowed_roots(home: &Path) -> Vec<PathBuf> {
    vec![home.join("memphis"), home.join(".memphis"), home.join("projects")]
}

/// Refuse a path that leaves the allowed roots, following symlinks to
/// find out where it really points.
pub fn assert_contained(resolved: &Path, home: &Path) -> Result<(), String> {
    let real_target = realpath_nearest(resolved);
    for root in allowed_roots(home) {
        let real_root = std::fs::canonicalize(&root).unwrap_or(root);
        if real_target == real_root || real_target.starts_with(&real_root) {
            return Ok(());
        }
    }
    Err(format!(
        "Path '{}' is outside the allowed read roots: ~/memphis, ~/.memphis, ~/projects",
        resolved.to_string_lossy()
    ))
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
    fn node_modules_is_refused() {
        let path = Path::new("/home/memphis/memphis/node_modules/pkg/index.js");
        let error = assert_not_blocked(path).expect_err("must be refused");
        assert!(error.contains("matches node_modules"), "got: {error}");
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
