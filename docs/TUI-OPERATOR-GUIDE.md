# Rust TUI Operator Guide

**Date:** 2026-03-27
**Scope:** native Memphis operator console (`memphis tui`)

## Entry Point

```bash
memphis tui
memphis tui --check-only --json
```

`memphis tui` launches the Rust console. The old TypeScript TUI is archived under `legacy/tui-ts/` and is no longer an active product surface or validation target.

The Rust console stays thin over the same provider, tool, auth, vault, and runtime contracts as CLI, HTTP, MCP, and the gateway.

Important architecture note:

- `memphis-tui` reads operator state through the native Rust seam `memphis-tui -> memphis-operator -> Rust crates`,
- `memphis-napi` remains the Rust ↔ TypeScript bridge for the TypeScript runtime, not the primary seam for the Rust console,
- TS-owned operator commands use a long-lived stdio JSON extension host instead of one-shot `memphis --json` bridge calls,
- `Chat` runs through the native Rust operator seam as well, without a TypeScript HTTP fallback,
- plain-text chat responses stream into the transcript live from the provider/runtime path.

## Native Scope

The Rust console is a single-view operator cockpit with seven logical native surfaces:

| Surface    | Purpose                                                                                                          |
| ---------- | ---------------------------------------------------------------------------------------------------------------- |
| `Overview` | Native runtime summary, provider default, memory counters, chain and vault counts                                |
| `Chat`     | Native multi-turn operator chat with live streaming, transcript persistence, and native tool/runtime integration |
| `Memory`   | Semantic recall, exact search status, and native memory index summary                                            |
| `Sessions` | Native session listing from the runtime SQLite store                                                             |
| `Vault`    | Native vault metadata view and explicit direct-read command surface                                              |
| `Cases`    | Native case / decision rows from the case index                                                                  |
| `System`   | Native runtime paths, bridge state, optional channel readiness, and health summary                               |

Control keys:

| Key           | Action                                       |
| ------------- | -------------------------------------------- |
| `Enter`       | Submit the current prompt or `/command`      |
| `Up` / `Down` | Navigate command and chat history            |
| `Alt+Up` / `Alt+Down` | Scroll the transcript one row at a time |
| `PageUp` / `PageDown` | Scroll the transcript by one viewport    |
| `Home` / `End` | Jump to the top or bottom of the transcript  |
| `Esc`         | Clear the current input line                 |
| `Ctrl+R`      | Refresh from the local runtime               |
| `Ctrl+L`      | Clear the transcript                         |
| `Ctrl+C`      | Cancel the active command, or quit when idle |

For release/operator validation, use:

- `memphis tui --check-only --json` for the native startup/report proof
- `memphis tui --run-command "/config tools list" --json` for the documented host-backed proof through the Rust TUI router
- `memphis tui --run-command "/config surfaces list" --json` when reviewing chat-surface hardening through the Rust TUI router
- `memphis config surfaces list --json` plus `memphis health --json` outside the TUI when you want the same proof directly in CLI JSON; `health --json` exposes the runtime `surfacePolicies` snapshot
- the concrete manual drill in `docs/runbooks/TUI_CANCEL_DRILL.md`

Built-in commands:

