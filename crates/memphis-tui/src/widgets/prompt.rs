//! The operator's input line.
//!
//! Two defects this widget exists to fix (ADR-011, E1/E2):
//!
//! 1. The caret was never rendered — `Hide` on enter, `Show` on exit,
//!    and `set_cursor_position` appeared nowhere in the crate. The
//!    operator could not see where the insertion point was.
//! 2. The prompt was a single row (`Constraint::Length(1)`), so a long
//!    prompt was silently truncated with no horizontal scroll and no
//!    way to write a multi-line message by hand.
//!
//! The layout is computed here as data (rows + caret position) so the
//! renderer can size the prompt area *before* laying out the frame —
//! and so the caret position is exact rather than estimated.

use ratatui::{
    buffer::Buffer,
    layout::Rect,
    style::{Color, Modifier, Style},
    text::{Line, Span},
    widgets::{Paragraph, StatefulWidget, Widget},
};

use crate::sanitize::sanitize_for_tui;

/// Maximum number of visual rows the prompt may occupy. Past this the
/// prompt scrolls and keeps the caret visible — the operator still sees
/// where they are typing, and the body gives up the rows.
pub const MAX_PROMPT_ROWS: usize = 8;

const PROMPT_PREFIX: &str = "> ";
const PROMPT_INDENT: &str = "  ";
const PROMPT_PREFIX_WIDTH: usize = 2;
/// One column is reserved for the caret itself: it sits *after* the
/// last typed character, so a completely full row would otherwise put
/// it one column past the area (terminals clamp that onto the final
/// character, which draws the caret on top of the text).
const PROMPT_CARET_RESERVE: usize = 1;

/// One visual row of the prompt.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PromptRow {
    /// Row text, without the prefix.
    pub text: String,
    /// `true` only for the very first row — the one carrying the `> ` marker.
    pub is_first: bool,
}

/// The prompt's visual layout: rows plus the caret's position in them.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PromptLayout {
    pub rows: Vec<PromptRow>,
    /// Index of the visual row that holds the caret.
    pub caret_row: usize,
    /// Column of the caret inside its row, prefix included.
    pub caret_col: usize,
}

/// Clamp a byte index into `value` onto a char boundary.
fn floor_char_boundary(value: &str, mut index: usize) -> usize {
    if index > value.len() {
        index = value.len();
    }
    while index > 0 && !value.is_char_boundary(index) {
        index -= 1;
    }
    index
}

/// Character index of the caret inside the *sanitized* text.
///
/// The caret is a byte offset into the raw input, but rendering uses the
/// sanitized text (ANSI escapes and control characters are stripped). So
/// the caret is mapped by sanitizing the prefix and counting what
/// survives — the same sanitization the renderer applies, which keeps
/// the caret aligned even when the operator pastes escape sequences.
fn caret_char_index(input: &str, cursor: usize, safe: &str) -> usize {
    let cursor = floor_char_boundary(input, cursor);
    let prefix_chars = sanitize_for_tui(&input[..cursor]).chars().count();
    prefix_chars.min(safe.chars().count())
}

