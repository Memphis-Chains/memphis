# Memphis Rust TUI — Complete Reference

The Memphis Rust TUI (`crates/memphis-tui`) is a single-view terminal cockpit backed by `memphis-operator`. It provides real-time monitoring, interactive chat, and operator commands in a RAT-based UI.

---

## Architecture Overview

```
┌─────────────────────────────────────────────┐
│  StatusBar  (1 line, blue background)      │
├─────────────────────────────────────────────┤
│                                             │
│  OutputBody  (scrollable, tone-styled)      │
│  output_buffer: Vec<StyledLine>             │
│  auto_scroll: bool + offset: usize          │
│                                             │
├─────────────────────────────────────────────┤
│  PromptLine  "> input here..."              │
└─────────────────────────────────────────────┘
```

- **Output buffer limit**: 1200 lines max (`OUTPUT_BUFFER_LIMIT`). Oldest lines are drained when exceeded.
- **Auto-scroll**: enabled by default. Any scroll action (`Up`, `Down`, `PageUp`, `PageDown`, `Home`, `End`) disables it. `End` / `ScrollBottom` re-enables it.
- **Refresh**: background poll every 250ms idle, 50ms when a command is running. Automatic refresh every `refresh_interval` (configurable via env).
- **Input routing**: plain text → native chat (streamed). `/`-prefixed → command parser.

---

## Screen: (Single View — All Surfaces Append to One Output Buffer)

The TUI is **single-view**: there is no screen-switching UI. Instead, `/overview`, `/chat`, `/memory`, `/sessions`, `/vault`, `/cases`, and `/system` are commands that **append** their rendered surface to the shared `output_buffer`. Each surface is a block of styled lines; subsequent commands accumulate below.

### Keys

| Key                | Action                                                     |
| ------------------ | ---------------------------------------------------------- |
| `Enter`            | Submit input (chat or command)                             |
| `Ctrl+C`           | Interrupt active command, or quit if none running          |
| `Ctrl+L`           | Clear output buffer                                        |
| `Ctrl+R`           | Force immediate refresh                                    |
| `Esc`              | Clear input buffer, exit history navigation                |
| `Backspace`        | Delete last character from input                           |
| `Up`               | Navigate input history backward (or Alt+Up = scroll up)    |
| `Down`             | Navigate input history forward (or Alt+Down = scroll down) |
| `PageUp`           | Page up in output                                          |
| `PageDown`         | Page down in output                                        |
| `Home` / `Alt+Up`  | Scroll to top                                              |
| `End` / `Alt+Down` | Scroll to bottom                                           |
| `Alt+Up`           | Scroll output up 1 line (disables auto-scroll)             |
| `Alt+Down`         | Scroll output down 1 line                                  |

### Commands

All commands are entered at the prompt. Prefix `/` is required for all commands except plain chat.

#### Native Commands (processed directly in Rust)

| Command                    | Description                                                          |
| -------------------------- | -------------------------------------------------------------------- |
| `/help`                    | Print all available commands grouped by route                        |
| `/clear`                   | Clear the output buffer                                              |
| `/refresh`                 | Force immediate snapshot refresh                                     |
| `/overview`                | Append Overview surface to output                                    |
| `/chat`                    | Append Chat surface (session, provider, model, context pressure)     |
| `/memory`                  | Append Memory surface (semantic + exact search state)                |
| `/sessions`                | Append Sessions surface (recent operator sessions)                   |
| `/vault`                   | Append Vault surface (metadata-first entry listing)                  |
| `/cases`                   | Append Cases surface (recent case rows)                              |
| `/system`                  | Append System surface (runtime paths, Matrix, Telegram, Rust bridge) |
| `/providers`               | Print provider status table (name, model, [up]/[down][!]/[nocfg])    |
| `/models`                  | Print models per provider                                            |
| `/provider <name>`         | Set active chat provider                                             |
| `/provider set <name>`     | Set active chat provider (same as above)                             |
| `/model <id>`              | Set active chat model                                                |
| `/model set <id>`          | Set active chat model                                                |
| `/session <id>`            | Switch to a named chat session; prints transcript                    |
| `/telegram`                | Append Telegram readiness surface                                    |
| `/telegram status`         | Same as `/telegram`                                                  |
| `/memory semantic <query>` | Run semantic memory search, append results                           |
| `/memory exact <query>`    | Run exact phrase memory search, append results                       |
| `/vault get <key>`         | Read a vault secret (warns: plaintext displayed)                     |

