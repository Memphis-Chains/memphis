mod app;
mod client;
mod config;
mod ui;

use std::time::Instant;

use app::{AppAction, AppState};
use client::MemphisClient;
use config::TuiConfig;
use crossterm::{
    event::{self, Event},
    execute,
    terminal::{disable_raw_mode, enable_raw_mode, EnterAlternateScreen, LeaveAlternateScreen},
};

struct TerminalGuard;

impl TerminalGuard {
    fn enter() -> std::io::Result<Self> {
        enable_raw_mode()?;
        execute!(std::io::stdout(), EnterAlternateScreen)?;
        Ok(Self)
    }
}

impl Drop for TerminalGuard {
    fn drop(&mut self) {
        let _ = disable_raw_mode();
        let _ = execute!(std::io::stdout(), LeaveAlternateScreen);
    }
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let config = TuiConfig::from_env();
    let client = MemphisClient::new();
    let mut app = AppState::new(config.clone());
    app.refresh(&client);

    let _terminal = TerminalGuard::enter()?;
    let mut last_refresh = Instant::now();

    loop {
        ui::draw(&app)?;

        if last_refresh.elapsed() >= config.refresh_interval {
            app.refresh(&client);
            last_refresh = Instant::now();
        }

        if event::poll(std::time::Duration::from_millis(250))? {
            if let Event::Key(key) = event::read()? {
                match app.handle_key(key) {
                    AppAction::Quit => break,
                    AppAction::Refresh => {
                        app.refresh(&client);
                        last_refresh = Instant::now();
                    }
                    AppAction::ExecuteCommand => {
                        app.execute_command(&client);
                    }
                    AppAction::None => {}
                }
            }
        }
    }

    Ok(())
}
