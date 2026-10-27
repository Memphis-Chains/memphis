use std::io;

use chrono::Local;
use ratatui::{
    backend::CrosstermBackend,
    layout::{Constraint, Direction, Layout},
    Frame, Terminal,
};

use crate::app::{AppState, StatusBarContext};
use crate::widgets::{
    prompt_layout, ActivityPanel, HelpOverlay, NotificationBanner, OutputBody, PromptState,
    PromptWidget, ScrollState, SearchBar, StatusBar, MAX_PROMPT_ROWS,
};

/// The side panel's share of the width, in percent.
const PANEL_PERCENT: usize = 30;
/// The panel never gets narrower than this.
const MIN_PANEL_WIDTH: u16 = 28;
/// …nor wider than this.
const MAX_PANEL_WIDTH: u16 = 46;
/// Below this terminal width the panel is dropped: a cockpit with a
/// 28-column panel and a 60-column conversation is worse than no
/// panel at all.
const MIN_TERMINAL_FOR_PANEL: u16 = 100;

const RENDERER_MODE: &str = "ratatui";

/// How often the busy indicator is allowed to change.
///
/// The cockpit redraws ten times a second while a turn is running, and
/// a character that changes on every one of those redraws is a
/// high-contrast blink in the operator's peripheral vision — the
/// "strobe" the operator reported on 2026-10-27. Five changes a second
/// still reads as "something is happening" and no longer flickers.
const SPINNER_INTERVAL: std::time::Duration = std::time::Duration::from_millis(200);

pub struct UiRenderer {
    terminal: Terminal<CrosstermBackend<io::Stdout>>,
    scroll_state: ScrollState,
    /// Scroll offset + caret position of the input line.
    prompt_state: PromptState,
    busy_frame: usize,
    /// When the busy indicator last changed.
    last_spinner_at: std::time::Instant,
}

impl UiRenderer {
    pub fn new() -> io::Result<Self> {
        let backend = CrosstermBackend::new(io::stdout());
        let terminal = Terminal::new(backend)?;
        Ok(Self {
            terminal,
            scroll_state: ScrollState::new(),
            prompt_state: PromptState::default(),
            busy_frame: 0,
            last_spinner_at: std::time::Instant::now() - SPINNER_INTERVAL,
        })
    }

    pub fn draw(&mut self, app: &AppState) -> io::Result<()> {
        let timestamp = Local::now().format("%H:%M:%S").to_string();
        let status_context = app.render_status_bar_context();
        let help_visible = app.help_visible;
        let mouse_toast = app
            .mouse_capture_toast
            .as_ref()
            .filter(|t| t.is_visible())
            .map(|t| t.captured);
        let scroll_state = &mut self.scroll_state;
        let prompt_state = &mut self.prompt_state;
        let busy_frame = self.busy_frame;

        self.terminal.draw(|frame| {
            render_ui(
                frame,
                app,
                &status_context,
                &timestamp,
                scroll_state,
                prompt_state,
                busy_frame,
                help_visible,
                mouse_toast,
            );
        })?;
        // The indicator advances on a clock, not on the redraw: the
        // redraw rate is ten frames a second while a turn is running,
        // and every one of those frames used to rewrite the indicator's
        // cell.
        if self.last_spinner_at.elapsed() >= SPINNER_INTERVAL {
            self.last_spinner_at = std::time::Instant::now();
            self.busy_frame = self.busy_frame.wrapping_add(1);
        }
        Ok(())
    }

    pub fn scroll_up(&mut self, lines: usize) {
        self.scroll_state.scroll_up(lines);
    }

    pub fn scroll_down(&mut self, lines: usize) {
        self.scroll_state.scroll_down(lines);
    }

    pub fn page_up(&mut self) {
        self.scroll_state.page_up();
    }

    pub fn page_down(&mut self) {
        self.scroll_state.page_down();
    }

    pub fn half_page_up(&mut self) {
        self.scroll_state.half_page_up();
    }

    pub fn half_page_down(&mut self) {
        self.scroll_state.half_page_down();
    }

    pub fn scroll_to_top(&mut self) {
        self.scroll_state.scroll_to_top();
    }

    pub fn scroll_to_bottom(&mut self) {
        self.scroll_state.scroll_to_bottom();
    }
}

pub fn renderer_mode() -> &'static str {
    RENDERER_MODE
}