#### Host-Backed Commands (routed through TypeScript extension host)

| Command                                                      | Description                                                                    |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------ |
| `/health`                                                    | Health check (memory recall mode, embeddings, exact search, cognition, repair) |
| `/pulse`                                                     | PULSE heartbeat summary                                                        |
| `/pulse status`                                              | Same as `/pulse`                                                               |
| `/init status`                                               | First-run / initialization state                                               |
| `/doctor [--fix] [--force] [--deep]`                         | Run diagnostic checks                                                          |
| `/agents list`                                               | List discovered agents                                                         |
| `/agents discover`                                           | Discover agents                                                                |
| `/agents show <did>`                                         | Show agent details by DID                                                      |
| `/sync status [--chain <name>]`                              | Sync status for a chain (default: journal)                                     |
| `/apps list`                                                 | List managed app manifests                                                     |
| `/apps show <id>`                                            | Show a managed app manifest                                                    |
| `/apps show --file <manifest.json>`                          | Show a manifest from a file                                                    |
| `/apps plan <id> [--file <manifest.json>] [--action <name>]` | Plan an app action                                                             |
| `/reflect [--save]`                                          | Run reflect (self-reasoning)                                                   |
| `/insights [--daily\|--weekly\|--topic <topic>] [--save]`    | Generate insights                                                              |
| `/knowledge <topic>`                                         | Query knowledge base                                                           |
| `/knowledge status`                                          | Show knowledge source status                                                   |
| `/knowledge sources`                                         | Same as `/knowledge status`                                                    |
| `/mode`                                                      | Get current cognitive mode                                                     |
| `/mode <A\|B\|C\|D\|E>`                                      | Set cognitive mode                                                             |
| `/config tools list`                                         | List tool permission rules                                                     |
| `/config tools check <tool>`                                 | Check if a tool is allowed                                                     |
| `/config tools pending`                                      | List pending tool approvals                                                    |
| `/config surfaces list`                                      | List surface policies                                                          |
| `/config surfaces check <surface>`                           | Check a surface policy                                                         |
| `/config surfaces set <surface> <setting> <value>`           | Apply a surface override                                                       |
| `/config surfaces reset <surface> [setting]`                 | Reset surface override(s)                                                      |
| `/telegram send <message>`                                   | Send a Telegram message (default chat)                                         |
| `/telegram send --to <chatId> <message>`                     | Send to a specific chat ID                                                     |

#### Legacy Command

| Command                         | Description                                                                                    |
| ------------------------------- | ---------------------------------------------------------------------------------------------- |
| `/legacy <memphis cli args...>` | Escape hatch: routes directly through `memphis --json` CLI. Prints a warning before executing. |

#### Plain Text (No `/` Prefix)

Plain text sent to the prompt initiates a **native chat** — a streaming LLM conversation on the active session using the configured provider and model.

---

## AppAction Enum

All key events map to exactly one `AppAction`:

| Variant           | Trigger                     | Effect                                                       |
| ----------------- | --------------------------- | ------------------------------------------------------------ |
| `None`            | Unhandled / character input | No action                                                    |
| `Refresh`         | `Ctrl+R`                    | Calls `app.refresh(&client)`, resets refresh timer           |
| `InterruptOrQuit` | `Ctrl+C`                    | If command running: cancel it. If idle: break loop and exit. |
| `SubmitInput`     | `Enter`                     | Calls `app.execute_input(&client)`                           |
| `ClearOutput`     | `Ctrl+L`                    | Clears `output_buffer`                                       |
| `ScrollUp`        | `Alt+Up`                    | Scrolls output up 1 line, disables auto-scroll               |
| `ScrollDown`      | `Alt+Down`                  | Scrolls output down 1 line                                   |
| `PageUp`          | `PageUp` key                | Scrolls up by (viewport_height - 1) lines                    |
| `PageDown`        | `PageDown` key              | Scrolls down by (viewport_height - 1) lines                  |
| `ScrollTop`       | `Home`                      | Scrolls to top of output                                     |
| `ScrollBottom`    | `End`                       | Re-enables auto-scroll, scrolls to bottom                    |

---

## Worker / Command Execution Model

Commands run in a spawned thread. The main loop polls `active_command.receiver` on each iteration.

### ActiveCommandKind

