use ratatui::{
    buffer::Buffer,
    layout::Rect,
    style::{Color, Modifier, Style},
    text::{Line, Span},
    widgets::{Paragraph, Widget},
};

use crate::sanitize::sanitize_reason;

pub struct NotificationBanner<'a> {
    message: &'a str,
}

impl<'a> NotificationBanner<'a> {
    pub fn new(message: &'a str) -> Self {
        Self { message }
    }
}

impl Widget for NotificationBanner<'_> {
    fn render(self, area: Rect, buf: &mut Buffer) {
        let safe_message = sanitize_reason(self.message);
        let text = format!("⚠  {safe_message}");

        let style = Style::default()
            .bg(Color::Yellow)
            .fg(Color::Black)
            .add_modifier(Modifier::BOLD);

        Paragraph::new(Line::from(Span::styled(text, style))).render(area, buf);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ratatui::backend::TestBackend;
    use ratatui::Terminal;

    #[test]
    fn renders_notification_banner() {
        let backend = TestBackend::new(60, 1);
        let mut terminal = Terminal::new(backend).unwrap();

        terminal
            .draw(|frame| {
                frame.render_widget(
                    NotificationBanner::new("deepseek in cooldown, using ollama"),
                    frame.area(),
                );
            })
            .unwrap();

        let buffer = terminal.backend().buffer().clone();
        let content: String = (0..buffer.area.width)
            .map(|x| buffer.cell((x, 0)).unwrap().symbol().to_string())
            .collect();
        assert!(content.contains("⚠"));
        assert!(content.contains("deepseek in cooldown"));
    }

    #[test]
    fn sanitizes_malicious_notification() {
        let backend = TestBackend::new(60, 1);
        let mut terminal = Terminal::new(backend).unwrap();

        terminal
            .draw(|frame| {
                frame.render_widget(
                    NotificationBanner::new("\x1b[31mmalicious\x1b[0m\x07"),
                    frame.area(),
                );
            })
            .unwrap();

        let buffer = terminal.backend().buffer().clone();
        let content: String = (0..buffer.area.width)
            .map(|x| buffer.cell((x, 0)).unwrap().symbol().to_string())
            .collect();
        assert!(content.contains("malicious"));
        assert!(!content.contains("\x1b"));
        assert!(!content.contains("\x07"));
    }
}
