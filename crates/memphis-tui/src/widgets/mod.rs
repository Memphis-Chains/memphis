mod body;
mod notification;
mod prompt;
mod status_bar;

pub use body::{OutputBody, ScrollState};
pub use notification::NotificationBanner;
pub use prompt::PromptLine;
pub use status_bar::StatusBar;

use ratatui::style::{Color, Modifier, Style};

use crate::app::LineTone;

pub fn tone_to_style(tone: LineTone) -> Style {
    match tone {
        LineTone::Plain => Style::default().fg(Color::White),
        LineTone::Title => Style::default().fg(Color::White).add_modifier(Modifier::BOLD),
        LineTone::Header => Style::default().fg(Color::Blue),
        LineTone::Section => Style::default().fg(Color::Cyan).add_modifier(Modifier::BOLD),
        LineTone::Info => Style::default().fg(Color::Blue),
        LineTone::Success => Style::default().fg(Color::Green),
        LineTone::Warning => Style::default().fg(Color::Yellow),
        LineTone::Error => Style::default().fg(Color::Red),
        LineTone::Dim => Style::default().fg(Color::DarkGray).add_modifier(Modifier::DIM),
        LineTone::Accent => Style::default().fg(Color::Cyan),
        LineTone::Prompt => Style::default().fg(Color::White).add_modifier(Modifier::BOLD),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tone_to_style_maps_all_variants() {
        let tones = [
            LineTone::Plain,
            LineTone::Title,
            LineTone::Header,
            LineTone::Section,
            LineTone::Info,
            LineTone::Success,
            LineTone::Warning,
            LineTone::Error,
            LineTone::Dim,
            LineTone::Accent,
            LineTone::Prompt,
        ];
        for tone in tones {
            let style = tone_to_style(tone);
            assert_ne!(style, Style::default(), "tone {:?} should have styling", tone);
        }
    }
}
