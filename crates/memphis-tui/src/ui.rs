use std::io;

use chrono::Local;
use ratatui::{
    backend::CrosstermBackend,
    layout::{Constraint, Direction, Layout},
    Frame, Terminal,
};

use crate::app::{AppState, StatusBarContext};
use crate::widgets::{HelpOverlay, NotificationBanner, OutputBody, PromptLine, ScrollState, StatusBar};

const RENDERER_MODE: &str = "ratatui";

pub struct UiRenderer {
    terminal: Terminal<CrosstermBackend<io::Stdout>>,
    scroll_state: ScrollState,
    busy_frame: usize,
}

impl UiRenderer {
    pub fn new() -> io::Result<Self> {
        let backend = CrosstermBackend::new(io::stdout());
        let terminal = Terminal::new(backend)?;
        Ok(Self {
            terminal,
            scroll_state: ScrollState::new(),
            busy_frame: 0,
        })
    }

    pub fn draw(&mut self, app: &AppState) -> io::Result<()> {
        let timestamp = Local::now().format("%H:%M:%S").to_string();
        let status_context = app.render_status_bar_context();
        let degradation = app.degradation.as_ref();
        let output_buffer = &app.output_buffer;
        let input_buffer = &app.input_buffer;
        let help_visible = app.help_visible;
        let mouse_toast = app
            .mouse_capture_toast
            .as_ref()
            .filter(|t| t.is_visible())
            .map(|t| t.captured);
        let scroll_state = &mut self.scroll_state;
        let busy_frame = self.busy_frame;

        self.terminal.draw(|frame| {
            render_ui(
                frame,
                output_buffer,
                input_buffer,
                &status_context,
                &timestamp,
                degradation,
                scroll_state,
                busy_frame,
                help_visible,
                mouse_toast,
            );
        })?;
        self.busy_frame = self.busy_frame.wrapping_add(1);
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
    output_buffer: &[crate::app::StyledLine],
    input_buffer: &str,
    status_context: &StatusBarContext,
    timestamp: &str,
    degradation: Option<&crate::app::DegradationState>,
    scroll_state: &mut ScrollState,
    busy_frame: usize,
    help_visible: bool,
    mouse_toast: Option<bool>,
) {
    let has_notification = degradation.is_some();

    let constraints = if has_notification {
        vec![
            Constraint::Length(1), // notification banner
            Constraint::Min(3),    // body
            Constraint::Length(1), // prompt
            Constraint::Length(1), // status bar
        ]
    } else {
        vec![
            Constraint::Min(3),    // body
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

    frame.render_stateful_widget(OutputBody::new(output_buffer), chunks[idx], scroll_state);
    frame.render_widget(PromptLine::new(input_buffer), chunks[idx + 1]);
    frame.render_widget(
        StatusBar::new(status_context, timestamp, busy_frame),
        chunks[idx + 2],
    );

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

    fn format_context_window(tokens: Option<u32>) -> String {
        tokens
            .map(|tokens| {
                if tokens >= 1_000 {
                    if tokens % 1_024 == 0 {
                        format!("ctx:{}k", tokens / 1_024)
                    } else if tokens % 1_000 == 0 {
                        format!("ctx:{}k", tokens / 1_000)
                    } else {
                        format!("ctx:{:.1}k", tokens as f32 / 1_000.0)
                    }
                } else {
                    format!("ctx:{tokens}")
                }
            })
            .unwrap_or_else(|| "ctx:?".to_string())
    }

    fn format_status_token_usage(usage: Option<&memphis_operator::TokenUsageSummary>) -> String {
        usage
            .map(|usage| {
                if usage.estimated {
                    format!("tok~:{}", usage.total_tokens)
                } else {
                    format!("tok:{}", usage.total_tokens)
                }
            })
            .unwrap_or_else(|| "tok:?".to_string())
    }

    fn format_status_meter(context: &StatusBarContext) -> String {
        context
            .live_token_usage
            .as_ref()
            .map(|usage| {
                if usage.estimated {
                    format!("tok~:{}", usage.total_tokens)
                } else {
                    format!("tok:{}", usage.total_tokens)
                }
            })
            .or_else(|| {
                context
                    .live_output_tokens
                    .map(|tokens| format!("out~:{tokens}"))
            })
            .unwrap_or_else(|| format_status_token_usage(context.token_usage.as_ref()))
    }

    fn format_status_pressure(context: &StatusBarContext) -> Option<String> {
        context
            .context_pressure
            .as_ref()
            .filter(|pressure| pressure.level != ContextPressureLevel::Low)
            .map(|pressure| {
                let remaining = if pressure.remaining_context_tokens >= 1_000 {
                    if pressure.remaining_context_tokens % 1_024 == 0 {
                        format!("{}k", pressure.remaining_context_tokens / 1_024)
                    } else if pressure.remaining_context_tokens % 1_000 == 0 {
                        format!("{}k", pressure.remaining_context_tokens / 1_000)
                    } else {
                        format!("{:.1}k", pressure.remaining_context_tokens as f32 / 1_000.0)
                    }
                } else {
                    pressure.remaining_context_tokens.to_string()
                };
                if pressure.estimated {
                    format!("prs:{} rem~:{remaining}", pressure.level.short_label())
                } else {
                    format!("prs:{} rem:{remaining}", pressure.level.short_label())
                }
            })
    }

    fn format_status_bar(context: &StatusBarContext, timestamp: &str, busy_frame: usize) -> String {
        let indicator = if context.connected { "●" } else { "○" };
        let degraded_icon = if context.degraded { " ⚠" } else { "" };
        let activity = if context.busy {
            let label = context.activity.as_deref().unwrap_or("task");
            if context.cancelling {
                if context.cancel_waiting_on_provider {
                    format!("cancelling {label} (provider wait)")
                } else {
                    format!("cancelling {label}")
                }
            } else {
                let spinner = ["|", "/", "-", "\\"][busy_frame % 4];
                format!("busy {spinner} {label}")
            }
        } else {
            "ready".to_string()
        };
        let context_window = format_context_window(context.context_window_tokens);
        let token_usage = format_status_meter(context);
        let pressure = format_status_pressure(context);
        format!(
            "{degraded_icon}{indicator} [Mode:{}] {}/{} · {}{} · {} · {} · PULSE:{} · session:{} · {}",
            context.cognitive_mode,
            context.provider,
            context.model,
            context_window,
            pressure
                .as_ref()
                .map(|pressure| format!(" · {pressure}"))
                .unwrap_or_default(),
            token_usage,
            activity,
            context.pulse_health,
            context.session_id,
            timestamp
        )
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

        assert_eq!(
            rendered,
            "● [Mode:A] ollama/qwen2.5-coder:3b · ctx:8k · prs:med rem:3.2k · tok:114 · busy - native chat · PULSE:healthy · session:mem0 · 14:32:05"
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