fn render_ui(
    frame: &mut Frame,
    app: &AppState,
    status_context: &StatusBarContext,
    timestamp: &str,
    scroll_state: &mut ScrollState,
    prompt_state: &mut PromptState,
    busy_frame: usize,
    help_visible: bool,
    mouse_toast: Option<bool>,
) {
    let output_buffer = &app.output_buffer;
    let input_buffer = &app.input_buffer;
    let degradation = app.degradation.as_ref();
    let has_notification = degradation.is_some();
    let search = app.search.as_ref();

    // The prompt is sized from its own content: a one-line prompt takes
    // one row, a long or multi-line prompt takes up to MAX_PROMPT_ROWS
    // and the body gives up the difference. Before this the prompt was
    // hard-pinned to a single row, so anything the operator typed past
    // the terminal width was silently truncated.
    let frame_width = frame.area().width;
    let prompt = prompt_layout(input_buffer, app.input_cursor, frame_width);

    // The prompt may take several rows, but it must not squeeze the
    // body out of existence on a short terminal: the body keeps its
    // three-row minimum, and the prompt takes what is left.
    let reserved_rows = 1 // status bar
        + usize::from(has_notification)
        + usize::from(search.is_some())
        + 3; // body minimum
    let max_prompt_rows = (frame.area().height as usize)
        .saturating_sub(reserved_rows)
        .clamp(1, MAX_PROMPT_ROWS);
    let prompt_height = prompt.rows.len().clamp(1, max_prompt_rows) as u16;

    // The search bar takes a row of its own, above the prompt, so the
    // query never competes with what the operator is typing.
    let mut constraints = Vec::new();
    if has_notification {
        constraints.push(Constraint::Length(1)); // notification banner
    }
    constraints.push(Constraint::Min(3)); // body
    if search.is_some() {
        constraints.push(Constraint::Length(1)); // search bar
    }
    constraints.push(Constraint::Length(prompt_height)); // prompt
    constraints.push(Constraint::Length(1)); // status bar

    let chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints(constraints)
        .split(frame.area());

    let mut idx = 0;

    if let Some(deg) = degradation {
        frame.render_widget(NotificationBanner::new(&deg.reason), chunks[idx]);
        idx += 1;
    }

    // Two panes, like the first Memphis TUI had: the conversation on
    // the left, a fixed column on the right for the session's runtime
    // and the tool calls of the running turn. On a narrow terminal the
    // panel is dropped rather than squeezing the conversation.
    let panel_width = if frame_width >= MIN_TERMINAL_FOR_PANEL {
        (frame_width as usize * PANEL_PERCENT / 100) as u16
    } else {
        0
    };
    let panel_width = panel_width.clamp(MIN_PANEL_WIDTH, MAX_PANEL_WIDTH);

    if panel_width > 0 {
        let panes = Layout::default()
            .direction(Direction::Horizontal)
            .constraints([Constraint::Min(30), Constraint::Length(panel_width)])
            .split(chunks[idx]);
        frame.render_stateful_widget(
            OutputBody::with_search(output_buffer, search),
            panes[0],
            scroll_state,
        );
        frame.render_widget(
            ActivityPanel::new(status_context, &app.tool_activity),
            panes[1],
        );
    } else {
        frame.render_stateful_widget(
            OutputBody::with_search(output_buffer, search),
            chunks[idx],
            scroll_state,
        );
    }

    let mut next = idx + 1;
    if let Some(search) = search {
        frame.render_widget(SearchBar::new(search), chunks[next]);
        next += 1;
    }

    frame.render_stateful_widget(PromptWidget::new(&prompt), chunks[next], prompt_state);
    frame.render_widget(
        StatusBar::new(status_context, timestamp, busy_frame),
        chunks[next + 1],
    );

    // The caret is drawn by the prompt widget, not by the terminal.
    //
    // Asking the terminal for a cursor position means the terminal's
    // cursor blinks — and the blink rate belongs to the terminal, not
    // to the cockpit. On this host that was a hard block blinking next
    // to the operator's text: the "strobe" of 2026-10-27. The prompt
    // draws its own insertion point instead, so it does not blink and
    // looks the same in every terminal.

    // Toast: short-lived (3s) banner rendered in the top-right of the
    // body area when the operator just toggled mouse capture. Single
    // line, small footprint, doesn't disturb the layout.
    if let Some(captured) = mouse_toast {
        let body_area = chunks[idx];
        let label = if captured {
            " mouse: ON  (scroll wheel works · Shift+drag to copy) "
        } else {
            " mouse: OFF (text selection works · F2 to re-enable scroll) "
        };
        let label_w = label.chars().count() as u16;
        let toast_w = label_w.min(body_area.width.saturating_sub(2));
        let toast_x = body_area.x + body_area.width.saturating_sub(toast_w + 1);
        let toast_area = ratatui::layout::Rect {
            x: toast_x,
            y: body_area.y,
            width: toast_w,
            height: 1,
        };
        let style = if captured {
            ratatui::style::Style::default()
                .bg(ratatui::style::Color::Green)
                .fg(ratatui::style::Color::Black)
        } else {
            ratatui::style::Style::default()
                .bg(ratatui::style::Color::Yellow)
                .fg(ratatui::style::Color::Black)
        };
        frame.render_widget(ratatui::widgets::Clear, toast_area);
        frame.render_widget(
            ratatui::widgets::Paragraph::new(ratatui::text::Line::from(
                ratatui::text::Span::styled(label.to_string(), style),
            )),
            toast_area,
        );
    }

    // Help overlay rendered LAST so it floats above everything.
    if help_visible {
        let area = HelpOverlay::area(frame.area());
        frame.render_widget(HelpOverlay, area);
    }
}

