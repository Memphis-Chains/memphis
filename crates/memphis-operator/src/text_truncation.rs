//! Cutting text without splitting a character.
//!
//! A byte offset is not a character offset. `&text[..157]` panics the
//! moment the text at that position is a multi-byte character — and
//! Polish quotes (`„`, `”`), accented letters and emoji all are. The
//! panic is not exotic: it fires on ordinary prose, in Polish, at any
//! alignment.
//!
//! What makes it expensive is *where* it fires. The 2026-10-27
//! incident was a journal write: the block was appended to the chain
//! first, and the exact-search index was written second — so the panic
//! left the record in the chain and absent from the index, silently
//! unsearchable, with a chat worker dying on the way out.
//!
//! Every truncation in the operator and the TUI goes through this
//! module, so there is one place where the byte budget is enforced and
//! one place where it is tested.

/// Truncate `text` to at most `max_bytes` bytes, never splitting a
/// character.
///
/// The cut lands on the last character boundary at or before
/// `max_bytes`, so the result is always at most `max_bytes` bytes and
/// always valid UTF-8. A character that would have straddled the cut
/// is dropped whole — it costs at most three bytes.
pub fn truncate_on_char_boundary(text: &str, max_bytes: usize) -> &str {
    if text.len() <= max_bytes {
        return text;
    }
    let mut end = max_bytes;
    while end > 0 && !text.is_char_boundary(end) {
        end -= 1;
    }
    &text[..end]
}

/// Truncate `text` to at most `max_bytes` bytes and mark the cut with
/// an ellipsis.
///
/// The ellipsis is *not* counted against the budget: the budget is the
/// number of bytes of content that survive, which is what every caller
/// meant by it.
pub fn truncate_with_ellipsis(text: &str, max_bytes: usize) -> String {
    if text.len() <= max_bytes {
        return text.to_string();
    }
    let mut out = String::with_capacity(max_bytes + 3);
    out.push_str(truncate_on_char_boundary(text, max_bytes));
    out.push_str("...");
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn short_text_is_untouched() {
        assert_eq!(truncate_on_char_boundary("hello", 100), "hello");
        assert_eq!(truncate_with_ellipsis("hello", 100), "hello");
    }

    #[test]
    fn ascii_text_is_cut_exactly() {
        assert_eq!(truncate_on_char_boundary("abcdefghij", 4), "abcd");
        assert_eq!(truncate_with_ellipsis("abcdefghij", 4), "abcd...");
    }

    /// The incident, exactly: a Polish low-9 quote (`„`, three bytes)
    /// sitting at byte 156 with a cut at 157.
    #[test]
    fn a_multibyte_character_at_the_cut_is_dropped_whole() {
        let mut text = "x".repeat(156);
        text.push('„');
        text.push_str(&"y".repeat(50));
        let cut = truncate_on_char_boundary(&text, 157);
        assert_eq!(cut.len(), 156);
        assert!(cut.is_char_boundary(cut.len()));
        assert!(!cut.ends_with('„'));
    }

    /// Every alignment, not just the one that broke. A truncation that
    /// only works for ASCII is a truncation that panics on the first
    /// non-ASCII text it meets.
    #[test]
    fn no_alignment_panics() {
        for offset in 0..400usize {
            let mut text = "x".repeat(offset);
            text.push('„');
            text.push_str(&"y".repeat(400));
            let cut = truncate_on_char_boundary(&text, 157);
            assert!(
                cut.len() <= 157,
                "offset {offset}: cut is {} bytes, over the budget",
                cut.len()
            );
            assert!(cut.is_char_boundary(cut.len()));
        }
    }

    #[test]
    fn four_byte_characters_are_handled_too() {
        let mut text = "x".repeat(155);
        text.push('🦀');
        text.push_str(&"y".repeat(50));
        let cut = truncate_on_char_boundary(&text, 157);
        assert_eq!(cut.len(), 155);
        assert!(!cut.contains('🦀'));
    }
}
