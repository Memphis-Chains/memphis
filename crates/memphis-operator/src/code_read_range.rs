//! The line range of a `memphis_code_read`.
//!
//! The incident of 2026-10-27: the native executor clamped `start`
//! and `end` *independently* and then subtracted them.
//! `end - start` on a caller that asked for `startLine: 3640,
//! endLine: 400` is `400 - 3639` — a `usize` underflow. On a debug
//! build that is a panic, not a wrap, and the panic crossed the chat
//! worker: the whole turn died with `worker panicked: attempt to
//! subtract with overflow`.
//!
//! The TypeScript twin of the same tool (`src/mcp/tools/code-read.ts`)
//! has always validated the range and answered with an error string.
//! The native arm never did. Two layers, one tool, one of them
//! unsafe — so the range now has exactly one validation, here, and
//! both layers speak the same words.
//!
//! The rules:
//!
//! * `startLine` is 1-based and inclusive; `endLine` is 1-based and
//!   inclusive. A range that names an inverted or out-of-file window
//!   is refused with a message that says which bound is wrong.
//! * `limit` is the maximum number of lines returned, capped at 2000.
//!
//! Everything here is arithmetic on caller-supplied numbers, so every
//! operation is saturating: a bad number must produce an error, never
//! a panic — a panic in this arm takes the whole turn down.

/// The resolved line range of a `memphis_code_read`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CodeReadRange {
    /// 0-based, inclusive index of the first line to return.
    pub start: usize,
    /// 0-based, exclusive index of the last line to return.
    pub end: usize,
    /// The maximum number of lines to return.
    pub limit: usize,
}

/// The default and the hard cap on the number of lines one read returns.
pub const CODE_READ_MAX_LINES: usize = 2000;

/// Resolve the caller's line range against the file's real length.
///
/// `start_line` and `end_line` are 1-based and inclusive, as the tool
/// schema says. `None` means "the whole file".
///
/// Returns the range, or a message naming the bound that is wrong.
pub fn resolve_code_read_range(
    total_lines: usize,
    start_line: Option<usize>,
    end_line: Option<usize>,
    limit: Option<usize>,
) -> Result<CodeReadRange, String> {
    let start = match start_line {
        None => 0,
        Some(line) => {
            if line < 1 || line > total_lines {
                return Err(format!(
                    "startLine {line} is out of range (file has {total_lines} lines)"
                ));
            }
            line - 1
        }
    };

    let end = match end_line {
        None => total_lines,
        Some(line) => {
            // `start` is 0-based; the 1-based start line is `start + 1`.
            if line < start + 1 || line > total_lines {
                return Err(format!(
                    "endLine {line} is out of range (file has {total_lines} lines)"
                ));
            }
            line
        }
    };

    let limit = match limit {
        None => CODE_READ_MAX_LINES,
        Some(0) => {
            return Err("limit must be at least 1".to_string());
        }
        Some(value) => value.min(CODE_READ_MAX_LINES),
    };

    Ok(CodeReadRange { start, end, limit })
}

/// The number of lines the range actually covers, before the limit
/// applies. Saturating on purpose: a caller must never be able to
/// make this arithmetic panic.
impl CodeReadRange {
    pub fn span(&self) -> usize {
        self.end.saturating_sub(self.start)
    }

    /// The 0-based, exclusive end index after the limit applies.
    pub fn slice_end(&self) -> usize {
        self.end.min(self.start.saturating_add(self.limit))
    }

    /// Whether the file was cut short, either by the limit or by the
    /// range itself.
    pub fn is_truncated(&self, total_lines: usize) -> bool {
        self.span() > self.limit || total_lines > self.limit
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The incident of 2026-10-27, verbatim: the cockpit asked for
    /// lines 3640..400 of an 8048-line file and the worker died with
    /// `attempt to subtract with overflow`.
    #[test]
    fn the_incident_does_not_panic() {
        let result = resolve_code_read_range(8048, Some(3640), Some(400), Some(120));
        let error = result.expect_err("an inverted range must be refused");
        assert!(
            error.contains("endLine 400") && error.contains("out of range"),
            "the message must name the bound that is wrong: {error}"
        );
    }

    /// Every inverted pair, not just the one that broke. A check that
    /// only holds for the alignment that panicked is a check that
    /// holds for one alignment.
    #[test]
    fn no_inverted_range_panics() {
        for start in 1..=40usize {
            for end in 1..=40usize {
                let _ = resolve_code_read_range(100, Some(start), Some(end), None);
            }
        }
    }

    /// The same sweep with the file shorter than the requested window.
    #[test]
    fn no_out_of_file_range_panics() {
        for start in 1..=40usize {
            for end in 1..=40usize {
                let _ = resolve_code_read_range(3, Some(start), Some(end), None);
            }
        }
    }

    #[test]
    fn a_valid_range_resolves_to_the_requested_window() {
        let range = resolve_code_read_range(8048, Some(3640), Some(3700), None)
            .expect("a valid range must resolve");
        assert_eq!(range.start, 3639);
        assert_eq!(range.end, 3700);
        assert_eq!(range.span(), 61);
        assert_eq!(range.slice_end(), 3700);
    }

    #[test]
    fn a_range_without_bounds_covers_the_whole_file() {
        let range = resolve_code_read_range(42, None, None, None).expect("must resolve");
        assert_eq!(range.start, 0);
        assert_eq!(range.end, 42);
        assert_eq!(range.span(), 42);
    }

    #[test]
    fn the_last_line_of_the_file_can_be_read() {
        let range = resolve_code_read_range(42, Some(42), Some(42), None).expect("must resolve");
        assert_eq!(range.start, 41);
        assert_eq!(range.end, 42);
        assert_eq!(range.span(), 1);
    }

    #[test]
    fn a_start_past_the_end_of_the_file_is_refused() {
        let error = resolve_code_read_range(10, Some(11), None, None)
            .expect_err("a start past the end must be refused");
        assert!(error.contains("startLine 11"), "got: {error}");
    }

    #[test]
    fn an_end_past_the_end_of_the_file_is_refused() {
        let error = resolve_code_read_range(10, Some(1), Some(11), None)
            .expect_err("an end past the end must be refused");
        assert!(error.contains("endLine 11"), "got: {error}");
    }

    #[test]
    fn a_zero_limit_is_refused_rather_than_returning_nothing() {
        let error = resolve_code_read_range(10, None, None, Some(0))
            .expect_err("a zero limit must be refused");
        assert!(error.contains("limit"), "got: {error}");
    }

    #[test]
    fn the_limit_is_capped() {
        let range = resolve_code_read_range(10, None, None, Some(9999)).expect("must resolve");
        assert_eq!(range.limit, CODE_READ_MAX_LINES);
    }

    /// The limit must cut the window, not the window cut the limit.
    #[test]
    fn the_limit_bounds_the_returned_window() {
        let range = resolve_code_read_range(1000, Some(1), Some(1000), Some(10)).expect("must resolve");
        // Lines 1..=1000 inclusive: 1000 lines, not 999.
        assert_eq!(range.span(), 1000);
        assert_eq!(range.slice_end(), 10);
        assert!(range.is_truncated(1000));
    }
}
