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
///
/// Handles nested `<think>` blocks by tracking depth — a close tag only
/// re-surfaces content once depth returns to zero. Previously the
/// Boolean `inside` flag flipped out of the block on the FIRST close
/// tag seen after nesting, so
/// `<think>outer<think>inner</think>still inside</think>visible`
/// leaked the `still inside</think>visible` tail to the UI. (Codex
/// follow-up on #213.)
pub fn strip_think_blocks(content: &str) -> String {
    let mut out = String::with_capacity(content.len());
    let mut rest = content;
    let mut depth: usize = 0;
    loop {
        if depth == 0 {
            match rest.find(OPEN_TAG) {
                Some(idx) => {
                    out.push_str(&rest[..idx]);
                    rest = &rest[idx + OPEN_TAG.len()..];
                    depth = 1;
                }
                None => {
                    out.push_str(rest);
                    return out;
                }
            }
        } else {
            let next_open = rest.find(OPEN_TAG);
            let next_close = rest.find(CLOSE_TAG);
            match (next_open, next_close) {
                (None, None) => return out, // unclosed — drop tail
                (None, Some(c)) => {
                    depth -= 1;
                    rest = &rest[c + CLOSE_TAG.len()..];
                }
                (Some(o), None) => {
                    depth += 1;
                    rest = &rest[o + OPEN_TAG.len()..];
                }
                (Some(o), Some(c)) if o < c => {
                    depth += 1;
                    rest = &rest[o + OPEN_TAG.len()..];
                }
                (Some(_), Some(c)) => {
                    depth -= 1;
                    rest = &rest[c + CLOSE_TAG.len()..];
                }
            }
        }
    }
}

/// Streaming stripper that preserves chunk boundaries across split tags.
///
/// Typical use:
///
/// ```ignore
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
    /// Nesting depth. 0 means we are outside any `<think>` block and
    /// pass characters through (modulo the split-tag buffer).
    /// Each `<think>` encountered while inside increments; each
    /// `</think>` decrements. The buffer is only released back to the
    /// caller once depth returns to 0.
    depth: usize,
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
            depth: 0,
        }
    }

    /// Feed a chunk, return the portion safe to emit (outside any open
    /// `<think>` block). Content that may be part of a split tag is
    /// retained internally and released on the next `push` or `finalize`.
    pub fn push(&mut self, chunk: &str) -> String {
        self.carry.push_str(chunk);
        let mut output = String::new();
        loop {
            if self.depth > 0 {
                let next_open = self.carry.find(OPEN_TAG);
                let next_close = self.carry.find(CLOSE_TAG);
                match (next_open, next_close) {
                    (None, None) => {
                        // Neither tag fully present; keep enough tail to
                        // match either one across the next chunk. The
                        // longest tag wins because it's the stricter
                        // carry requirement.
                        let keep = OPEN_TAG.len().max(CLOSE_TAG.len()) - 1;
                        retain_tail(&mut self.carry, keep);
                        return output;
                    }
                    (None, Some(c)) => {
                        self.carry.drain(..c + CLOSE_TAG.len());
                        self.depth -= 1;
                    }
                    (Some(o), None) => {
                        self.carry.drain(..o + OPEN_TAG.len());
                        self.depth += 1;
                    }
                    (Some(o), Some(c)) if o < c => {
                        self.carry.drain(..o + OPEN_TAG.len());
                        self.depth += 1;
                    }
                    (Some(_), Some(c)) => {
                        self.carry.drain(..c + CLOSE_TAG.len());
                        self.depth -= 1;
                    }
                }
            } else {
                match self.carry.find(OPEN_TAG) {
                    Some(idx) => {
                        output.push_str(&self.carry[..idx]);
                        self.carry.drain(..idx + OPEN_TAG.len());
                        self.depth = 1;
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
    /// think block. Unclosed block content (depth > 0) is discarded.
    pub fn finalize(self) -> String {
        if self.depth > 0 {
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

    #[test]
    fn strip_think_blocks_handles_nested_blocks() {
        // Outer `<think>` must stay suppressed until its matching
        // `</think>` — the first close tag belongs to the nested
        // inner block. Prior `inside: bool` flipped out on the first
        // close and leaked "still inside</think>visible" to the UI.
        let input = "before <think>outer<think>inner</think>still inside</think>visible";
        assert_eq!(strip_think_blocks(input), "before visible");
    }

    #[test]
    fn think_stripper_handles_nested_blocks_across_chunks() {
        let mut s = ThinkStripper::new();
        let a = s.push("before <think>outer<thi");
        let b = s.push("nk>inner</think>still inside</thi");
        let c = s.push("nk>visible");
        let tail = s.finalize();
        assert_eq!(format!("{a}{b}{c}{tail}"), "before visible");
    }
}
