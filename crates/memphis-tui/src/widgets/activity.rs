//! The side panel: the session's runtime, and what the agent is doing.
//!
//! This is the panel the first Memphis TUI had — a fixed column next
//! to the conversation — but with a job it actually earns its width
//! on: showing the tool calls of the running turn, one discreet line
//! each.
//!
//! The rule this widget follows: **shape, not payload**. The operator
//! wants to know that the agent ran six commands and how long they
//! took; they do not want to read the output of each one on the side
//! of the screen while the answer streams on the other side.

use ratatui::{
    buffer::Buffer,
    layout::Rect,
    style::{Color, Modifier, Style},
    text::{Line, Span},
    widgets::{Block, BorderType, Borders, Paragraph, Widget},
};

use crate::app::{StatusBarContext, ToolActivity};
use crate::sanitize::sanitize_for_tui;

use super::status_bar::{format_context_window, format_status_token_usage};

/// How many tool calls the panel lists at most. Older ones scroll out
/// of the panel — the transcript keeps them.
const MAX_VISIBLE_CALLS: usize = 14;

/// The width of the label column, so the durations line up.
const LABEL_COLUMN: usize = 13;

pub struct ActivityPanel<'a> {
    context: &'a StatusBarContext,
    activity: &'a [ToolActivity],
}

impl<'a> ActivityPanel<'a> {
    pub fn new(context: &'a StatusBarContext, activity: &'a [ToolActivity]) -> Self {
        Self { context, activity }
    }

    fn section(title: &str) -> Line<'static> {
        Line::from(Span::styled(
            title.to_string(),
            Style::default()
                .fg(Color::Cyan)
                .add_modifier(Modifier::BOLD),
        ))
    }

    fn field(key: &str, value: &str) -> Line<'static> {
        Line::from(vec![
            Span::styled(
                format!("  {key:<9}"),
                Style::default().fg(Color::DarkGray),
            ),
            Span::styled(value.to_string(), Style::default().fg(Color::White)),
        ])
    }

    /// One tool call: the mark, the label, the normalized summary and
    /// the duration. The summary is clipped to whatever room is left
    /// after the label and the duration — the duration is never the
    /// thing that gets pushed out of the panel.
    fn call_line(call: &ToolActivity, width: usize) -> Line<'static> {
        let (mark, color) = if call.failed {
            ("✗", Color::Yellow)
        } else {
            ("✓", Color::Green)
        };
        let label = call.label();
        let duration = call.duration_label();
        let summary = sanitize_for_tui(&call.summary());

        let fixed = 2 + 2 + LABEL_COLUMN + 1 + duration.chars().count() + 1;
        let room = width.saturating_sub(fixed);
        let mut clipped: String = summary.chars().take(room).collect();
        if clipped.chars().count() < summary.chars().count() && room > 0 {
            clipped.pop();
            clipped.push('…');
        }

        Line::from(vec![
            Span::styled(format!("  {mark} "), Style::default().fg(color)),
            Span::styled(
                format!("{label:<LABEL_COLUMN$}"),
                Style::default().fg(Color::White),
            ),
            Span::styled(
                format!("{clipped} {duration}"),
                Style::default().fg(Color::DarkGray),
            ),
        ])
    }
}

