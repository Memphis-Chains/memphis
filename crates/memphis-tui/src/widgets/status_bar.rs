use ratatui::{
    buffer::Buffer,
    layout::Rect,
    style::{Color, Modifier, Style},
    text::{Line, Span},
    widgets::{Paragraph, Widget},
};

use crate::app::{ContextPressureLevel, StatusBarContext};
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

/// The busy indicator's frames.
///
/// Braille dots, not `| / - \`: a full-cell shape that flips between
/// two very different silhouettes reads as a blink, while a dot that
/// travels around a cell reads as a shimmer. On a saturated bar the
/// difference is the difference between a strobe and an indicator.
const SPINNER_FRAMES: [&str; 10] = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/// The status bar, split into the parts that need different styles.
///
/// The bar is one line of text, but the busy indicator has to be
/// quieter than the rest of it — it changes while the operator reads
/// something else, and the bar's own background makes every change
/// of that one cell a repaint of a saturated patch.
pub struct StatusBarParts {
    /// Everything before the activity segment.
    pub prefix: String,
    /// The busy indicator, if the session is busy.
    pub spinner: Option<String>,
    /// The activity segment: `busy`, `ready` or `cancelling …`.
    pub activity: String,
    /// Everything after the activity segment.
    pub suffix: String,
}

impl StatusBarParts {
    /// The whole bar as one string — what a test or a log wants.
    #[cfg(test)]
    pub fn text(&self) -> String {
        // The same assembly the widget does, space included — a test
        // that asserts on a different string than the screen shows is
        // a test of a second implementation.
        let spinner = self
            .spinner
            .as_ref()
            .map(|spinner| format!("{spinner} "))
            .unwrap_or_default();
        format!("{}{}{}{}", self.prefix, spinner, self.activity, self.suffix)
    }
}

/// Build the status bar's parts.
///
/// One source of truth: the widget renders these parts and the tests
/// read them, so the text a test asserts on is the text on the screen.
pub fn status_bar_parts(
    context: &StatusBarContext,
    timestamp: &str,
    busy_frame: usize,
) -> StatusBarParts {
    let indicator = if context.connected { "●" } else { "○" };
    let degraded_icon = if context.degraded { " ⚠" } else { "" };

    let provider = if validate_provider_name(&context.provider) {
        sanitize_for_tui(&context.provider)
    } else {
        "unknown".to_string()
    };
    let model = sanitize_for_tui(&context.model);
    let session = sanitize_for_tui(&context.session_id);
    let context_window = context
        .context_window_tokens
        .map(format_context_window)
        .unwrap_or_else(|| "ctx:?".to_string());
    let token_usage = context
        .live_token_usage
        .as_ref()
        .map(format_status_token_usage)
        .or_else(|| {
            context
                .live_output_tokens
                .map(|tokens| format!("out~:{tokens}"))
        })
        .or_else(|| {
            context
                .token_usage
                .as_ref()
                .map(format_status_token_usage)
        })
        .unwrap_or_else(|| "tok:?".to_string());
    let pressure = context
        .context_pressure
        .as_ref()
        .filter(|pressure| pressure.level != ContextPressureLevel::Low)
        .map(format_status_pressure);

    let (activity, spinner) = if context.busy {
        let label = context.activity.as_deref().unwrap_or("task");
        if context.cancelling {
            let text = if context.cancel_waiting_on_provider {
                format!("cancelling {label} (provider wait)")
            } else {
                format!("cancelling {label}")
            };
            (text, None)
        } else {
            (
                format!("busy {label}"),
                Some(SPINNER_FRAMES[busy_frame % SPINNER_FRAMES.len()].to_string()),
            )
        }
    } else {
        ("ready".to_string(), None)
    };

    let mode = sanitize_for_tui(&context.cognitive_mode);
    let pulse = sanitize_for_tui(&context.pulse_health);

    StatusBarParts {
        prefix: format!(
            "{degraded_icon}{indicator} [Mode:{mode}] {provider}/{model} · {context_window}{} · {token_usage} · ",
            pressure
                .as_ref()
                .map(|pressure| format!(" · {pressure}"))
                .unwrap_or_default(),
        ),
        spinner,
        activity,
        suffix: format!(" · PULSE:{pulse} · session:{session} · {timestamp}"),
    }
}

