use ratatui::{
    buffer::Buffer,
    layout::Rect,
    text::{Line, Span},
    widgets::{Paragraph, StatefulWidget, Widget},
};

use crate::app::{LineTone, StyledLine};
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
    pub offset: usize,
    pub auto_scroll: bool,
    viewport_height: usize,
    content_height: usize,
}

impl ScrollState {
    pub fn new() -> Self {
        Self {
            offset: 0,
            auto_scroll: true,
            viewport_height: 0,
            content_height: 0,
        }
    }

    pub fn scroll_up(&mut self, lines: usize) {
        self.auto_scroll = false;
        self.offset = self.offset.saturating_sub(lines);
    }

    pub fn scroll_down(&mut self, lines: usize) {
        self.offset = self.offset.saturating_add(lines).min(self.max_offset());
        self.auto_scroll = self.offset >= self.max_offset();
    }

    pub fn page_up(&mut self) {
        let amount = self.viewport_height.max(1).saturating_sub(1).max(1);
        self.scroll_up(amount);
    }

    pub fn page_down(&mut self) {
        let amount = self.viewport_height.max(1).saturating_sub(1).max(1);
        self.scroll_down(amount);
    }

    pub fn scroll_to_top(&mut self) {
        self.auto_scroll = false;
        self.offset = 0;
    }

    pub fn scroll_to_bottom(&mut self) {
        self.auto_scroll = true;
        self.offset = self.max_offset();
    }

    fn sync_viewport(&mut self, content_height: usize, viewport_height: usize) {
        self.content_height = content_height;
        self.viewport_height = viewport_height;
        if self.auto_scroll {
            self.offset = self.max_offset();
        } else {
            self.offset = self.offset.min(self.max_offset());
        }
    }

    fn max_offset(&self) -> usize {
        self.content_height
            .saturating_sub(self.viewport_height.max(1))
    }
}

fn wrap_single_line(value: &str, width: usize) -> Vec<String> {
    if width == 0 {
        return Vec::new();
    }
    if value.is_empty() {
        return vec![String::new()];
    }

    let chars = value.chars().collect::<Vec<_>>();
    let mut wrapped = Vec::new();
    let mut start = 0usize;

    while start < chars.len() {
        let hard_end = (start + width).min(chars.len());
        if hard_end == chars.len() {
            wrapped.push(chars[start..hard_end].iter().collect::<String>());
            break;
        }

        let mut split = hard_end;
        while split > start && !chars[split - 1].is_whitespace() {
            split -= 1;
        }
        if split == start {
            split = hard_end;
        }

        let segment = chars[start..split]
            .iter()
            .collect::<String>()
            .trim_end()
            .to_string();
        wrapped.push(segment);

        start = split;
        while start < chars.len() && chars[start].is_whitespace() {
            start += 1;
        }
    }

    if wrapped.is_empty() {
        wrapped.push(String::new());
    }

    wrapped
}

fn wrap_styled_lines(lines: &[StyledLine], width: usize) -> Vec<StyledLine> {
    let mut wrapped = Vec::new();

    for line in lines {
        let safe_content = sanitize_for_tui(&line.content);
        let raw_lines = if safe_content.is_empty() {
            vec![String::new()]
        } else {
            safe_content
                .split('\n')
                .map(ToString::to_string)
                .collect::<Vec<_>>()
        };

        for raw_line in raw_lines {
            for segment in wrap_single_line(raw_line.as_str(), width) {
                wrapped.push(StyledLine {
                    content: segment,
                    tone: line.tone,
                });
            }
        }
    }

    if wrapped.is_empty() {
        wrapped.push(StyledLine {
            content: String::new(),
            tone: LineTone::Plain,
        });
    }

    wrapped
}

impl StatefulWidget for OutputBody<'_> {
    type State = ScrollState;

    fn render(self, area: Rect, buf: &mut Buffer, state: &mut ScrollState) {
        if area.width == 0 || area.height == 0 {
            state.sync_viewport(0, 0);
            return;
        }

        let wrapped_lines = wrap_styled_lines(self.lines, area.width as usize);
        state.sync_viewport(wrapped_lines.len(), area.height as usize);

        let start = state.offset.min(state.max_offset());
        let end = (start + area.height as usize).min(wrapped_lines.len());
        let visible = &wrapped_lines[start..end];

        let paragraph_lines = visible
            .iter()
            .map(|line| Line::from(Span::styled(line.content.clone(), tone_to_style(line.tone))))
            .collect::<Vec<_>>();

        Paragraph::new(paragraph_lines).render(area, buf);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app::LineTone;
    use ratatui::backend::TestBackend;
    use ratatui::Terminal;

    fn row_content(terminal: &Terminal<TestBackend>, row: u16) -> String {
        let buffer = terminal.backend().buffer().clone();
        (0..buffer.area.width)
            .map(|x| buffer.cell((x, row)).unwrap().symbol().to_string())
            .collect::<String>()
    }

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

        let content = row_content(&terminal, 0);
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
                frame.render_stateful_widget(OutputBody::new(&lines), frame.area(), &mut scroll);
            })
            .unwrap();

        assert_eq!(scroll.offset, 0);
        assert!(scroll.auto_scroll);
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
                frame.render_stateful_widget(OutputBody::new(&lines), frame.area(), &mut scroll);
            })
            .unwrap();

        let content = row_content(&terminal, 0);
        assert!(content.contains("malicious"));
        assert!(!content.contains("\x1b"));
    }

    #[test]
    fn wraps_long_lines_to_viewport_width() {
        let lines = vec![StyledLine {
            content: "alpha beta gamma delta".to_string(),
            tone: LineTone::Plain,
        }];
        let mut scroll = ScrollState::new();
        let backend = TestBackend::new(10, 4);
        let mut terminal = Terminal::new(backend).unwrap();

        terminal
            .draw(|frame| {
                frame.render_stateful_widget(OutputBody::new(&lines), frame.area(), &mut scroll);
            })
            .unwrap();

        let first = row_content(&terminal, 0);
        let second = row_content(&terminal, 1);
        let third = row_content(&terminal, 2);
        assert!(first.contains("alpha"));
        assert!(second.contains("beta"));
        assert!(third.contains("gamma"));
    }

    #[test]
    fn scroll_state_can_show_older_history() {
        let lines = (1..=6)
            .map(|index| StyledLine {
                content: format!("line {index}"),
                tone: LineTone::Plain,
            })
            .collect::<Vec<_>>();
        let mut scroll = ScrollState::new();
        let backend = TestBackend::new(12, 3);
        let mut terminal = Terminal::new(backend).unwrap();

        terminal
            .draw(|frame| {
                frame.render_stateful_widget(OutputBody::new(&lines), frame.area(), &mut scroll);
            })
            .unwrap();

        assert_eq!(row_content(&terminal, 0).trim(), "line 4");
        assert_eq!(row_content(&terminal, 2).trim(), "line 6");

        scroll.scroll_up(2);
        terminal
            .draw(|frame| {
                frame.render_stateful_widget(OutputBody::new(&lines), frame.area(), &mut scroll);
            })
            .unwrap();

        assert_eq!(row_content(&terminal, 0).trim(), "line 2");
        assert_eq!(row_content(&terminal, 2).trim(), "line 4");
        assert!(!scroll.auto_scroll);

        scroll.scroll_to_bottom();
        terminal
            .draw(|frame| {
                frame.render_stateful_widget(OutputBody::new(&lines), frame.area(), &mut scroll);
            })
            .unwrap();

        assert_eq!(row_content(&terminal, 0).trim(), "line 4");
        assert!(scroll.auto_scroll);
    }
}
