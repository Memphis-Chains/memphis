use std::io::{self, Write};

use chrono::Local;
use crossterm::{
    cursor::MoveTo,
    style::{
        Attribute, Color, Print, ResetColor, SetAttribute, SetBackgroundColor, SetForegroundColor,
    },
    terminal::{self, Clear, ClearType},
    QueueableCommand,
};

use crate::app::{AppState, LineTone, StatusBarContext, StyledLine};

pub fn draw(app: &AppState) -> io::Result<()> {
    let mut stdout = io::stdout();
    let (width, height) = terminal::size().unwrap_or((100, 30));
    let view = app.render_view();

    stdout.queue(Clear(ClearType::All))?;

    let body_rows = height.saturating_sub(2) as usize;
    let start = view.lines.len().saturating_sub(body_rows);
    for (idx, line) in view.lines[start..].iter().enumerate() {
        draw_line(&mut stdout, idx as u16, width, line)?;
    }

    if height >= 2 {
        draw_line(&mut stdout, height - 2, width, &view.footer)?;
    }

    if height >= 1 {
        draw_status_bar(
            &mut stdout,
            height - 1,
            width,
            &view.status,
            &Local::now().format("%H:%M:%S").to_string(),
        )?;
    }

    stdout.flush()
}

fn draw_line(stdout: &mut io::Stdout, row: u16, width: u16, line: &StyledLine) -> io::Result<()> {
    let rendered = trim_to_width(&line.content, width as usize);

    stdout.queue(MoveTo(0, row))?;
    stdout.queue(Clear(ClearType::CurrentLine))?;
    apply_line_style(stdout, line.tone)?;
    stdout.queue(Print(rendered))?;
    stdout.queue(ResetColor)?;
    stdout.queue(SetAttribute(Attribute::Reset))?;
    Ok(())
}

fn apply_line_style(stdout: &mut io::Stdout, tone: LineTone) -> io::Result<()> {
    let foreground = match tone {
        LineTone::Plain => Color::White,
        LineTone::Title => Color::White,
        LineTone::Header => Color::Blue,
        LineTone::Section => Color::Cyan,
        LineTone::Info => Color::Blue,
        LineTone::Success => Color::Green,
        LineTone::Warning => Color::Yellow,
        LineTone::Error => Color::Red,
        LineTone::Dim => Color::DarkGrey,
        LineTone::Accent => Color::Cyan,
        LineTone::Prompt => Color::White,
    };
    let attribute = match tone {
        LineTone::Title | LineTone::Section | LineTone::Prompt => Attribute::Bold,
        LineTone::Dim => Attribute::Dim,
        _ => Attribute::Reset,
    };

    stdout.queue(SetForegroundColor(foreground))?;
    stdout.queue(SetAttribute(attribute))?;
    Ok(())
}

fn draw_status_bar(
    stdout: &mut io::Stdout,
    row: u16,
    width: u16,
    context: &StatusBarContext,
    timestamp: &str,
) -> io::Result<()> {
    let rendered = pad_to_width(&format_status_bar(context, timestamp), width as usize);

    stdout.queue(MoveTo(0, row))?;
    stdout.queue(Clear(ClearType::CurrentLine))?;
    stdout.queue(SetBackgroundColor(Color::DarkBlue))?;
    stdout.queue(SetForegroundColor(Color::White))?;
    stdout.queue(SetAttribute(Attribute::Bold))?;
    stdout.queue(Print(trim_to_width(&rendered, width as usize)))?;
    stdout.queue(ResetColor)?;
    stdout.queue(SetAttribute(Attribute::Reset))?;
    Ok(())
}

fn format_status_bar(context: &StatusBarContext, timestamp: &str) -> String {
    let indicator = if context.connected { "●" } else { "○" };
    let activity = if context.busy {
        let label = context.activity.as_deref().unwrap_or("task");
        if context.cancelling {
            if context.cancel_waiting_on_provider {
                format!("cancelling {label} (provider wait)")
            } else {
                format!("cancelling {label}")
            }
        } else {
            format!("busy {label}")
        }
    } else {
        "ready".to_string()
    };
    format!(
        "{indicator} {} · {} · session:{} · {} · {}",
        context.provider, context.model, context.session_id, activity, timestamp
    )
}

fn trim_to_width(value: &str, width: usize) -> String {
    if width == 0 {
        return String::new();
    }
    let mut clipped = value.chars().take(width).collect::<String>();
    if clipped.chars().count() < value.chars().count() && width > 1 {
        clipped = clipped.chars().take(width.saturating_sub(1)).collect();
        clipped.push('…');
    }
    clipped
}

fn pad_to_width(value: &str, width: usize) -> String {
    let visible = value.chars().count();
    if visible >= width {
        return value.to_string();
    }

    format!("{value}{}", " ".repeat(width - visible))
}

#[cfg(test)]
mod tests {
    use super::{format_status_bar, trim_to_width};
    use crate::app::StatusBarContext;

    #[test]
    fn formats_connected_status_bar() {
        let context = StatusBarContext {
            connected: true,
            provider: "ollama".to_string(),
            model: "qwen2.5-coder:3b".to_string(),
            session_id: "mem0".to_string(),
            busy: false,
            activity: None,
            cancelling: false,
            cancel_waiting_on_provider: false,
        };

        let rendered = format_status_bar(&context, "14:32:05");

        assert_eq!(
            rendered,
            "● ollama · qwen2.5-coder:3b · session:mem0 · ready · 14:32:05"
        );
    }

    #[test]
    fn formats_cancelling_provider_wait_status_bar() {
        let context = StatusBarContext {
            connected: true,
            provider: "shared-llm".to_string(),
            model: "shared-llm".to_string(),
            session_id: "mem0".to_string(),
            busy: true,
            activity: Some("native chat".to_string()),
            cancelling: true,
            cancel_waiting_on_provider: true,
        };

        let rendered = format_status_bar(&context, "14:32:05");

        assert_eq!(
            rendered,
            "● shared-llm · shared-llm · session:mem0 · cancelling native chat (provider wait) · 14:32:05"
        );
    }

    #[test]
    fn trims_long_lines_with_ellipsis() {
        assert_eq!(trim_to_width("abcdefghijklmnopqrstuvwxyz", 8), "abcdefg…");
    }
}
