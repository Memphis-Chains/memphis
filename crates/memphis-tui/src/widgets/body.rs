use ratatui::{
    buffer::Buffer,
    layout::Rect,
    text::{Line, Span},
    widgets::{List, ListItem, ListState, StatefulWidget},
};

use crate::app::StyledLine;
use crate::sanitize::sanitize_for_tui;

use super::tone_to_style;

pub struct OutputBody<'a> {
    lines: &'a [StyledLine],
}

impl<'a> OutputBody<'a> {
    pub fn new(lines: &'a [StyledLine]) -> Self {
        Self { lines }
    }
}

#[derive(Debug, Default)]
pub struct ScrollState {
    pub list_state: ListState,
    pub auto_scroll: bool,
}

impl ScrollState {
    pub fn new() -> Self {
        Self {
            list_state: ListState::default(),
            auto_scroll: true,
        }
    }
}

impl StatefulWidget for OutputBody<'_> {
    type State = ScrollState;

    fn render(self, area: Rect, buf: &mut Buffer, state: &mut ScrollState) {
        let items: Vec<ListItem> = self
            .lines
            .iter()
            .map(|line| {
                let safe_content = sanitize_for_tui(&line.content);
                let style = tone_to_style(line.tone);
                ListItem::new(Line::from(Span::styled(safe_content, style)))
            })
            .collect();

        if state.auto_scroll && !items.is_empty() {
            state.list_state.select(Some(items.len() - 1));
        }

        let list = List::new(items);
        StatefulWidget::render(list, area, buf, &mut state.list_state);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app::LineTone;
    use ratatui::backend::TestBackend;
    use ratatui::Terminal;

    #[test]
    fn output_body_renders_lines() {
        let backend = TestBackend::new(40, 5);
        let mut terminal = Terminal::new(backend).unwrap();
        let lines = vec![
            StyledLine {
                content: "hello".to_string(),
                tone: LineTone::Info,
            },
            StyledLine {
                content: "world".to_string(),
                tone: LineTone::Success,
            },
        ];
        let mut scroll = ScrollState::new();

        terminal
            .draw(|frame| {
                let area = frame.area();
                frame.render_stateful_widget(OutputBody::new(&lines), area, &mut scroll);
            })
            .unwrap();

        let buffer = terminal.backend().buffer().clone();
        let content = (0..buffer.area.width)
            .map(|x| buffer.cell((x, 0)).unwrap().symbol().to_string())
            .collect::<String>();
        assert!(content.contains("hello"));
    }

    #[test]
    fn auto_scroll_selects_last_item() {
        let lines = vec![
            StyledLine {
                content: "a".to_string(),
                tone: LineTone::Plain,
            },
            StyledLine {
                content: "b".to_string(),
                tone: LineTone::Plain,
            },
            StyledLine {
                content: "c".to_string(),
                tone: LineTone::Plain,
            },
        ];
        let mut scroll = ScrollState::new();
        assert!(scroll.auto_scroll);

        let backend = TestBackend::new(20, 3);
        let mut terminal = Terminal::new(backend).unwrap();
        terminal
            .draw(|frame| {
                frame.render_stateful_widget(
                    OutputBody::new(&lines),
                    frame.area(),
                    &mut scroll,
                );
            })
            .unwrap();

        assert_eq!(scroll.list_state.selected(), Some(2));
    }

    #[test]
    fn sanitizes_ansi_in_output() {
        let lines = vec![StyledLine {
            content: "\x1b[31mmalicious\x1b[0m".to_string(),
            tone: LineTone::Plain,
        }];
        let mut scroll = ScrollState::new();
        let backend = TestBackend::new(40, 3);
        let mut terminal = Terminal::new(backend).unwrap();

        terminal
            .draw(|frame| {
                frame.render_stateful_widget(
                    OutputBody::new(&lines),
                    frame.area(),
                    &mut scroll,
                );
            })
            .unwrap();

        let buffer = terminal.backend().buffer().clone();
        let content: String = (0..buffer.area.width)
            .map(|x| buffer.cell((x, 0)).unwrap().symbol().to_string())
            .collect();
        assert!(content.contains("malicious"));
        assert!(!content.contains("\x1b"));
    }
}
