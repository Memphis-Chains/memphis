//! Help overlay — modal showing the TUI keymap.
//!
//! Toggled by `?` (or `F1`). Closes on `Esc`, `?`, `q`, or `Enter`.
//! Renders centered on the available frame area as a Block + Paragraph.
//! Same styling palette as the rest of the TUI (cyan accents on
//! darker background) so it doesn't feel grafted on.

use ratatui::{
    buffer::Buffer,
    layout::{Alignment, Rect},
    style::{Color, Modifier, Style},
    text::{Line, Span},
    widgets::{Block, BorderType, Borders, Clear, Paragraph, Widget, Wrap},
};

pub struct HelpOverlay;

impl HelpOverlay {
    /// Centered floating panel — 70% width or 80 cols (whichever is
    /// smaller), capped at the viewport. Height grows with the keymap;
    /// if the parent area is shorter, ratatui clips and the operator
    /// can scroll the underlying body — the overlay is informational
    /// only, not a long-form doc.
    pub fn area(parent: Rect) -> Rect {
        let max_w = parent.width.min(80);
        let w = (parent.width as f32 * 0.70) as u16;
        let width = w.clamp(40, max_w);
        let height = 22u16.min(parent.height.saturating_sub(2));
        Rect {
            x: parent.x + (parent.width.saturating_sub(width)) / 2,
            y: parent.y + (parent.height.saturating_sub(height)) / 2,
            width,
            height,
        }
    }
}

impl Widget for HelpOverlay {
    fn render(self, area: Rect, buf: &mut Buffer) {
        // Wipe the background so the underlying body doesn't bleed
        // through the modal — required for true overlay UX.
        Clear.render(area, buf);

        let bold_cyan = Style::default()
            .fg(Color::Cyan)
            .add_modifier(Modifier::BOLD);
        let key = Style::default()
            .fg(Color::Yellow)
            .add_modifier(Modifier::BOLD);
        let plain = Style::default().fg(Color::White);
        let dim = Style::default().fg(Color::DarkGray);

        let kv = |k: &'static str, v: &'static str| {
            Line::from(vec![
                Span::raw("  "),
                Span::styled(format!("{:<14}", k), key),
                Span::styled(v.to_string(), plain),
            ])
        };

        let lines = vec![
            Line::from(Span::styled("Memphis TUI — keymap", bold_cyan)),
            Line::from(""),
            Line::from(Span::styled("  scroll", dim)),
            kv("PageUp/PgDn", "scroll page"),
            kv("Ctrl+U/D", "half-page up / down"),
            kv("Alt+↑ / Alt+↓", "scroll one line"),
            kv("Home / g", "jump to top"),
            kv("End / G", "jump to bottom (auto-stick)"),
            kv("Mouse wheel", "scroll (when terminal supports it)"),
            Line::from(""),
            Line::from(Span::styled("  input & history", dim)),
            kv("↑ / ↓", "previous / next prompt (history)"),
            kv("Enter", "send prompt"),
            kv("Ctrl+L", "clear screen"),
            Line::from(""),
            Line::from(Span::styled("  modal", dim)),
            kv("? / F1", "toggle this help"),
            kv("Esc / q", "close help"),
            Line::from(""),
            Line::from(vec![
                Span::raw("  "),
                Span::styled(
                    "Tip: when you scroll up, auto-stick disengages. ",
                    plain,
                ),
                Span::styled("End", key),
                Span::styled(" re-engages it.", plain),
            ]),
        ];

        let block = Block::default()
            .borders(Borders::ALL)
            .border_type(BorderType::Rounded)
            .border_style(bold_cyan)
            .title(Span::styled(" help ", bold_cyan))
            .title_alignment(Alignment::Center);
        Paragraph::new(lines)
            .block(block)
            .wrap(Wrap { trim: false })
            .render(area, buf);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ratatui::backend::TestBackend;
    use ratatui::Terminal;

    #[test]
    fn renders_help_overlay_with_keymap() {
        let backend = TestBackend::new(120, 30);
        let mut terminal = Terminal::new(backend).unwrap();
        terminal
            .draw(|frame| {
                let area = HelpOverlay::area(frame.area());
                frame.render_widget(HelpOverlay, area);
            })
            .unwrap();

        let buffer = terminal.backend().buffer().clone();
        let mut content = String::new();
        for y in 0..buffer.area.height {
            for x in 0..buffer.area.width {
                content.push_str(buffer.cell((x, y)).unwrap().symbol());
            }
            content.push('\n');
        }
        assert!(content.contains("keymap"), "title shows");
        assert!(content.contains("PageUp"), "scroll keys listed");
        assert!(content.contains("Mouse wheel"), "mouse hint listed");
        assert!(content.contains("auto-stick"), "stick behavior explained");
    }

    #[test]
    fn area_centers_in_parent() {
        let parent = Rect::new(0, 0, 200, 50);
        let overlay = HelpOverlay::area(parent);
        // Centered horizontally
        assert!(overlay.x > 0);
        assert!(overlay.x + overlay.width < parent.width);
        // Capped at 80 cols
        assert!(overlay.width <= 80);
    }
}
