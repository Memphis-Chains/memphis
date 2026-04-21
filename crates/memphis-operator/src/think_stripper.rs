//! Strip `<think>…</think>` reasoning blocks from model output.
//!
//! Reasoning-style models (MiniMax-M2.7, Qwen QwQ, DeepSeek-R1 and many
//! distilled derivatives) embed their chain-of-thought in literal
//! `<think>` XML-ish tags and expect the front-end to hide them before
//! rendering to the end user. Memphis didn't strip them, so Marcin saw
//! the model's internal deliberation scrolling across the TUI as plain
//! text — distracting at best, confusing at worst.
//!
//! This module provides two surfaces:
//!
//! - [`strip_think_blocks`] — one-shot for the non-streaming path,
//!   takes a full response string, returns the cleaned string.
//! - [`ThinkStripper`] — streaming state machine that handles chunk
//!   boundaries that fall mid-tag (e.g. `"<thi"` + `"nk>…"`), dropping
//!   everything between `<think>` and `</think>` while still passing
//!   surrounding text through in-order.
//!
//! An unclosed `<think>` at stream end is discarded — safer than leaking
//! half of the model's private reasoning.

const OPEN_TAG: &str = "<think>";
const CLOSE_TAG: &str = "</think>";

/// Remove every `<think>…</think>` pair from `content`. Unclosed `<think>`
/// tags swallow everything from the open tag to the end of the string.
pub fn strip_think_blocks(content: &str) -> String {
    let mut out = String::with_capacity(content.len());
    let mut rest = content;
    while let Some(open_at) = rest.find(OPEN_TAG) {
        out.push_str(&rest[..open_at]);
        let after_open = &rest[open_at + OPEN_TAG.len()..];
        match after_open.find(CLOSE_TAG) {
            Some(close_at) => {
                rest = &after_open[close_at + CLOSE_TAG.len()..];
            }
            None => return out, // unclosed — drop tail
        }
    }
    out.push_str(rest);
    out
}

/// Streaming stripper that preserves chunk boundaries across split tags.
///
/// Typical use:
///
/// ```
/// let mut stripper = ThinkStripper::new();
/// for chunk in chunks {
///     let emit = stripper.push(chunk);
///     if !emit.is_empty() { send(&emit); }
/// }
/// let tail = stripper.finalize();
/// if !tail.is_empty() { send(&tail); }
/// ```
pub struct ThinkStripper {
    carry: String,
    inside: bool,
}

impl Default for ThinkStripper {
    fn default() -> Self {
        Self::new()
    }
}

impl ThinkStripper {
    pub fn new() -> Self {
        Self {
            carry: String::new(),
            inside: false,
        }
    }

    /// Feed a chunk, return the portion safe to emit (outside any open
    /// `<think>` block). Content that may be part of a split tag is
    /// retained internally and released on the next `push` or `finalize`.
    pub fn push(&mut self, chunk: &str) -> String {
        self.carry.push_str(chunk);
        let mut output = String::new();
        loop {
            if self.inside {
                match self.carry.find(CLOSE_TAG) {
                    Some(idx) => {
                        self.carry.drain(..idx + CLOSE_TAG.len());
                        self.inside = false;
                        // Loop: another block or plain text may follow.
                    }
                    None => {
                        // Keep only the tail that might still match CLOSE_TAG
                        // across the next chunk.
                        retain_tail(&mut self.carry, CLOSE_TAG.len() - 1);
                        return output;
                    }
                }
            } else {
                match self.carry.find(OPEN_TAG) {
                    Some(idx) => {
                        output.push_str(&self.carry[..idx]);
                        self.carry.drain(..idx + OPEN_TAG.len());
                        self.inside = true;
                    }
                    None => {
                        // Flush everything except a tail that might still
                        // complete OPEN_TAG across the next chunk.
                        let tail_keep = OPEN_TAG.len() - 1;
                        if self.carry.len() > tail_keep {
                            let split = safe_boundary(&self.carry, self.carry.len() - tail_keep);
                            output.push_str(&self.carry[..split]);
                            self.carry.drain(..split);
                        }
                        return output;
                    }
                }
            }
        }
    }