| Variant                        | Cancel Behavior                                                                   |
| ------------------------------ | --------------------------------------------------------------------------------- |
| `Generic`                      | Standard cancel (sets flag, returns immediately)                                  |
| `NativeChat`                   | Standard cancel. On completion: updates session ID, provider, model, token usage. |
| `TelegramSend { target_chat }` | Standard cancel. Result tracked in `last_telegram_send`.                          |

### CancelBehavior

| Variant                   | Behavior on `InterruptOrQuit`                                                                                   |
| ------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `Standard`                | Sets cancel flag, worker returns ASAP                                                                           |
| `WaitForProviderResponse` | Sets cancel flag, prints "cancelling ... (provider wait)", worker waits for provider to finish before returning |

### WorkerEvent (from thread → main loop)

| Event                       | Effect                                                                                    |
| --------------------------- | ----------------------------------------------------------------------------------------- |
| `ChatChunk { tone, chunk }` | Appends streaming text to `output_buffer` via `append_stream_chunk()`                     |
| `ChatUsage(usage)`          | Updates `live_token_usage`                                                                |
| `ChatCompleted(exchange)`   | Updates session/provider/model/token_usage; appends "reply complete via ..." success line |
| `DegradationUpdate { ... }` | Updates `degradation` state                                                               |
| `MemoryCompleted(result)`   | Appends semantic/exact search results                                                     |
| `VaultCompleted(secret)`    | Appends vault secret (warns on plaintext)                                                 |
| `HostCompleted(result)`     | Routes through `append_extension_host_result()`                                           |
| `CliCompleted(result)`      | Routes through `append_cli_result()` (legacy)                                             |
| `Error(error)`              | Appends error, or Telegram failure if TelegramSend active                                 |
| `Cancelled`                 | Appends cancellation notice                                                               |

---

## StatusBar Fields

The StatusBar is a single line at the top of the screen (blue background, white bold text):

```
⚠ ● [Mode:A] ollama/qwen2.5:3b · ctx:8k · tok:120 · busy / native chat · PULSE:healthy · session:primary::operator:local · 14:32:05
```

