//! The tool activity strip: one compact, bordered place for the last
//! few tool calls of the running turn.
//!
//! This replaces the side panel that used to own a third of the screen
//! and list up to fourteen calls. The strip takes the width the panel
//! took and gives it back to the conversation, and it shows three calls
//! instead of fourteen: the operator needs to know what the agent is
//! doing right now, not to read a log of the last quarter of an hour.
//!
//! The rule this widget follows: **shape, not payload**. It shows the
//! operation's name, its state and — once it is over — how long it
//! took. It never shows raw tool output, and it never claims an
//! outcome the runtime did not report.

use ratatui::{
    buffer::Buffer,
    layout::Rect,
    style::{Color, Modifier, Style},
    text::{Line, Span},
    widgets::{Block, BorderType, Borders, Paragraph, Widget},
};
use unicode_width::UnicodeWidthStr;

use crate::app::{ToolActivity, ToolOutcome};
use crate::sanitize::sanitize_for_tui;

/// How many tool calls the strip lists at most.
///
/// Three is the number that answers "what is the agent doing now?"
/// without becoming a second transcript. Older calls scroll out of the
/// strip; the durable record of every call stays in the database.
pub const MAX_VISIBLE_CALLS: usize = 3;

/// The strip, as the cockpit shows it.
pub struct ToolActivityStrip<'a> {
    activity: &'a [ToolActivity],
}

impl<'a> ToolActivityStrip<'a> {
    pub fn new(activity: &'a [ToolActivity]) -> Self {
        Self { activity }
    }

    /// The calls the strip shows: the most recent ones, oldest first.
    fn shown(&self) -> Vec<&ToolActivity> {
        let mut shown: Vec<&ToolActivity> = self
            .activity
            .iter()
            .rev()
            .take(MAX_VISIBLE_CALLS)
            .collect();
        shown.reverse();
        shown
    }

    /// The rows the strip needs, borders included.
    ///
    /// Zero when there is nothing to show: an empty bordered box is a
    /// hole in the screen, not information.
    pub fn height(&self) -> u16 {
        let shown = self.shown().len();
        if shown == 0 {
            0
        } else {
            shown as u16 + 2
        }
    }

    /// One tool call: the mark, the label, the state and the duration.
    ///
    /// The summary is clipped to whatever room is left after the label
    /// and the duration — the duration is never the thing that gets
    /// pushed out of the strip.
    fn call_line(call: &ToolActivity, width: usize) -> Line<'static> {
        let (mark, color) = call.outcome_mark();
        let label = sanitize_for_tui(&call.label());
        let state = call.state_label();
        let duration = match call.outcome {
            ToolOutcome::Pending | ToolOutcome::Unknown => String::new(),
            _ => call.duration_label(),
        };
        let prefix = format!("{mark} ");
        let suffix = if duration.is_empty() { format!(" {state}") } else { format!(" {state} {duration}") };
        let prefix_width = UnicodeWidthStr::width(prefix.as_str());
        let suffix_width = UnicodeWidthStr::width(suffix.as_str());
        let label_room = width.saturating_sub(prefix_width + suffix_width);
        let label = clip_to_width(&label, label_room);
        let used = prefix_width + UnicodeWidthStr::width(label.as_str()) + suffix_width;
        let summary = sanitize_for_tui(&call.summary());
        let extra = width.saturating_sub(used);
        let summary = if extra > 1 { clip_to_width(&summary, extra - 1) } else { String::new() };
        let mut spans = vec![Span::styled(prefix, Style::default().fg(color)),
                             Span::styled(label, Style::default().fg(Color::White)),
                             Span::styled(suffix, Style::default().fg(color))];
        if !summary.is_empty() {
            spans.push(Span::styled(format!(" {summary}"), Style::default().fg(Color::DarkGray)));
        }
        Line::from(spans)
    }

}

