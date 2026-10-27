//! Security: String sanitization for TUI rendering
//! Defense against control character and escape sequence injection

/// Strip ANSI escape sequences and control characters
/// Prevents terminal control hijacking in TUI
pub fn sanitize_for_tui(input: &str) -> String {
    let mut result = String::with_capacity(input.len());
    let mut chars = input.chars().peekable();

    while let Some(c) = chars.next() {
        if c == '\x1b' {
            // Skip ANSI escape sequence
            if chars.peek() == Some(&'[') {
                // Consume '[' and skip until we hit a letter (end of CSI sequence).
                chars.next();
                while let Some(&next) = chars.peek() {
                    chars.next();
                    if next.is_ascii_alphabetic() {
                        break;
                    }
                }
            } else if chars.peek() == Some(&']') {
                // OSC sequence - skip until BEL (\x07)
                chars.next(); // consume ']'
                while let Some(&next) = chars.peek() {
                    chars.next();
                    if next == '\x07' {
                        break;
                    }
                }
            }
            // Skip other escape sequences
            continue;
        } else if c.is_control() && c != '\n' && c != '\t' {
            // Remove control characters except newlines and tabs
            continue;
        } else {
            result.push(c);
        }
    }

    // Limit length (DoS prevention)
    result.chars().take(2000).collect()
}

/// Validate provider name (strict allowlist)
pub fn validate_provider_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 50
        && name
            .chars()
            .all(|c| c.is_alphanumeric() || c == '-' || c == '_')
}

/// Sanitize degradation reason for status bar
///
/// The cut lands on a character boundary: a fixed byte offset panicked
/// on a Polish degradation reason, because `ę`, `„` and `”` are more
/// than one byte.
pub fn sanitize_reason(reason: &str) -> String {
    let clean = sanitize_for_tui(reason);
    if clean.len() > 150 {
        memphis_operator::truncate_with_ellipsis(&clean, 147)
    } else {
        clean
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_ansi_sequences() {
        let input = "\x1b[31mRED\x1b[0m";
        assert_eq!(sanitize_for_tui(input), "RED");
    }

    #[test]
    fn removes_control_chars() {
        let input = "foo\x00bar\x07";
        assert_eq!(sanitize_for_tui(input), "foobar");
    }

    #[test]
    fn validates_safe_provider_names() {
        assert!(validate_provider_name("ollama"));
        assert!(validate_provider_name("deepseek-chat"));
        assert!(!validate_provider_name("../../etc/passwd"));
        assert!(!validate_provider_name("foo bar"));
        assert!(!validate_provider_name(&"a".repeat(51)));
    }

    #[test]
    fn truncates_long_reasons() {
        let long = "x".repeat(200);
        let result = sanitize_reason(&long);
        assert!(result.len() <= 150);
        assert!(result.ends_with("..."));
    }

    #[test]
    fn keeps_newlines_and_tabs() {
        let input = "line1\nline2\ttab";
        let result = sanitize_for_tui(input);
        assert_eq!(result, "line1\nline2\ttab");
    }

    #[test]
    fn limits_length_to_2000() {
        let huge = "x".repeat(5000);
        let result = sanitize_for_tui(&huge);
        assert_eq!(result.len(), 2000);
    }

    /// A degradation reason in Polish is longer than 150 bytes and
    /// carries multi-byte characters. The cut has to land on a
    /// character boundary — the same class of bug that killed the chat
    /// worker on 2026-10-27.
    #[test]
    fn sanitizing_a_reason_never_splits_a_character() {
        for offset in 0..300usize {
            let mut reason = "x".repeat(offset);
            reason.push('\u{201e}');
            reason.push_str(&"y".repeat(300));
            let result = sanitize_reason(&reason);
            assert!(
                result.len() <= 150,
                "offset {offset}: result is {} bytes, over the budget",
                result.len()
            );
        }
    }

    #[test]
    fn rejects_invalid_provider_names() {
        assert!(!validate_provider_name(""));
        assert!(!validate_provider_name("foo bar"));
        assert!(!validate_provider_name("foo;bar"));
        assert!(!validate_provider_name("foo|bar"));
        assert!(!validate_provider_name("foo$(whoami)"));
    }
}