impl Widget for ActivityPanel<'_> {
    fn render(self, area: Rect, buf: &mut Buffer) {
        if area.width == 0 || area.height == 0 {
            return;
        }
        // The block's border eats two columns; the text lives in what
        // is left, and the clipping has to know that.
        let width = (area.width as usize).saturating_sub(2);

        let mut lines: Vec<Line<'static>> = vec![
            Self::section("SESSION"),
            Self::field("id", &sanitize_for_tui(&self.context.session_id)),
            Self::field("mode", &sanitize_for_tui(&self.context.cognitive_mode)),
            Line::from(""),
            Self::section("RUNTIME"),
            Self::field("provider", &sanitize_for_tui(&self.context.provider)),
            Self::field("model", &sanitize_for_tui(&self.context.model)),
        ];
        let ctx = self
            .context
            .context_window_tokens
            .map(format_context_window)
            .unwrap_or_else(|| "ctx:?".to_string());
        lines.push(Self::field("window", &ctx));
        let tokens = self
            .context
            .live_token_usage
            .as_ref()
            .map(format_status_token_usage)
            .or_else(|| {
                self.context
                    .live_output_tokens
                    .map(|tokens| format!("out~:{tokens}"))
            })
            .or_else(|| {
                self.context
                    .token_usage
                    .as_ref()
                    .map(format_status_token_usage)
            })
            .unwrap_or_else(|| "tok:?".to_string());
        lines.push(Self::field("tokens", &tokens));
        lines.push(Self::field(
            "pulse",
            &sanitize_for_tui(&self.context.pulse_health),
        ));
        lines.push(Line::from(""));

        lines.push(Self::section("TOOLS"));
        if self.activity.is_empty() {
            lines.push(Line::from(Span::styled(
                "  no calls yet".to_string(),
                Style::default().fg(Color::DarkGray),
            )));
        } else {
            // The newest call last: the panel reads like a log, and the
            // newest call is the one the operator is waiting for.
            let shown: Vec<&ToolActivity> = self
                .activity
                .iter()
                .rev()
                .take(MAX_VISIBLE_CALLS)
                .collect();
            for call in shown.iter().rev() {
                lines.push(Self::call_line(call, width));
            }
        }

        let block = Block::default()
            .borders(Borders::ALL)
            .border_type(BorderType::Rounded)
            .border_style(Style::default().fg(Color::DarkGray))
            .title(Span::styled(
                " cockpit ",
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

    fn context() -> StatusBarContext {
        StatusBarContext {
            connected: true,
            provider: "minimax".to_string(),
            model: "MiniMax-M3.1-Flash".to_string(),
            context_window_tokens: Some(1_000_000),
            context_pressure: None,
            token_usage: None,
            live_token_usage: None,
            live_output_tokens: Some(42),
            session_id: "primary::operator:local".to_string(),
            busy: true,
            activity: Some("native chat".to_string()),
            cancelling: false,
            cancel_waiting_on_provider: false,
            degraded: false,
            degradation_reason: None,
            cognitive_mode: "B".to_string(),
            pulse_health: "healthy".to_string(),
        }
    }

    fn call(name: &str, display: &str, failed: bool, elapsed_ms: u64) -> ToolActivity {
        ToolActivity {
            name: name.to_string(),
            display: display.to_string(),
            failed,
            elapsed_ms,
        }
    }

    fn render(activity: &[ToolActivity]) -> String {
        let ctx = context();
        // The panel is up to 46 columns wide in the real cockpit.
        let backend = TestBackend::new(46, 20);
        let mut terminal = Terminal::new(backend).unwrap();
        terminal
            .draw(|frame| {
                frame.render_widget(
                    ActivityPanel::new(&ctx, activity),
                    frame.area(),
                );
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
    fn shows_the_runtime_and_the_session() {
        let content = render(&[]);
        assert!(content.contains("minimax"), "got:\n{content}");
        assert!(content.contains("MiniMax-M3.1-Flash"), "got:\n{content}");
        assert!(content.contains("primary::operator:local"), "got:\n{content}");
        assert!(content.contains("no calls yet"), "got:\n{content}");
    }

    #[test]
    fn lists_the_tool_calls_with_their_normalized_summary() {
        let activity = vec![call("memphis_chain_verify", "chain verify ok=86", false, 12)];
        let content = render(&activity);
        assert!(content.contains("chain verify"), "got:\n{content}");
        assert!(content.contains("ok=86"), "got:\n{content}");
        assert!(content.contains("12ms"), "got:\n{content}");
        assert!(!content.contains("memphis_chain_verify"), "the raw name leaks");
    }

    #[test]
    fn a_failed_call_is_marked() {
        let activity = vec![call("memphis_vault_list", "error: locked", true, 900)];
        let content = render(&activity);
        assert!(content.contains("✗"), "got:\n{content}");
        assert!(content.contains("vault list"), "got:\n{content}");
    }

    #[test]
    fn a_long_summary_is_clipped_but_the_duration_stays() {
        let long = "x".repeat(200);
        let activity = vec![call("memphis_exec", &long, false, 1_500)];
        let content = render(&activity);
        assert!(content.contains("1.5s"), "the duration must survive: got:\n{content}");
        assert!(!content.contains(&"x".repeat(50)), "the summary must be clipped");
    }
}
