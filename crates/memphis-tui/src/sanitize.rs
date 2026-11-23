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

/// Strip ANSI escape sequences and control characters from OPERATOR INPUT.
///
/// Why this is separate from `sanitize_for_tui`: that one renders
/// untrusted OUTPUT, so it caps the length at 2000 characters to bound
/// the work it does. Operator input is the opposite — it is the
/// operator's own text, and truncating it would silently change what
/// they asked for. So the input variant removes the escape sequences and
/// keeps the length.
///
/// The bug this fixes (issue #647): pasting text that carries terminal
/// CSI sequences — mouse tracking from xfce4-terminal, browser dev
/// tools, vim's visual mode — pushed the raw escape codes into the
/// input buffer. The operator saw
///
///     [<35;55;5M[<35;85;12M89;18M[<35;120;45M.../mode
///
/// and the intended command was wrapped in garbage. A destructive
/// command can end up truncated or mis-targeted, so this is
/// security-adjacent, not cosmetic.
///
/// Newlines, tabs and every other printable character survive: this
/// removes terminal control sequences, not content.
pub fn sanitize_input(input: &str) -> String {
    let mut result = String::with_capacity(input.len());
    let mut chars = input.chars().peekable();

    while let Some(c) = chars.next() {
        if c == '\x1b' {
            if chars.peek() == Some(&'[') {
                // CSI: consume '[' and skip until the final byte in
                // 0x40..=0x7E. The old renderer stopped at the first
                // ASCII letter, which is right for SGR colour codes
                // but wrong for the cursor-position sequences a paste
                // carries (`[<35;55;5M` ends in 'M').
                chars.next();
                while let Some(&next) = chars.peek() {
                    chars.next();
                    if ('\u{40}'..='\u{7e}').contains(&next) {
                        break;
                    }
                }
            } else if chars.peek() == Some(&']') {
                // OSC: skip until BEL or ST (ESC \).
                chars.next();
                while let Some(&next) = chars.peek() {
                    chars.next();
                    if next == '\u{7}' {
                        break;
                    }
                    if next == '\u{1b}' {
                        // ST — the escape that ends it; drop it too.
                        chars.next();
                        break;
                    }
                }
            }
            // Any other escape sequence: drop the escape and continue.
            continue;
        } else if c.is_control() && c != '\n' && c != '\t' && c != '\r' {
            continue;
        } else {
            result.push(c);
        }
    }

    // Some clipboards deliver the mouse-report sequences with the ESC byte
    // already gone. The operator then sees the leftover text — the issue
    // #647 report shows exactly that: `[<35;55;5M` fragments with an
    // occasional `89;18M` where the escape was dropped.
    //
    // Only a fragment with at least TWO numeric groups is treated as a
    // leftover report. A single number followed by a letter (`29M`) is
    // left alone, because ordinary text can carry that and the cost of
    // eating the operator's own text is higher than the cost of leaving
    // a fragment of garbage.
    strip_orphan_mouse_reports(&result)
}

