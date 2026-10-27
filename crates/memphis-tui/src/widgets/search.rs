//! The scrollback search bar (ADR-011, E3).
//!
//! One row above the prompt, shown only while a search is open. It
//! shows the query and how many matches there are, because a search
//! that finds nothing must say so rather than look broken.

use ratatui::{
    buffer::Buffer,
    layout::Rect,
    style::{Color, Modifier, Style},
    text::{Line, Span},
    widgets::{Paragraph, Widget},
};

use crate::app::SearchState;

pub struct SearchBar<'a> {
    search: &'a SearchState,
}

impl<'a> SearchBar<'a> {
    pub fn new(search: &'a SearchState) -> Self {
        Self { search }
    }
}

impl Widget for SearchBar<'_> {
    fn render(self, area: Rect, buf: &mut Buffer) {
        let total = self.search.matches.len();
        let position = if total == 0 {
            0
        } else {
            self.search.current + 1
        };
        let counter = if total == 0 {
            "no matches".to_string()
        } else {
            format!("{position}/{total}")
        };

        let label = format!("/{}  {counter}", self.search.query);

        // A search that matched nothing is the case that needs the
        // operator's attention, so it is the case that gets colour.
        let style = if total == 0 {
            Style::default()
                .fg(Color::Yellow)
                .add_modifier(Modifier::BOLD)
        } else {
            Style::default()
                .fg(Color::Cyan)
                .add_modifier(Modifier::BOLD)
        };

        Paragraph::new(Line::from(Span::styled(label, style))).render(area, buf);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ratatui::backend::TestBackend;
    use ratatui::Terminal;

    fn render_bar(search: &SearchState) -> String {
        let backend = TestBackend::new(40, 1);
        let mut terminal = Terminal::new(backend).unwrap();
        terminal
            .draw(|frame| {
                frame.render_widget(SearchBar::new(search), frame.area());
            })
            .unwrap();
        let buffer = terminal.backend().buffer().clone();
        (0..buffer.area.width)
            .map(|x| buffer.cell((x, 0)).unwrap().symbol().to_string())
            .collect()
    }

    #[test]
    fn shows_the_query_and_the_match_count() {
        let search = SearchState {
            query: "rust".to_string(),
            matches: vec![3, 9, 14],
            current: 0,
        };
        let content = render_bar(&search);
        assert!(content.contains("/rust"), "got: {content}");
        assert!(content.contains("1/3"), "got: {content}");
    }

    #[test]
    fn says_so_when_nothing_matched() {
        let search = SearchState {
            query: "zzz".to_string(),
            matches: Vec::new(),
            current: 0,
        };
        let content = render_bar(&search);
        assert!(content.contains("no matches"), "got: {content}");
    }
}
