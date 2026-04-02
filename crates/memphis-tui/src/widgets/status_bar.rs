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
    busy_frame: usize,
}

impl<'a> StatusBar<'a> {
    pub fn new(context: &'a StatusBarContext, timestamp: &'a str, busy_frame: usize) -> Self {
        Self {
            context,
            timestamp,
            busy_frame,
        }
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
        let context_window = self
            .context
            .context_window_tokens
            .map(format_context_window)
            .unwrap_or_else(|| "ctx:?".to_string());
        let token_usage = self
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

        let activity = if self.context.busy {
            let label = self.context.activity.as_deref().unwrap_or("task");
            if self.context.cancelling {
                if self.context.cancel_waiting_on_provider {
                    format!("cancelling {label} (provider wait)")
                } else {
                    format!("cancelling {label}")
                }
            } else {
                let spinner = ["|", "/", "-", "\\"][self.busy_frame % 4];
                format!("busy {spinner} {label}")
            }
        } else {
            "ready".to_string()
        };

        let mode = sanitize_for_tui(&self.context.cognitive_mode);
        let pulse = sanitize_for_tui(&self.context.pulse_health);

        let text = format!(
            "{degraded_icon}{indicator} [Mode:{mode}] {provider}/{model} · {context_window} · {token_usage} · {activity} · PULSE:{pulse} · session:{session} · {}",
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

fn format_context_window(tokens: u32) -> String {
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
}

fn format_status_token_usage(usage: &memphis_operator::TokenUsageSummary) -> String {
    if usage.estimated {
        format!("tok~:{}", usage.total_tokens)
    } else {
        format!("tok:{}", usage.total_tokens)
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
            context_window_tokens: Some(8192),
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
                frame.render_widget(StatusBar::new(&ctx, "14:32:05", 0), frame.area());
            })
            .unwrap();

        let buffer = terminal.backend().buffer().clone();
        let content: String = (0..buffer.area.width)
            .map(|x| buffer.cell((x, 0)).unwrap().symbol().to_string())
            .collect();
        assert!(content.contains("ollama"));
        assert!(content.contains("ctx:8k"));
        assert!(content.contains("tok:120"));
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
                frame.render_widget(StatusBar::new(&ctx, "14:32:05", 0), frame.area());
            })
            .unwrap();

        let buffer = terminal.backend().buffer().clone();
        let content: String = (0..buffer.area.width)
            .map(|x| buffer.cell((x, 0)).unwrap().symbol().to_string())
            .collect();
        assert!(content.contains("⚠"));
        assert!(content.contains("ollama"));
        assert!(content.contains("ctx:8k"));
        assert!(content.contains("tok:120"));
    }

    #[test]
    fn sanitizes_malicious_provider_name() {
        let mut ctx = make_context(false);
        ctx.provider = "../../etc/passwd".to_string();

        let backend = TestBackend::new(80, 1);
        let mut terminal = Terminal::new(backend).unwrap();

        terminal
            .draw(|frame| {
                frame.render_widget(StatusBar::new(&ctx, "14:32:05", 0), frame.area());
            })
            .unwrap();

        let buffer = terminal.backend().buffer().clone();
        let content: String = (0..buffer.area.width)
            .map(|x| buffer.cell((x, 0)).unwrap().symbol().to_string())
            .collect();
        assert!(content.contains("unknown"));
        assert!(content.contains("ctx:8k"));
        assert!(content.contains("tok:120"));
        assert!(!content.contains("passwd"));
    }

    #[test]
    fn renders_busy_spinner() {
        let mut ctx = make_context(false);
        ctx.busy = true;
        ctx.activity = Some("native chat".to_string());
        ctx.token_usage = Some(memphis_operator::TokenUsageSummary {
            prompt_tokens: 96,
            completion_tokens: 24,
            total_tokens: 120,
            estimated: true,
        });
        ctx.live_token_usage = Some(memphis_operator::TokenUsageSummary {
            prompt_tokens: 96,
            completion_tokens: 18,
            total_tokens: 114,
            estimated: false,
        });
        ctx.live_output_tokens = Some(18);

        let backend = TestBackend::new(80, 1);
        let mut terminal = Terminal::new(backend).unwrap();

        terminal
            .draw(|frame| {
                frame.render_widget(StatusBar::new(&ctx, "14:32:05", 1), frame.area());
            })
            .unwrap();

        let buffer = terminal.backend().buffer().clone();
        let content: String = (0..buffer.area.width)
            .map(|x| buffer.cell((x, 0)).unwrap().symbol().to_string())
            .collect();
        assert!(content.contains("busy / native chat"));
        assert!(content.contains("tok:114"));
    }
}