/// Remove leftover mouse-report fragments: `[` + `n;n` or `n;n;n` + `M`/`m`.
fn strip_orphan_mouse_reports(input: &str) -> String {
    let bytes: Vec<char> = input.chars().collect();
    let mut out = String::with_capacity(input.len());
    let mut i = 0usize;
    // Set when the previous fragment was a leftover report. A run of
    // reports is one paste, so a single-number fragment right after one
    // is part of the same run.
    let mut in_report_run = false;

    while i < bytes.len() {
        let c = bytes[i];
        // The SGR mouse report as a clipboard delivers it: `[<b;x;yM`
        // with the escape byte gone but the bracket left.
        if c == '[' && i + 1 < bytes.len() && bytes[i + 1] == '<' {
            let mut j = i + 2;
            let mut groups = 0usize;
            loop {
                let start = j;
                while j < bytes.len() && bytes[j].is_ascii_digit() {
                    j += 1;
                }
                if j == start {
                    break;
                }
                groups += 1;
                if j < bytes.len() && bytes[j] == ';' {
                    j += 1;
                    continue;
                }
                break;
            }
            if groups >= 2 && j < bytes.len() && (bytes[j] == 'M' || bytes[j] == 'm') {
                in_report_run = true;
                i = j + 1;
                continue;
            }
        }
        if c.is_ascii_digit() {
            // Read the numeric groups.
            let mut j = i;
            let mut groups = 0usize;
            loop {
                let start = j;
                while j < bytes.len() && bytes[j].is_ascii_digit() {
                    j += 1;
                }
                if j == start {
                    break;
                }
                groups += 1;
                if j < bytes.len() && bytes[j] == ';' {
                    j += 1;
                    continue;
                }
                break;
            }
            let ends_with_marker = j < bytes.len() && (bytes[j] == 'M' || bytes[j] == 'm');
            // Two or more groups is a report on its own. A single group
            // counts only directly after another report — so `29M` in
            // the middle of a paste of reports goes, while `29MB` in
            // ordinary text stays.
            let is_report = ends_with_marker && (groups >= 2 || in_report_run);
            if is_report {
                in_report_run = true;
                i = j + 1;
                continue;
            }
            in_report_run = false;
            out.push(c);
            i += 1;
            continue;
        }
        if !c.is_ascii_digit() {
            // Any other character ends the run of reports.
            in_report_run = false;
        }
        out.push(c);
        i += 1;
    }

    out
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
    fn input_drops_the_cursor_sequences_a_paste_carries() {
        // The exact shape from issue #647: xfce4-terminal's mouse
        // tracking wraps the operator's command in CSI sequences.
        //
        // The issue shows the string WITHOUT the ESC bytes — copying it
        // out of the buffer into a GitHub issue dropped them, and ESC
        // renders as nothing on screen. Three of the fragments lost
        // their '[' as well, so the clipboard delivered those without
        // any escape at all. Both forms are checked.
        let with_esc = "\x1b[<35;55;5M\x1b[<35;85;12M\x1b[89;18M\x1b[<35;120;45M\x1b[<35;120;45M\x1b[5;120;46M\x1b[<35;118;47M\x1b[<35;120;47M\x1b[29M/mode";
        assert_eq!(sanitize_input(with_esc), "/mode");

        // What the issue shows: the escape bytes are gone.
        let as_reported = "[<35;55;5M[<35;85;12M89;18M[<35;120;45M[<35;120;45M5;120;46M[<35;118;47M[<35;120;47M29M/mode";
        assert_eq!(sanitize_input(as_reported), "/mode");
    }

    #[test]
    fn input_keeps_ordinary_numbers_that_look_like_a_report() {
        // A single number followed by a letter is ordinary text unless it
        // directly follows a report — the operator's own text must not
        // be eaten.
        assert_eq!(sanitize_input("29MB dysk"), "29MB dysk");
        assert_eq!(sanitize_input("wariant 12;34;56"), "wariant 12;34;56");
        // But a run of reports takes its single-number tail with it.
        assert_eq!(sanitize_input("[<35;120;47M29M/mode"), "/mode");
    }

    #[test]
    fn input_keeps_the_text_around_the_sequences() {
        assert_eq!(sanitize_input("haslo\x1b[<35;55;5M"), "haslo");
        assert_eq!(sanitize_input("\x1b[<35;85;12Mhaslo"), "haslo");
        assert_eq!(sanitize_input("a\x1b[31mb\x1b[0mc"), "abc");
    }

    #[test]
    fn input_drops_osc_sequences() {
        // OSC 0 sets the window title; it ends with BEL or ST.
        assert_eq!(sanitize_input("\x1b]0;title\x07text"), "text");
        assert_eq!(sanitize_input("\x1b]0;title\x1b\\text"), "text");
    }

    #[test]
    fn input_keeps_newlines_tabs_and_carriage_returns() {
        assert_eq!(sanitize_input("a\nb\tc\rd"), "a\nb\tc\rd");
    }

    #[test]
    fn input_does_not_truncate_the_operators_text() {
        // The OUTPUT renderer caps at 2000 characters. Operator input is
        // the operator's own text — truncating it would silently change
        // what they asked for.
        let long = "x".repeat(5000);
        assert_eq!(sanitize_input(&long).len(), 5000);
    }

    #[test]
    fn input_keeps_multibyte_characters_intact() {
        assert_eq!(sanitize_input("zażółć gęślą jaźń"), "zażółć gęślą jaźń");
        assert_eq!(sanitize_input("\x1b[31m日本語\x1b[0m"), "日本語");
    }

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