#[cfg(test)]
mod tests {
    use super::renderer_mode;
    use crate::app::{ContextPressureLevel, ContextPressureSummary, StatusBarContext};

    /// The status bar's text, from the widget that draws it.
    ///
    /// Before this the test module had its own copy of the formatting —
    /// two implementations of one contract in one layer, which is how
    /// a test ends up asserting on a string the operator never sees.
    fn format_status_bar(context: &StatusBarContext, timestamp: &str, busy_frame: usize) -> String {
        crate::widgets::status_bar_text(context, timestamp, busy_frame)
    }

    fn trim_to_width(value: &str, width: usize) -> String {
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

    #[test]
    fn formats_connected_status_bar() {
        let context = StatusBarContext {
            connected: true,
            provider: "ollama".to_string(),
            model: "qwen2.5-coder:3b".to_string(),
            context_window_tokens: Some(8192),
            context_pressure: Some(ContextPressureSummary {
                level: ContextPressureLevel::Low,
                remaining_context_tokens: 8096,
                estimated: false,
            }),
            token_usage: Some(memphis_operator::TokenUsageSummary {
                prompt_tokens: 96,
                completion_tokens: 24,
                total_tokens: 120,
                estimated: false,
            }),
            live_token_usage: None,
            live_output_tokens: None,
            session_id: "mem0".to_string(),
            busy: false,
            activity: None,
            cancelling: false,
            cancel_waiting_on_provider: false,
            degraded: false,
            degradation_reason: None,
            cognitive_mode: "A".to_string(),
            pulse_health: "healthy".to_string(),
        };

        let rendered = format_status_bar(&context, "14:32:05", 0);

        assert_eq!(
            rendered,
            "● [Mode:A] ollama/qwen2.5-coder:3b · ctx:8k · tok:120 · ready · PULSE:healthy · session:mem0 · 14:32:05"
        );
    }

    #[test]
    fn formats_cancelling_provider_wait_status_bar() {
        let context = StatusBarContext {
            connected: true,
            provider: "shared-llm".to_string(),
            model: "shared-llm".to_string(),
            context_window_tokens: None,
            context_pressure: None,
            token_usage: None,
            live_token_usage: None,
            live_output_tokens: None,
            session_id: "mem0".to_string(),
            busy: true,
            activity: Some("native chat".to_string()),
            cancelling: true,
            cancel_waiting_on_provider: true,
            degraded: false,
            degradation_reason: None,
            cognitive_mode: "B".to_string(),
            pulse_health: "healthy".to_string(),
        };

        let rendered = format_status_bar(&context, "14:32:05", 0);

        assert_eq!(
            rendered,
            "● [Mode:B] shared-llm/shared-llm · ctx:? · tok:? · cancelling native chat (provider wait) · PULSE:healthy · session:mem0 · 14:32:05"
        );
    }

    #[test]
    fn formats_busy_status_bar_with_spinner() {
        let context = StatusBarContext {
            connected: true,
            provider: "ollama".to_string(),
            model: "qwen2.5-coder:3b".to_string(),
            context_window_tokens: Some(8192),
            context_pressure: Some(ContextPressureSummary {
                level: ContextPressureLevel::Medium,
                remaining_context_tokens: 3200,
                estimated: false,
            }),
            token_usage: Some(memphis_operator::TokenUsageSummary {
                prompt_tokens: 96,
                completion_tokens: 24,
                total_tokens: 120,
                estimated: true,
            }),
            live_token_usage: Some(memphis_operator::TokenUsageSummary {
                prompt_tokens: 96,
                completion_tokens: 18,
                total_tokens: 114,
                estimated: false,
            }),
            live_output_tokens: Some(18),
            session_id: "mem0".to_string(),
            busy: true,
            activity: Some("native chat".to_string()),
            cancelling: false,
            cancel_waiting_on_provider: false,
            degraded: false,
            degradation_reason: None,
            cognitive_mode: "A".to_string(),
            pulse_health: "healthy".to_string(),
        };

        let rendered = format_status_bar(&context, "14:32:05", 2);

        // The indicator sits in front of the activity segment and is a
        // braille dot — a shape that flips between two silhouettes is
        // a blink in the operator's peripheral vision.
        assert_eq!(
            rendered,
            "● [Mode:A] ollama/qwen2.5-coder:3b · ctx:8k · prs:med rem:3.2k · tok:114 · ⠹ busy native chat · PULSE:healthy · session:mem0 · 14:32:05"
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
