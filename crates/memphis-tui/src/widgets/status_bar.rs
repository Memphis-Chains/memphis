use ratatui::{
    buffer::Buffer,
    layout::Rect,
    style::{Color, Modifier, Style},
    text::{Line, Span},
    widgets::{Paragraph, Widget},
};

use crate::app::StatusBarContext;
use crate::sanitize::{sanitize_for_tui, validate_provider_name};

pub struct StatusBar<'a> {
    context: &'a StatusBarContext,
    timestamp: &'a str,
}

impl<'a> StatusBar<'a> {
    pub fn new(context: &'a StatusBarContext, timestamp: &'a str) -> Self {
        Self { context, timestamp }
    }
}

impl Widget for StatusBar<'_> {
    fn render(self, area: Rect, buf: &mut Buffer) {
        let indicator = if self.context.connected { "●" } else { "○" };
        let degraded_icon = if self.context.degraded { " ⚠" } else { "" };

        let provider = if validate_provider_name(&self.context.provider) {
            sanitize_for_tui(&self.context.provider)
        } else {
            "unknown".to_string()
        };
        let model = sanitize_for_tui(&self.context.model);
        let session = sanitize_for_tui(&self.context.session_id);

        let activity = if self.context.busy {
            let label = self.context.activity.as_deref().unwrap_or("task");
            if self.context.cancelling {
                if self.context.cancel_waiting_on_provider {
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

        let mode = sanitize_for_tui(&self.context.cognitive_mode);
        let pulse = sanitize_for_tui(&self.context.pulse_health);

        let text = format!(
            "{degraded_icon}{indicator} [Mode:{mode}] {provider}/{model} · PULSE:{pulse} · session:{session} · {activity} · {}",
            self.timestamp
        );

        let style = Style::default()
            .bg(Color::Rgb(0, 0, 128))
            .fg(Color::White)
            .add_modifier(Modifier::BOLD);

        let width = area.width as usize;
        let padded = if text.chars().count() < width {
            format!("{text}{}", " ".repeat(width - text.chars().count()))
        } else {
            text
        };

        Paragraph::new(Line::from(Span::styled(padded, style))).render(area, buf);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ratatui::backend::TestBackend;
    use ratatui::Terminal;

    fn make_context(degraded: bool) -> StatusBarContext {
        StatusBarContext {
            connected: true,
            provider: "ollama".to_string(),
            model: "qwen2.5:3b".to_string(),
            session_id: "mem0".to_string(),
            busy: false,
            activity: None,
            cancelling: false,
            cancel_waiting_on_provider: false,
            degraded,
            degradation_reason: if degraded {
                Some("deepseek in cooldown".to_string())
            } else {
                None
            },
            cognitive_mode: "A".to_string(),
            pulse_health: "healthy".to_string(),
        }
    }

    #[test]
    fn renders_normal_status_bar() {
        let ctx = make_context(false);
        let backend = TestBackend::new(80, 1);
        let mut terminal = Terminal::new(backend).unwrap();

        terminal
            .draw(|frame| {
                frame.render_widget(StatusBar::new(&ctx, "14:32:05"), frame.area());
            })
            .unwrap();

        let buffer = terminal.backend().buffer().clone();
        let content: String = (0..buffer.area.width)
            .map(|x| buffer.cell((x, 0)).unwrap().symbol().to_string())
            .collect();
        assert!(content.contains("ollama"));
        assert!(content.contains("ready"));
        assert!(!content.contains("⚠"));
    }

    #[test]
    fn renders_degraded_status_bar() {
        let ctx = make_context(true);
        let backend = TestBackend::new(80, 1);
        let mut terminal = Terminal::new(backend).unwrap();

        terminal
            .draw(|frame| {
                frame.render_widget(StatusBar::new(&ctx, "14:32:05"), frame.area());
            })
            .unwrap();

        let buffer = terminal.backend().buffer().clone();
        let content: String = (0..buffer.area.width)
            .map(|x| buffer.cell((x, 0)).unwrap().symbol().to_string())
            .collect();
        assert!(content.contains("⚠"));
        assert!(content.contains("ollama"));
    }

    #[test]
    fn sanitizes_malicious_provider_name() {
        let mut ctx = make_context(false);
        ctx.provider = "../../etc/passwd".to_string();

        let backend = TestBackend::new(80, 1);
        let mut terminal = Terminal::new(backend).unwrap();

        terminal
            .draw(|frame| {
                frame.render_widget(StatusBar::new(&ctx, "14:32:05"), frame.area());
            })
            .unwrap();

        let buffer = terminal.backend().buffer().clone();
        let content: String = (0..buffer.area.width)
            .map(|x| buffer.cell((x, 0)).unwrap().symbol().to_string())
            .collect();
        assert!(content.contains("unknown"));
        assert!(!content.contains("passwd"));
    }
}