| Field                             | Meaning                                                                                        |
| --------------------------------- | ---------------------------------------------------------------------------------------------- | --------------------- |
| `⚠` (degraded icon)               | Shown when `degraded=true`; operator fell back from preferred provider                         |
| `●` / `○` (indicator)             | `●` = provider is configured and available; `○` = not connected / unavailable                  |
| `[Mode:X]`                        | Cognitive mode (A–E). Operator's reasoning style.                                              |
| `provider/model`                  | Active chat provider and model                                                                 |
| `ctx:8k`                          | Context window size (in tokens, k suffix for thousands)                                        |
| `prs:med rem~:3.2k`               | **Context pressure** (only shown when medium or high): level (low/med/high) + remaining tokens |
| `tok:120` or `tok~:120`           | Token usage: total tokens from last exchange. `~` = estimated                                  |
| `out~:N`                          | Live output meter: estimated tokens generated so far (shown during streaming)                  |
| `busy / native chat`              | Activity indicator; spinner `                                                                  | /-\` cycles when busy |
| `cancelling ... (provider wait)`  | Shown when `cancel_requested=true` and `cancel_behavior=WaitForProviderResponse`               |
| `PULSE:healthy`                   | PULSE subsystem health                                                                         |
| `session:primary::operator:local` | Active chat session ID                                                                         |
| `14:32:05`                        | Timestamp (wall clock, updated each render)                                                    |

---

## Output Rendering

### ScrollState

```
offset: usize       — first visible line index
auto_scroll: bool   — if true, offset tracks content_height - viewport_height
viewport_height     — terminal height in rows
content_height      — total wrapped line count
```

- `scroll_up(n)` — `offset -= n`, disables `auto_scroll`
- `scroll_down(n)` — `offset += n`, re-enables `auto_scroll` only when at bottom
- `page_up/down` — scroll by (viewport_height - 1)
- `scroll_to_top()` — `offset=0`, `auto_scroll=false`
- `scroll_to_bottom()` — `auto_scroll=true`, `offset=max_offset()`
- On every render: `sync_viewport()` is called to clamp offset and update content height

### Line Wrapping

- Content is word-wrapped to the terminal width before display
- ANSI escape sequences are stripped (`sanitize_for_tui()`)
- Empty lines produce blank `StyledLine` entries

### Tone → Style Mapping

| Tone      | Color    | Modifier |
| --------- | -------- | -------- |
| `Plain`   | White    | —        |
| `Title`   | White    | Bold     |
| `Header`  | Blue     | —        |
| `Section` | Cyan     | Bold     |
| `Info`    | Blue     | —        |
| `Success` | Green    | —        |
| `Warning` | Yellow   | —        |
| `Error`   | Red      | —        |
| `Dim`     | DarkGray | Dim      |
| `Accent`  | Cyan     | —        |
| `Prompt`  | White    | Bold     |

### NotificationBanner

A full-width yellow banner rendered above the StatusBar when `degraded=true`, displaying the degradation reason.

---

## TUI Workflow by Scenario

### Startup

1. `TerminalGuard::enter()` — enables raw mode, enters alternate screen
2. `app.refresh(&client)` — fetches initial `OperatorSnapshot`
3. On first refresh only: prints welcome title + hint, then Overview surface
4. Main loop starts polling for events

### Issuing a Chat

1. Type plain text at `>` prompt
2. Press `Enter` → `AppAction::SubmitInput` → `execute_input()`
3. Non-`/` input → `start_chat_task()` spawns a worker thread
4. Streaming chunks appear in output via `ChatChunk` events
5. `ChatCompleted` updates session state and prints summary line
6. Auto-scroll keeps newest content visible

### Running a Command

1. Type `/doctor --deep` at prompt
2. `execute_command()` routes to `start_extension_host_task()`
3. Lines appear in output as `HostEvent::Line` arrive
4. `HostCompleted` renders structured result via `append_doctor_host_result()`
5. Auto-scroll active during output

### Cancelling a Long-Running Command

1. Press `Ctrl+C` → `AppAction::InterruptOrQuit`
2. `interrupt_active_command()` sets `cancel_flag`, prints cancellation message
3. If `cancel_behavior == WaitForProviderResponse`: waits for provider, then worker returns
4. `WorkerEvent::Cancelled` → appends final cancellation notice

### Browsing History / Scrolling Output

1. Press `PageUp` or `Alt+Up` — disables auto-scroll
2. Navigate with arrow keys while auto-scroll is off
3. Press `End` or `ScrollBottom` to snap back to live output

### Changing Sessions

1. `/session my-session-id`
2. Loads transcript via `client.load_chat_session()`
3. Prints transcript entries styled by role: `[You]`, `[Memphis]`, `[Tool]`

### Switching Providers / Models

1. `/provider deepseek` — sets `chat_provider`, all subsequent chat uses it
2. `/model deepseek-chat` — sets `chat_model`
3. These persist until changed; shown in StatusBar

---

## CLI Modes (main.rs)

`memphis-tui` supports three invocation modes:

| Mode            | Flags                            | Behavior                                         |
| --------------- | -------------------------------- | ------------------------------------------------ |
| Interactive TUI | (none)                           | Full terminal UI, event loop                     |
| Check-only      | `--check-only [--json]`          | Dumps snapshot + errors as JSON/text, exits      |
| Run-command     | `--run-command '<input>' --json` | Executes one input line, returns JSON transcript |

Check-only returns exit code 2 if any errors found. Run-command returns exit code 2 on timeout or error.

---

## Key Files

| File                          | Role                                                                                                                                         |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/app.rs`                  | `AppState`, `Screen`, `AppAction`, `handle_key()`, `execute_command()`, `surface_lines()`, `status_bar_context()`, all worker/event handling |
| `src/main.rs`                 | Entry point, CLI arg parsing, main event loop, `TerminalGuard`                                                                               |
| `src/client.rs`               | `MemphisClient` wrapping `OperatorRuntime`, extension host manager, CLI bridge                                                               |
| `src/widgets/body.rs`         | `OutputBody` + `ScrollState`, line wrapping, auto-scroll                                                                                     |
| `src/widgets/status_bar.rs`   | `StatusBar` widget, field formatting helpers                                                                                                 |
| `src/widgets/prompt.rs`       | `PromptLine` widget                                                                                                                          |
| `src/widgets/notification.rs` | `NotificationBanner` for degradation alerts                                                                                                  |
| `src/widgets/mod.rs`          | Exports, `tone_to_style()` mapping                                                                                                           |
| `src/sanitize.rs`             | ANSI stripping, provider name validation                                                                                                     |
| `src/config.rs`               | `TuiConfig` from env vars                                                                                                                    |
| `src/ui.rs`                   | `UiRenderer` (not reviewed in detail)                                                                                                        |