    /// Flush remaining text. Returns anything carried that is outside a
    /// think block. Unclosed block content is discarded.
    pub fn finalize(self) -> String {
        if self.inside {
            String::new()
        } else {
            self.carry
        }
    }
}

fn retain_tail(s: &mut String, tail_bytes: usize) {
    if s.len() <= tail_bytes {
        return;
    }
    let split = safe_boundary(s, s.len() - tail_bytes);
    s.drain(..split);
}

fn safe_boundary(s: &str, desired: usize) -> usize {
    let mut idx = desired.min(s.len());
    while idx < s.len() && !s.is_char_boundary(idx) {
        idx += 1;
    }
    idx
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strip_think_blocks_removes_single_block() {
        let input = "before <think>inner</think> after";
        assert_eq!(strip_think_blocks(input), "before  after");
    }

    #[test]
    fn strip_think_blocks_handles_multiple_blocks() {
        let input = "a<think>1</think>b<think>2</think>c";
        assert_eq!(strip_think_blocks(input), "abc");
    }

    #[test]
    fn strip_think_blocks_drops_unclosed_tail() {
        let input = "visible <think>hidden";
        assert_eq!(strip_think_blocks(input), "visible ");
    }

    #[test]
    fn strip_think_blocks_preserves_content_without_tags() {
        let input = "plain text answer with <other> tags";
        assert_eq!(strip_think_blocks(input), input);
    }

    #[test]
    fn think_stripper_preserves_whole_chunks_of_plain_text() {
        let mut s = ThinkStripper::new();
        let out = s.push("hello world");
        let tail = s.finalize();
        assert_eq!(format!("{out}{tail}"), "hello world");
    }

    #[test]
    fn think_stripper_removes_block_fully_inside_one_chunk() {
        let mut s = ThinkStripper::new();
        let out = s.push("a<think>b</think>c");
        let tail = s.finalize();
        assert_eq!(format!("{out}{tail}"), "ac");
    }

    #[test]
    fn think_stripper_handles_open_tag_split_across_chunks() {
        let mut s = ThinkStripper::new();
        let a = s.push("visible <thi");
        let b = s.push("nk>hidden</think> more");
        let tail = s.finalize();
        assert_eq!(format!("{a}{b}{tail}"), "visible  more");
    }

    #[test]
    fn think_stripper_handles_close_tag_split_across_chunks() {
        let mut s = ThinkStripper::new();
        let a = s.push("pre <think>reasoning</th");
        let b = s.push("ink>post");
        let tail = s.finalize();
        assert_eq!(format!("{a}{b}{tail}"), "pre post");
    }

    #[test]
    fn think_stripper_drops_unclosed_block_on_finalize() {
        let mut s = ThinkStripper::new();
        let a = s.push("visible <think>lost");
        let tail = s.finalize();
        assert_eq!(format!("{a}{tail}"), "visible ");
    }

    #[test]
    fn think_stripper_handles_multiple_blocks_across_chunks() {
        let mut s = ThinkStripper::new();
        let a = s.push("a<think>1</think>b<thi");
        let b = s.push("nk>2</think>c");
        let tail = s.finalize();
        assert_eq!(format!("{a}{b}{tail}"), "abc");
    }

    #[test]
    fn think_stripper_preserves_utf8_across_chunk_boundary() {
        // Polish text surrounded by blocks; make sure nothing corrupts
        // multi-byte chars through the tail-keep logic.
        let mut s = ThinkStripper::new();
        let a = s.push("Języki: <think>hidden</think> żółć");
        let tail = s.finalize();
        assert_eq!(format!("{a}{tail}"), "Języki:  żółć");
    }
}
