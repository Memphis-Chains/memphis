use std::io;

use chrono::Local;
use ratatui::{
    backend::CrosstermBackend,
    layout::{Constraint, Direction, Layout},
    Frame, Terminal,
};

use crate::app::{AppState, StatusBarContext};
use crate::widgets::{NotificationBanner, OutputBody, PromptLine, ScrollState, StatusBar};

const RENDERER_MODE: &str = "ratatui";

pub struct UiRenderer {
    terminal: Terminal<CrosstermBackend<io::Stdout>>,
    scroll_state: ScrollState,
}

impl UiRenderer {
    pub fn new() -> io::Result<Self> {
        let backend = CrosstermBackend::new(io::stdout());
        let terminal = Terminal::new(backend)?;
        Ok(Self {
            terminal,
            scroll_state: ScrollState::new(),
        })
    }

    pub fn draw(&mut self, app: &AppState) -> io::Result<()> {
        let timestamp = Local::now().format("%H:%M:%S").to_string();
        let status_context = app.render_status_bar_context();
        let degradation = app.degradation.as_ref();
        let output_buffer = &app.output_buffer;
        let input_buffer = &app.input_buffer;
        let scroll_state = &mut self.scroll_state;

        self.terminal.draw(|frame| {
            render_ui(
                frame,
                output_buffer,
                input_buffer,
                &status_context,
                &timestamp,
                degradation,
                scroll_state,
            );
        })?;
        Ok(())
    }
}

pub fn renderer_mode() -> &'static str {
    RENDERER_MODE
}

fn render_ui(
    frame: &mut Frame,
    output_buffer: &[crate::app::StyledLine],
    input_buffer: &str,
    status_context: &StatusBarContext,
    timestamp: &str,
    degradation: Option<&crate::app::DegradationState>,
    scroll_state: &mut ScrollState,
) {
    let has_notification = degradation.is_some();

    let constraints = if has_notification {
        vec![
            Constraint::Length(1), // notification banner
            Constraint::Min(3),   // body
            Constraint::Length(1), // prompt
            Constraint::Length(1), // status bar
        ]
    } else {
        vec![
            Constraint::Min(3),   // body
            Constraint::Length(1), // prompt
            Constraint::Length(1), // status bar
        ]
    };

    let chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints(constraints)
        .split(frame.area());

    let mut idx = 0;

    if let Some(deg) = degradation {
        frame.render_widget(NotificationBanner::new(&deg.reason), chunks[idx]);
        idx += 1;
    }

    frame.render_stateful_widget(
        OutputBody::new(output_buffer),
        chunks[idx],
        scroll_state,
    );
    frame.render_widget(PromptLine::new(input_buffer), chunks[idx + 1]);
    frame.render_widget(
        StatusBar::new(status_context, timestamp),
        chunks[idx + 2],
    );
}

pub(crate) fn format_status_bar(context: &StatusBarContext, timestamp: &str) -> String {
    let indicator = if context.connected { "●" } else { "○" };
    let activity = if context.busy {
        let label = context.activity.as_deref().unwrap_or("task");
        if context.cancelling {
            if context.cancel_waiting_on_provider {
                format!("cancelling {label} (provider wait)")
            } else {
                format!("cancelling {label}")
            }
        } else {
            format!("busy {label}")
        }
    } else {
        "ready".to_string()
    };
    format!(
        "{indicator} {} · {} · session:{} · {} · {}",
        context.provider, context.model, context.session_id, activity, timestamp
    )
}

pub(crate) fn trim_to_width(value: &str, width: usize) -> String {
    if width == 0 {
        return String::new();
    }
    let mut clipped = value.chars().take(width).collect::<String>();
    if clipped.chars().count() < value.chars().count() && width > 1 {
        clipped = clipped.chars().take(width.saturating_sub(1)).collect();
        clipped.push('…');
    }
    clipped
}

pub(crate) fn pad_to_width(value: &str, width: usize) -> String {
    let visible = value.chars().count();
    if visible >= width {
        return value.to_string();
    }
    format!("{value}{}", " ".repeat(width - visible))
}

#[cfg(test)]
mod tests {
    use super::{format_status_bar, renderer_mode, trim_to_width};
    use crate::app::StatusBarContext;

    #[test]
    fn formats_connected_status_bar() {
        let context = StatusBarContext {
            connected: true,
            provider: "ollama".to_string(),
            model: "qwen2.5-coder:3b".to_string(),
            session_id: "mem0".to_string(),
            busy: false,
            activity: None,
            cancelling: false,
            cancel_waiting_on_provider: false,
            degraded: false,
            degradation_reason: None,
        };

        let rendered = format_status_bar(&context, "14:32:05");

        assert_eq!(
            rendered,
            "● ollama · qwen2.5-coder:3b · session:mem0 · ready · 14:32:05"
        );
    }

    #[test]
    fn formats_cancelling_provider_wait_status_bar() {
        let context = StatusBarContext {
            connected: true,
            provider: "shared-llm".to_string(),
            model: "shared-llm".to_string(),
            session_id: "mem0".to_string(),
            busy: true,
            activity: Some("native chat".to_string()),
            cancelling: true,
            cancel_waiting_on_provider: true,
            degraded: false,
            degradation_reason: None,
        };

        let rendered = format_status_bar(&context, "14:32:05");

        assert_eq!(
            rendered,
            "● shared-llm · shared-llm · session:mem0 · cancelling native chat (provider wait) · 14:32:05"
        );
    }

    #[test]
    fn trims_long_lines_with_ellipsis() {
        assert_eq!(trim_to_width("abcdefghijklmnopqrstuvwxyz", 8), "abcdefg…");
    }

    #[test]
    fn renderer_reports_ratatui_mode() {
        assert_eq!(renderer_mode(), "ratatui");
    }
}