- plain text input sends native chat immediately
- `/overview`
- `/memory`
- `/memory semantic <query>`
- `/memory exact <query>`
- `/sessions`
- `/session <id>`
- `/vault`
- `/vault get <key>`
- `/providers`
- `/models`
- `/provider <name>`
- `/model <id>`
- `/cases`
- `/system`
- `/telegram`
- `/telegram status`
- `/telegram send <message>`
- `/telegram send --to <chatId> <message>`
- `/health`
- `/pulse`
- `/pulse status`
- `/init status`
- `/doctor [--fix] [--force] [--deep]`
- `/agents list`
- `/agents discover`
- `/agents show <did>`
- `/sync status [--chain <name>]`
- `/apps list`
- `/apps show <id>`
- `/apps show --file <manifest.json>`
- `/apps plan <id> [--file <manifest.json>] [--action <name>]`
- `/reflect [--save]`
- `/insights [--daily|--weekly|--topic <topic>] [--save]`
- `/mode`
- `/mode <A|B|C|D|E>`
- `/config tools list`
- `/config tools check <tool>`
- `/config tools pending`
- `/config surfaces list`
- `/config surfaces check <surface>`
- `/config surfaces set <surface> <setting> <value>`
- `/config surfaces reset <surface> [setting]`
- emergency compatibility only: `/legacy <memphis cli args...>`
- the commands above route through the TypeScript extension host
- every TS-owned command documented in this guide is expected to be host-backed
- `/pulse` and `/mode` are host-backed operator controls so heartbeat truth and cognitive-mode state stay aligned with the TypeScript runtime
- unknown or unsupported slash commands no longer auto-fallback to the legacy CLI bridge
- the `/legacy ...` escape hatch stays last-resort compatibility only, and the transcript shows that escape hatch explicitly
- long transcript lines now wrap to the viewport instead of clipping off the right edge
- busy work is shown with a live spinner in the status bar while an active command is running
- the native status bar now shows the selected model context budget as `ctx:<tokens>` when the Rust provider seam can resolve it
- when prompt headroom gets tight enough to matter, the status bar adds `prs:<level> rem:<tokens>` or `rem~:<tokens>` so operators can see medium/high context pressure without opening another panel
- the native status bar now shows the last known token total as `tok:<total>` when the provider returned real usage, or `tok~:<total>` when Memphis had to estimate it
- while a native chat response is still streaming, the status bar prefers live provider usage when the stream exposes it, and otherwise falls back to `out~:<tokens>` as an estimated in-flight output counter
- the `Chat` surface shows the fuller last-turn breakdown as `prompt / completion / total`, plus context headroom, pressure level, and active degradation truth when the runtime has it

## Telegram Companion Mode

- `/telegram` is the primary Telegram operator surface in the Rust TUI; `/telegram status` is the explicit equivalent.
- The Telegram surface renders native readiness from `memphis-operator` and shows the last Telegram send result for the current TUI session only.
- `/telegram send ...` stays companion-mode and routes through the TypeScript extension host.
- The Rust TUI does not call the Telegram Bot API directly and does not resolve or hold the Telegram bot token itself.

## Runtime Model

- `memphis-tui -> memphis-operator -> Rust crates`
- `memphis-napi` remains the Rust ↔ TypeScript bridge for the TypeScript runtime
- TS-owned TUI commands use a long-lived stdio JSON extension host as the standard seam, with the legacy CLI bridge retained only behind the explicit `/legacy ...` escape hatch
- the extension host is lazy-started, reused across the TUI session, and reset if the protocol stalls, disconnects, or misses cancel/handshake deadlines
- no TypeScript TUI fallback
- no HTTP-first Rust console architecture
- `memphis tui --check-only --json` is the non-interactive RC sanity path for the native console
- `memphis tui --run-command "/config tools list" --json` is the non-interactive RC proof path for one documented host-backed TUI command
- `memphis tui --run-command "/config surfaces list" --json` is the non-interactive proof path for chat-surface hardening through the same host-backed router
- the `check-only` report exposes `uiMode: "single-view"` plus the seven logical `surfaces`

Native data sources wired through `memphis-operator`:

- local runtime root and chain directories
- SQLite session and exact-search tables
- embedding persistence for semantic recall
- vault state + entries files
- case index rows
- native chat session transcript storage and provider/runtime orchestration

## Vault Rule

The `Vault` screen is metadata-first.

Direct secret reads remain bounded to explicit operator command paths and must not leak into:

- prompt fragments
- memory
- audit payloads
- background model output

## References

- `crates/memphis-tui/src/main.rs`
- `crates/memphis-tui/src/app.rs`
- `crates/memphis-tui/src/client.rs`
- `crates/memphis-operator/src/lib.rs`
- `crates/memphis-operator/src/runtime.rs`
