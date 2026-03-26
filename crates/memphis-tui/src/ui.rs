use std::io::{self, Write};

use crossterm::{
    cursor::MoveTo,
    style::{Attribute, Print, SetAttribute},
    terminal::{self, Clear, ClearType},
    QueueableCommand,
};

use crate::app::AppState;

pub fn draw(app: &AppState) -> io::Result<()> {
    let mut stdout = io::stdout();
    let (width, height) = terminal::size().unwrap_or((100, 30));
    let max_lines = height.saturating_sub(1) as usize;

    stdout.queue(Clear(ClearType::All))?;
    stdout.queue(MoveTo(0, 0))?;

    for (idx, line) in app.render_lines().into_iter().take(max_lines).enumerate() {
        stdout.queue(MoveTo(0, idx as u16))?;
        if idx == 0 {
            stdout.queue(SetAttribute(Attribute::Bold))?;
            stdout.queue(Print(trim_to_width(&line, width as usize)))?;
            stdout.queue(SetAttribute(Attribute::Reset))?;
        } else {
            stdout.queue(Print(trim_to_width(&line, width as usize)))?;
        }
    }

    stdout.flush()
}

fn trim_to_width(value: &str, width: usize) -> String {
    if width == 0 {
        return String::new();
    }
    let mut clipped = value.chars().take(width).collect::<String>();
    if clipped.len() < value.len() && width > 1 {
        clipped.truncate(width.saturating_sub(1));
        clipped.push('…');
    }
    clipped
}
