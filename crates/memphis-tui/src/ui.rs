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

const RENDERER_MODE: &str = "diff-lines";

#[derive(Debug, Clone, PartialEq, Eq)]
enum FrameRowKind {
    Line(LineTone),
    StatusBar,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct FrameRow {
    content: String,
    kind: FrameRowKind,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct RenderedFrame {
    width: u16,
    height: u16,
    rows: Vec<FrameRow>,
}

#[derive(Debug, Default)]
pub struct UiRenderer {
    previous_frame: Option<RenderedFrame>,
}

impl UiRenderer {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn mode(&self) -> &'static str {
        RENDERER_MODE
    }

    pub fn draw(&mut self, app: &AppState) -> io::Result<()> {
        let mut stdout = io::stdout();
        let (width, height) = terminal::size().unwrap_or((100, 30));
        let timestamp = Local::now().format("%H:%M:%S").to_string();
        let frame = build_frame(app, width, height, timestamp.as_str());
        let full_redraw = self
            .previous_frame
            .as_ref()
            .map(|previous| previous.width != width || previous.height != height)
            .unwrap_or(true);

        let wrote = write_frame_diff(
            &mut stdout,
            &frame,
            self.previous_frame.as_ref(),
            full_redraw,
        )?;
        if wrote {
            stdout.flush()?;
        }
        self.previous_frame = Some(frame);
        Ok(())
    }
}

pub fn renderer_mode() -> &'static str {
    RENDERER_MODE
}

fn draw_line<W>(stdout: &mut W, row: u16, width: u16, line: &StyledLine) -> io::Result<()>
where
    W: Write,
{
    stdout.queue(MoveTo(0, row))?;
    stdout.queue(Clear(ClearType::CurrentLine))?;
    apply_line_style(stdout, line.tone)?;
    stdout.queue(Print(trim_to_width(&line.content, width as usize)))?;
    stdout.queue(ResetColor)?;
    stdout.queue(SetAttribute(Attribute::Reset))?;
    Ok(())
}

fn apply_line_style<W>(stdout: &mut W, tone: LineTone) -> io::Result<()>
where
    W: Write,
{
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

fn draw_status_bar<W>(stdout: &mut W, row: u16, width: u16, rendered: &str) -> io::Result<()>
where
    W: Write,
{
    let rendered = pad_to_width(rendered, width as usize);
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

fn build_frame(app: &AppState, width: u16, height: u16, timestamp: &str) -> RenderedFrame {
    let view = app.render_view();
    let mut rows = vec![
        FrameRow {
            content: String::new(),
            kind: FrameRowKind::Line(LineTone::Plain),
        };
        height as usize
    ];

    let body_rows = height.saturating_sub(2) as usize;
    let start = view.lines.len().saturating_sub(body_rows);
    for (idx, line) in view.lines[start..].iter().enumerate() {
        if idx >= rows.len() {
            break;
        }
        rows[idx] = FrameRow {
            content: line.content.clone(),
            kind: FrameRowKind::Line(line.tone),
        };
    }

    if height >= 2 {
        rows[(height - 2) as usize] = FrameRow {
            content: view.footer.content,
            kind: FrameRowKind::Line(view.footer.tone),
        };
    }

    if height >= 1 {
        rows[(height - 1) as usize] = FrameRow {
            content: format_status_bar(&view.status, timestamp),
            kind: FrameRowKind::StatusBar,
        };
    }

    RenderedFrame {
        width,
        height,
        rows,
    }
}

fn write_frame_diff<W>(
    stdout: &mut W,
    frame: &RenderedFrame,
    previous: Option<&RenderedFrame>,
    full_redraw: bool,
) -> io::Result<bool>
where
    W: Write,
{
    if full_redraw {
        stdout.queue(Clear(ClearType::All))?;
    }

    let mut wrote = full_redraw;

    for (index, row) in frame.rows.iter().enumerate() {
        let changed = previous
            .and_then(|previous| previous.rows.get(index))
            .map(|previous_row| previous_row != row)
            .unwrap_or(true);

        if !full_redraw && !changed {
            continue;
        }

        match row.kind {
            FrameRowKind::Line(tone) => {
                let line = StyledLine {
                    content: row.content.clone(),
                    tone,
                };
                draw_line(stdout, index as u16, frame.width, &line)?;
            }
            FrameRowKind::StatusBar => {
                draw_status_bar(stdout, index as u16, frame.width, &row.content)?;
            }
        }
        wrote = true;
    }

    Ok(wrote)
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
    use super::{
        build_frame, format_status_bar, renderer_mode, trim_to_width, write_frame_diff,
        FrameRowKind, UiRenderer,
    };
    use crate::{
        app::{AppState, LineTone, StatusBarContext},
        config::TuiConfig,
    };
    use std::{path::PathBuf, time::Duration};

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

    #[test]
    fn renderer_reports_diff_mode() {
        let renderer = UiRenderer::new();
        assert_eq!(renderer.mode(), "diff-lines");
        assert_eq!(renderer_mode(), "diff-lines");
    }

    #[test]
    fn build_frame_fills_body_footer_and_status_rows() {
        let mut app = AppState::new(TuiConfig {
            data_dir: PathBuf::from("/tmp/memphis"),
            refresh_interval: Duration::from_secs(3),
        });
        app.output_buffer.push(crate::app::StyledLine {
            content: "hello memphis".to_string(),
            tone: LineTone::Info,
        });

        let frame = build_frame(&app, 40, 8, "10:15:30");

        assert_eq!(frame.rows.len(), 8);
        assert_eq!(frame.rows[0].kind, FrameRowKind::Line(LineTone::Title));
        assert!(frame.rows[1].content.contains("Single-view cockpit"));
        assert!(frame.rows[4].content.contains("hello memphis"));
        assert_eq!(frame.rows[6].content, "> ");
        assert!(frame.rows[7].content.contains("10:15:30"));
    }

    #[test]
    fn diff_writer_skips_identical_frames() {
        let mut app = AppState::new(TuiConfig {
            data_dir: PathBuf::from("/tmp/memphis"),
            refresh_interval: Duration::from_secs(3),
        });
        app.output_buffer.push(crate::app::StyledLine {
            content: "steady".to_string(),
            tone: LineTone::Plain,
        });

        let frame = build_frame(&app, 50, 5, "10:15:30");
        let mut first = Vec::new();
        let wrote_first = write_frame_diff(&mut first, &frame, None, true).expect("first draw");

        let mut second = Vec::new();
        let wrote_second =
            write_frame_diff(&mut second, &frame, Some(&frame), false).expect("second draw");

        assert!(wrote_first);
        assert!(!first.is_empty());
        assert!(!wrote_second);
        assert!(second.is_empty());
    }

    #[test]
    fn diff_writer_updates_only_changed_rows_without_full_clear() {
        let mut app = AppState::new(TuiConfig {
            data_dir: PathBuf::from("/tmp/memphis"),
            refresh_interval: Duration::from_secs(3),
        });
        let previous = build_frame(&app, 60, 5, "10:15:30");

        app.input_buffer = "hello".to_string();
        let current = build_frame(&app, 60, 5, "10:15:31");

        let mut output = Vec::new();
        let wrote =
            write_frame_diff(&mut output, &current, Some(&previous), false).expect("diff draw");
        let rendered = String::from_utf8_lossy(&output);

        assert!(wrote);
        assert!(!rendered.contains("\u{1b}[2J"));
        assert!(rendered.contains("hello"));
    }
}