/// Compute the prompt's visual layout for a given width.
///
/// The input is hard-wrapped (never word-wrapped): an editor that
/// re-flowed words under the caret would move the insertion point while
/// the operator is typing, which is worse than a hard break.
pub fn prompt_layout(input: &str, cursor: usize, width: u16) -> PromptLayout {
    let text_width = (width as usize)
        .saturating_sub(PROMPT_PREFIX_WIDTH + PROMPT_CARET_RESERVE)
        .max(1);
    let safe = sanitize_for_tui(input);
    let caret_index = caret_char_index(input, cursor, &safe);
    let chars: Vec<char> = safe.chars().collect();

    let mut rows: Vec<PromptRow> = Vec::new();
    let mut caret_row = 0usize;
    let mut caret_col = PROMPT_PREFIX_WIDTH;
    let mut caret_assigned = false;

    let mut line_start = 0usize;
    let mut is_first_line = true;
    loop {
        let line_end = chars[line_start..]
            .iter()
            .position(|c| *c == '\n')
            .map(|offset| line_start + offset)
            .unwrap_or(chars.len());
        let line_len = line_end - line_start;
        let row_count = line_len.div_ceil(text_width).max(1);

        for row in 0..row_count {
            let row_start = line_start + row * text_width;
            let row_end = (row_start + text_width).min(line_end);
            let text: String = chars[row_start..row_end].iter().collect();
            rows.push(PromptRow {
                text,
                is_first: is_first_line && row == 0,
            });

            // The caret belongs to the first row that covers it. The
            // last row of a logical line also covers its end position,
            // so a caret parked at the end of a line renders there and
            // not on the next line.
            let is_last_row = row + 1 == row_count;
            let covers = caret_index >= row_start
                && (caret_index < row_end || (is_last_row && caret_index == row_end));
            if covers && !caret_assigned {
                caret_assigned = true;
                caret_row = rows.len() - 1;
                caret_col = PROMPT_PREFIX_WIDTH + (caret_index - row_start);
            }
        }

        if line_end >= chars.len() {
            break;
        }
        line_start = line_end + 1;
        is_first_line = false;
    }

    if rows.is_empty() {
        rows.push(PromptRow {
            text: String::new(),
            is_first: true,
        });
    }
    if !caret_assigned {
        caret_row = rows.len() - 1;
        caret_col = PROMPT_PREFIX_WIDTH
            + rows
                .last()
                .map(|row| row.text.chars().count())
                .unwrap_or(0);
    }

    PromptLayout {
        rows,
        caret_row,
        caret_col,
    }
}

/// View state for the prompt: how far it scrolled, and where the caret ended up.
#[derive(Debug, Default)]
pub struct PromptState {
    /// Index of the first visible visual row.
    pub scroll: usize,
    /// Absolute caret position on screen, set by the last render.
    pub caret: Option<(u16, u16)>,
}

/// Renders a pre-computed prompt layout.
pub struct PromptWidget<'a> {
    layout: &'a PromptLayout,
}

impl<'a> PromptWidget<'a> {
    pub fn new(layout: &'a PromptLayout) -> Self {
        Self { layout }
    }
}