/// The whole status bar as one string.
#[cfg(test)]
pub fn status_bar_text(
    context: &StatusBarContext,
    timestamp: &str,
    busy_frame: usize,
) -> String {
    status_bar_parts(context, timestamp, busy_frame).text()
}

impl Widget for StatusBar<'_> {
    fn render(self, area: Rect, buf: &mut Buffer) {
        let parts = status_bar_parts(self.context, self.timestamp, self.busy_frame);

        let style = Style::default()
            .bg(Color::Rgb(0, 0, 128))
            .fg(Color::White)
            .add_modifier(Modifier::BOLD);
        // The indicator is quieter than the bar: a muted blue-white,
        // so a change of that one cell is a shimmer instead of a flash
        // of a saturated colour in the operator's peripheral vision.
        let indicator_style = Style::default()
            .bg(Color::Rgb(0, 0, 128))
            .fg(Color::Rgb(140, 160, 215));

        let width = area.width as usize;
        let used = parts.prefix.chars().count()
            + parts.spinner.as_ref().map(|s| s.chars().count()).unwrap_or(0)
            + parts.activity.chars().count()
            + parts.suffix.chars().count();
        let padding = width.saturating_sub(used);

        let mut spans: Vec<Span> = vec![Span::styled(parts.prefix, style)];
        if let Some(spinner) = parts.spinner {
            spans.push(Span::styled(format!("{spinner} "), indicator_style));
        }
        spans.push(Span::styled(parts.activity, style));
        spans.push(Span::styled(
            format!("{}{}", parts.suffix, " ".repeat(padding)),
            style,
        ));

        Paragraph::new(Line::from(spans)).render(area, buf);
    }
}

pub(crate) fn format_context_window(tokens: u32) -> String {
    if tokens >= 1_000 {
        if tokens.is_multiple_of(1_024) {
            format!("ctx:{}k", tokens / 1_024)
        } else if tokens.is_multiple_of(1_000) {
            format!("ctx:{}k", tokens / 1_000)
        } else {
            format!("ctx:{:.1}k", tokens as f32 / 1_000.0)
        }
    } else {
        format!("ctx:{tokens}")
    }
}

pub(crate) fn format_status_token_usage(usage: &memphis_operator::TokenUsageSummary) -> String {
    if usage.estimated {
        format!("tok~:{}", usage.total_tokens)
    } else {
        format!("tok:{}", usage.total_tokens)
    }
}

pub(crate) fn format_status_pressure(pressure: &crate::app::ContextPressureSummary) -> String {
    let remaining = if pressure.remaining_context_tokens >= 1_000 {
        if pressure.remaining_context_tokens.is_multiple_of(1_024) {
            format!("{}k", pressure.remaining_context_tokens / 1_024)
        } else if pressure.remaining_context_tokens.is_multiple_of(1_000) {
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
            context_pressure: Some(crate::app::ContextPressureSummary {
                level: crate::app::ContextPressureLevel::Low,
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
        assert!(content.contains("busy native chat"), "got: {content}");
        assert!(content.contains("tok:114"), "got: {content}");
        // The indicator is a braille dot, not a full-cell shape: a
        // shape that flips between two silhouettes is a blink, a dot
        // that travels around a cell is a shimmer.
        assert!(
            content.contains('⠋') || content.contains('⠙') || content.contains('⠹'),
            "the busy indicator must be a braille frame; got: {content}"
        );
    }

    #[test]
    fn renders_medium_pressure_segment() {
        let mut ctx = make_context(false);
        ctx.context_pressure = Some(crate::app::ContextPressureSummary {
            level: crate::app::ContextPressureLevel::Medium,
            remaining_context_tokens: 3200,
            estimated: false,
        });

        let backend = TestBackend::new(120, 1);
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
        assert!(content.contains("prs:med rem:3.2k"));
    }
}
