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

/// The panel never grows past this many columns — a keymap that spans
/// the whole terminal is a keymap nobody scans.
pub const PANEL_MAX_WIDTH: u16 = 80;

pub struct HelpOverlay;

impl HelpOverlay {
    /// Centered floating panel — 70% width or 80 cols (whichever is
    /// smaller), capped at the viewport.
    ///
    /// The height is derived from the keymap, so a key that is added
    /// to it cannot silently fall off the bottom of the panel. Before
    /// this the height was a hard-coded 22 rows while the keymap was
    /// 22 lines long — two rows of border on top — so the last two
    /// lines were clipped on every single render.
    pub fn area(parent: Rect) -> Rect {
        let max_w = parent.width.min(PANEL_MAX_WIDTH);
        let w = (parent.width as f32 * 0.70) as u16;
        let width = w.clamp(40, max_w);
        let wanted = keymap_lines().len() as u16 + 2; // + the border
        let height = wanted.min(parent.height.saturating_sub(2)).max(6);
        Rect {
            x: parent.x + (parent.width.saturating_sub(width)) / 2,
            y: parent.y + (parent.height.saturating_sub(height)) / 2,
            width,
            height,
        }
    }
}

/// The keymap the overlay shows.
///
/// It is a function, not a constant, because the overlay's height is
/// derived from it — a keymap that is taller than the panel would be
/// clipped, and a clipped keymap is a key the operator never finds.
///
/// The order matters: the sections the operator needs most come
/// first, the tips last, so a short terminal clips the tips and not
/// the keys.
fn keymap_lines() -> Vec<Line<'static>> {
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

    vec![
        Line::from(Span::styled("Memphis TUI — keymap", bold_cyan)),
        Line::from(""),
        Line::from(Span::styled("  scroll", dim)),
        kv("PageUp/PgDn", "scroll page"),
        kv("Ctrl+U/D", "half-page up / down"),
        kv("Alt+↑ / Alt+↓", "scroll one line"),
        kv("Home / g", "jump to top"),
        kv("End / G", "jump to bottom (auto-stick)"),
        kv("Mouse wheel", "scroll (mouse capture ON — toggle with F2)"),
        Line::from(""),
        Line::from(Span::styled("  input", dim)),
        kv("Enter", "send prompt"),
        kv("↑ / ↓", "previous / next prompt (history)"),
        kv("Alt+Enter", "newline (Enter still sends)"),
        kv("Esc", "clear the input"),
        kv("Ctrl+L", "clear screen"),
        Line::from(""),
        Line::from(Span::styled("  editing", dim)),
        kv("← / →", "move the caret"),
        kv("Delete", "delete forward"),
        kv("Ctrl+A / E", "start / end of the line"),
        Line::from(""),
        Line::from(Span::styled("  find & copy", dim)),
        kv("Ctrl+F", "search the scrollback (Enter = next hit)"),
        kv("Ctrl+Y", "copy the last answer (OSC 52)"),
        kv("F5 / Ctrl+R", "refresh"),
        Line::from(""),
        Line::from(Span::styled("  modes", dim)),
        kv("F2", "toggle mouse capture (scroll ↔ selection)"),
        kv("? / F1", "toggle this help"),
        kv("Esc / q", "close help"),
        Line::from(""),
        Line::from(vec![
            Span::raw("  "),
            Span::styled("Tip: when you scroll up, auto-stick disengages. ", plain),
            Span::styled("End", key),
            Span::styled(" re-engages it.", plain),
        ]),
        Line::from(vec![
            Span::raw("  "),
            Span::styled("Mouse capture is ON by default. ", plain),
            Span::styled("F2", key),
            Span::styled(" releases it for text selection.", plain),
        ]),
    ]
}

impl Widget for HelpOverlay {
    fn render(self, area: Rect, buf: &mut Buffer) {
        // Wipe the background so the underlying body doesn't bleed
        // through the modal — required for true overlay UX.
        Clear.render(area, buf);

        let bold_cyan = Style::default()
            .fg(Color::Cyan)
            .add_modifier(Modifier::BOLD);

        let lines = keymap_lines();

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

    /// The panel is sized from the keymap. A keymap that does not fit
    /// is clipped, and a clipped key is a key the operator never finds.
    #[test]
    fn the_panel_is_tall_enough_for_the_whole_keymap() {
        let parent = Rect::new(0, 0, 186, 42);
        let overlay = HelpOverlay::area(parent);
        let content_rows = overlay.height.saturating_sub(2); // the border
        assert!(
            content_rows as usize >= keymap_lines().len(),
            "the keymap has {} lines but the panel has {content_rows} content rows",
            keymap_lines().len(),
        );
    }

    /// The keys that came with the cockpit rework (ADR-011, Layer 1)
    /// have to be in the keymap — the operator cannot guess them.
    #[test]
    fn the_keymap_knows_the_cockpit_keys() {
        let backend = TestBackend::new(120, 40);
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

        for expected in [
            "Ctrl+F",
            "Ctrl+Y",
            "F5",
            "Alt+Enter",
            "Ctrl+A",
            "search the scrollback",
        ] {
            assert!(
                content.contains(expected),
                "the keymap must mention {expected}; it does not"
            );
        }
    }

    /// The tips used to be the two lines that fell off the bottom of
    /// the panel — they were clipped on every render.
    #[test]
    fn the_tips_are_not_clipped() {
        let backend = TestBackend::new(120, 40);
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
        assert!(
            content.contains("auto-stick disengages"),
            "the tip about auto-stick must be visible, not clipped"
        );
    }

    /// The panel's height is derived from the number of keymap lines,
    /// so a line that wraps would silently push the last line out of
    /// the panel. Every line has to fit the panel's text width.
    #[test]
    fn no_keymap_line_wraps_inside_the_panel() {
        let panel_text_width = PANEL_MAX_WIDTH.saturating_sub(2) as usize;
        for line in keymap_lines() {
            assert!(
                line.width() <= panel_text_width,
                "keymap line is {} columns wide, the panel fits {panel_text_width}: {:?}",
                line.width(),
                line.to_string(),
            );
        }
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