impl StatefulWidget for PromptWidget<'_> {
    type State = PromptState;

    fn render(self, area: Rect, buf: &mut Buffer, state: &mut PromptState) {
        state.caret = None;
        if area.width == 0 || area.height == 0 {
            return;
        }

        let height = area.height as usize;

        // Keep the caret visible: scroll the minimum amount needed,
        // never further than the content allows.
        if self.layout.caret_row < state.scroll {
            state.scroll = self.layout.caret_row;
        }
        if self.layout.caret_row >= state.scroll + height {
            state.scroll = self.layout.caret_row + 1 - height;
        }
        let max_scroll = self.layout.rows.len().saturating_sub(height);
        if state.scroll > max_scroll {
            state.scroll = max_scroll;
        }

        let style = Style::default()
            .fg(Color::White)
            .add_modifier(Modifier::BOLD);
        let lines: Vec<Line> = self
            .layout
            .rows
            .iter()
            .skip(state.scroll)
            .take(height)
            .map(|row| {
                let prefix = if row.is_first { PROMPT_PREFIX } else { PROMPT_INDENT };
                Line::from(Span::styled(format!("{prefix}{}", row.text), style))
            })
            .collect();

        Paragraph::new(lines).render(area, buf);

        if self.layout.caret_row >= state.scroll
            && self.layout.caret_row < state.scroll + height
        {
            let x = area.x.saturating_add(self.layout.caret_col as u16);
            let y = area.y.saturating_add((self.layout.caret_row - state.scroll) as u16);
            if x < area.x.saturating_add(area.width) && y < area.y.saturating_add(area.height) {
                state.caret = Some((x, y));
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ratatui::backend::TestBackend;
    use ratatui::Terminal;

    fn layout_of(input: &str, cursor: usize, width: u16) -> PromptLayout {
        prompt_layout(input, cursor, width)
    }

    #[test]
    fn empty_prompt_has_one_row_and_caret_after_the_marker() {
        let layout = layout_of("", 0, 40);
        assert_eq!(layout.rows.len(), 1);
        assert_eq!(layout.rows[0].text, "");
        assert!(layout.rows[0].is_first);
        assert_eq!(layout.caret_row, 0);
        assert_eq!(layout.caret_col, 2);
    }

    #[test]
    fn short_prompt_keeps_caret_at_the_end() {
        let layout = layout_of("hello", 5, 40);
        assert_eq!(layout.rows.len(), 1);
        assert_eq!(layout.caret_col, 2 + 5);
    }

    #[test]
    fn caret_follows_the_byte_offset() {
        let layout = layout_of("hello", 2, 40);
        assert_eq!(layout.caret_col, 2 + 2);
    }

    #[test]
    fn multibyte_input_measures_in_characters_not_bytes() {
        // "ąbc" — 4 bytes, 3 chars. A byte-based caret would land
        // inside the 'ą' and panic on slicing.
        let input = "ąbc";
        let layout = layout_of(input, input.len(), 40);
        assert_eq!(layout.caret_col, 2 + 3);
    }

    #[test]
    fn long_prompt_wraps_into_several_rows() {
        let layout = layout_of("abcdefghij", 10, 8);
        // width 8 - prefix 2 - caret reserve 1 = 5 chars per row.
        assert_eq!(layout.rows.len(), 2);
        assert_eq!(layout.rows[0].text, "abcde");
        assert_eq!(layout.rows[1].text, "fghij");
        assert!(layout.rows[0].is_first);
        assert!(!layout.rows[1].is_first);
    }

    #[test]
    fn wrapped_caret_moves_to_the_next_row_at_the_wrap_boundary() {
        let layout = layout_of("abcdefgh", 6, 8);
        assert_eq!(layout.caret_row, 1);
        assert_eq!(layout.caret_col, 2 + 1);
    }

    #[test]
    fn caret_after_a_full_row_stays_inside_the_area() {
        // The caret must never land on the column past the area —
        // terminals clamp that onto the last character.
        let layout = layout_of("abcdefgh", 8, 8);
        assert_eq!(layout.caret_row, 1);
        assert!(layout.caret_col < 8, "caret column {} escaped the area", layout.caret_col);
    }

    #[test]
    fn newline_splits_the_prompt_into_indented_rows() {
        let layout = layout_of("one\ntwo", 7, 40);
        assert_eq!(layout.rows.len(), 2);
        assert_eq!(layout.rows[0].text, "one");
        assert_eq!(layout.rows[1].text, "two");
        assert!(layout.rows[0].is_first);
        assert!(!layout.rows[1].is_first);
        // Caret at the end of "two".
        assert_eq!(layout.caret_row, 1);
        assert_eq!(layout.caret_col, 2 + 3);
    }

    #[test]
    fn caret_on_an_empty_second_line_sits_at_the_indent() {
        let layout = layout_of("one\n", 4, 40);
        assert_eq!(layout.rows.len(), 2);
        assert_eq!(layout.rows[1].text, "");
        assert_eq!(layout.caret_row, 1);
        assert_eq!(layout.caret_col, 2);
    }

    #[test]
    fn control_characters_are_stripped_and_the_caret_stays_aligned() {
        // A pasted ANSI sequence must not shift the caret.
        let input = "a\u{1b}[31mb";
        let layout = layout_of(input, input.len(), 40);
        assert_eq!(layout.rows[0].text, "ab");
        assert_eq!(layout.caret_col, 2 + 2);
    }

    #[test]
    fn widget_reports_the_caret_position() {
        let layout = layout_of("hello", 5, 40);
        let backend = TestBackend::new(40, 1);
        let mut terminal = Terminal::new(backend).unwrap();
        let mut state = PromptState::default();

        terminal
            .draw(|frame| {
                frame.render_stateful_widget(
                    PromptWidget::new(&layout),
                    frame.area(),
                    &mut state,
                );
            })
            .unwrap();

        assert_eq!(state.caret, Some((7, 0)));
    }

    #[test]
    fn widget_scrolls_to_keep_the_caret_visible() {
        // 20 rows of content in a 3-row area: the caret must end up
        // inside the viewport, not clipped away.
        let input = "x".repeat(60);
        let layout = layout_of(&input, input.len(), 8);
        let backend = TestBackend::new(8, 3);
        let mut terminal = Terminal::new(backend).unwrap();
        let mut state = PromptState::default();

        terminal
            .draw(|frame| {
                frame.render_stateful_widget(
                    PromptWidget::new(&layout),
                    frame.area(),
                    &mut state,
                );
            })
            .unwrap();

        assert!(state.caret.is_some(), "caret must stay visible");
        let (_, y) = state.caret.unwrap();
        assert!(y < 3, "caret row {y} must be inside the 3-row viewport");
    }
}