/// Clip a string to a number of terminal columns.
///
/// The width is measured in columns, not characters: a CJK character
/// takes two columns, and clipping by character count would push the
/// line past the edge of the strip and cut the duration off.
fn clip_to_width(value: &str, width: usize) -> String {
    if width == 0 {
        return String::new();
    }
    if UnicodeWidthStr::width(value) <= width {
        return value.to_string();
    }
    let mut out = String::new();
    let mut used = 0usize;
    for ch in value.chars() {
        let ch_width = UnicodeWidthStr::width(ch.to_string().as_str());
        // One column is reserved for the ellipsis.
        if used + ch_width > width.saturating_sub(1) {
            break;
        }
        out.push(ch);
        used += ch_width;
    }
    out.push('…');
    out
}

impl Widget for ToolActivityStrip<'_> {
    fn render(self, area: Rect, buf: &mut Buffer) {
        if area.width == 0 || area.height == 0 {
            return;
        }
        // The block's border eats two columns; the text lives in what
        // is left, and the clipping has to know that.
        let width = (area.width as usize).saturating_sub(2);

        let mut lines: Vec<Line<'static>> = Vec::new();
        let shown = self.shown();
        let visible = (area.height as usize).saturating_sub(2);
        for call in shown.iter().skip(shown.len().saturating_sub(visible)) {
            lines.push(Self::call_line(call, width));
        }

        let block = Block::default()
            .borders(Borders::ALL)
            .border_type(BorderType::Rounded)
            .border_style(Style::default().fg(Color::DarkGray))
            .title(Span::styled(
                " tools ",
                Style::default()
                    .fg(Color::Cyan)
                    .add_modifier(Modifier::BOLD),
            ));

        Paragraph::new(lines).block(block).render(area, buf);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ratatui::backend::TestBackend;
    use ratatui::Terminal;

    fn call(id: &str, name: &str, display: &str, outcome: ToolOutcome, elapsed_ms: u64) -> ToolActivity {
        ToolActivity {
            id: id.to_string(),
            name: name.to_string(),
            display: display.to_string(),
            outcome,
            elapsed_ms,
        }
    }

    fn render(activity: &[ToolActivity], width: u16, height: u16) -> String {
        let backend = TestBackend::new(width, height);
        let mut terminal = Terminal::new(backend).unwrap();
        terminal
            .draw(|frame| {
                frame.render_widget(ToolActivityStrip::new(activity), frame.area());
            })
            .unwrap();
        let buffer = terminal.backend().buffer().clone();
        (0..buffer.area.height)
            .map(|y| {
                (0..buffer.area.width)
                    .map(|x| buffer.cell((x, y)).unwrap().symbol().to_string())
                    .collect::<String>()
            })
            .collect::<Vec<_>>()
            .join("\n")
    }

    #[test]
    fn a_pending_call_says_it_is_running_and_not_that_it_succeeded() {
        let activity = vec![call(
            "c1",
            "memphis_exec",
            "",
            ToolOutcome::Pending,
            0,
        )];
        let content = render(&activity, 60, 5);
        assert!(content.contains("running"), "got:\n{content}");
        assert!(content.contains("exec"), "got:\n{content}");
        assert!(!content.contains("ok "), "a pending call is not ok:\n{content}");
        assert!(!content.contains('✓'), "a pending call is not a success:\n{content}");
    }

    #[test]
    fn a_finished_call_shows_its_state_and_its_real_duration() {
        let activity = vec![call(
            "c1",
            "memphis_chain_verify",
            "chain verify ok=86",
            ToolOutcome::Succeeded,
            1_500,
        )];
        let content = render(&activity, 60, 5);
        assert!(content.contains("chain verify"), "got:\n{content}");
        assert!(content.contains("ok=86"), "got:\n{content}");
        assert!(content.contains("1.5s"), "got:\n{content}");
        assert!(content.contains('✓'), "got:\n{content}");
    }

    #[test]
    fn a_failed_call_is_marked_as_failed() {
        let activity = vec![call(
            "c1",
            "memphis_vault_list",
            "error: locked",
            ToolOutcome::Failed,
            900,
        )];
        let content = render(&activity, 60, 5);
        assert!(content.contains('✗'), "got:\n{content}");
        assert!(content.contains("failed"), "got:\n{content}");
        assert!(content.contains("900ms"), "got:\n{content}");
    }

    #[test]
    fn an_unknown_outcome_is_not_reported_as_success() {
        let activity = vec![call(
            "c1",
            "memphis_exec",
            "",
            ToolOutcome::Unknown,
            0,
        )];
        let content = render(&activity, 60, 5);
        assert!(content.contains("outcome unknown"), "got:\n{content}");
        assert!(!content.contains('✓'), "unknown is not a success:\n{content}");
        assert!(!content.contains('✗'), "unknown is not a failure:\n{content}");
    }

    #[test]
    fn at_most_three_calls_are_shown_newest_last() {
        let activity = vec![
            call("c1", "memphis_one", "one", ToolOutcome::Succeeded, 1),
            call("c2", "memphis_two", "two", ToolOutcome::Succeeded, 2),
            call("c3", "memphis_three", "three", ToolOutcome::Succeeded, 3),
            call("c4", "memphis_four", "four", ToolOutcome::Succeeded, 4),
        ];
        let content = render(&activity, 60, 6);
        assert!(!content.contains("one"), "the oldest call scrolled out:\n{content}");
        assert!(content.contains("two"), "got:\n{content}");
        assert!(content.contains("three"), "got:\n{content}");
        assert!(content.contains("four"), "got:\n{content}");
        let two = content.find("two").unwrap();
        let four = content.find("four").unwrap();
        assert!(two < four, "the newest call reads last:\n{content}");
    }

    #[test]
    fn short_panel_prioritizes_newest_call() {
        let activity = vec![
            call("one", "memphis_one", "first", ToolOutcome::Succeeded, 1),
            call("two", "memphis_two", "second", ToolOutcome::Succeeded, 1),
            call("three", "memphis_three", "third", ToolOutcome::Succeeded, 1),
        ];
        let content = render(&activity, 50, 3);
        assert!(content.contains("three"), "{content}");
        assert!(!content.contains("one"), "{content}");
    }

    #[test]
    fn a_narrow_terminal_keeps_the_label_and_drops_the_summary() {
        let activity = vec![call(
            "c1",
            "memphis_chain_verify",
            "chain verify ok=86 blocks verified",
            ToolOutcome::Succeeded,
            1_500,
        )];
        let content = render(&activity, 24, 5);
        assert!(content.contains("chain verify"), "got:\n{content}");
        assert!(content.contains("1.5s"), "the duration survives:\n{content}");
    }

    #[test]
    fn a_short_terminal_renders_what_it_can() {
        let activity = vec![call(
            "c1",
            "memphis_exec",
            "exec ran",
            ToolOutcome::Succeeded,
            10,
        )];
        let content = render(&activity, 40, 1);
        // A one-row strip has no room for a border; ratatui drops the
        // text rather than panicking.
        assert!(!content.contains("✓"), "no outcome fits in a one-row strip: {content}");
    }

    #[test]
    fn wide_characters_do_not_push_the_duration_off_the_edge() {
        let activity = vec![call(
            "c1",
            "memphis_exec",
            "実行中 実行中 実行中",
            ToolOutcome::Succeeded,
            2_000,
        )];
        let content = render(&activity, 30, 5);
        assert!(content.contains("2.0s"), "the duration survives:\n{content}");
    }

    #[test]
    fn the_strip_has_no_height_without_calls() {
        assert_eq!(ToolActivityStrip::new(&[]).height(), 0);
        let activity = vec![call(
            "c1",
            "memphis_exec",
            "x",
            ToolOutcome::Succeeded,
            1,
        )];
        assert_eq!(ToolActivityStrip::new(&activity).height(), 3);
    }
}
