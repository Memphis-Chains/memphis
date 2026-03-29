use ratatui::{
    buffer::Buffer,
    layout::Rect,
    style::{Color, Modifier, Style},
    text::{Line, Span},
    widgets::{Paragraph, Widget},
};

pub struct PromptLine<'a> {
    input: &'a str,
}

impl<'a> PromptLine<'a> {
    pub fn new(input: &'a str) -> Self {
        Self { input }
    }
}

impl Widget for PromptLine<'_> {
    fn render(self, area: Rect, buf: &mut Buffer) {
        let text = format!("> {}", self.input);
        let style = Style::default()
            .fg(Color::White)
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
    fn renders_prompt_with_input() {
        let backend = TestBackend::new(40, 1);
        let mut terminal = Terminal::new(backend).unwrap();

        terminal
            .draw(|frame| {
                frame.render_widget(PromptLine::new("hello world"), frame.area());
            })
            .unwrap();

        let buffer = terminal.backend().buffer().clone();
        let content: String = (0..buffer.area.width)
            .map(|x| buffer.cell((x, 0)).unwrap().symbol().to_string())
            .collect();
        assert!(content.contains("> hello world"));
    }

    #[test]
    fn renders_empty_prompt() {
        let backend = TestBackend::new(40, 1);
        let mut terminal = Terminal::new(backend).unwrap();

        terminal
            .draw(|frame| {
                frame.render_widget(PromptLine::new(""), frame.area());
            })
            .unwrap();

        let buffer = terminal.backend().buffer().clone();
        let content: String = (0..buffer.area.width)
            .map(|x| buffer.cell((x, 0)).unwrap().symbol().to_string())
            .collect();
        assert!(content.contains("> "));
    }
}
