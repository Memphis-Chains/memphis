# Rust TUI Operator Guide

**Date:** 2026-03-27
**Scope:** native Memphis operator console (`memphis tui`)

## Entry Point

```bash
memphis tui
memphis tui --check-only --json
```

`memphis tui` now launches the Rust console. The old TypeScript TUI is archived under `legacy/tui-ts/` and is no longer an active product surface or validation target.

The Rust console stays thin over the same provider, tool, auth, vault, and runtime contracts as CLI, HTTP, MCP, and the gateway.

Important architecture note:

- `memphis-tui` now reads operator state through the native Rust seam `memphis-tui -> memphis-operator -> Rust crates`,
- `memphis-napi` remains the Rust ↔ TypeScript bridge for the TypeScript runtime, not the primary seam for the Rust console,
- TS-owned operator commands now prefer a long-lived stdio JSON extension host instead of one-shot `memphis --json` bridge calls,
- `Chat` now runs through the native Rust operator seam as well, without a TypeScript HTTP fallback,
- plain-text chat responses stream into the transcript live from the provider/runtime path.

## Current Native Scope

The Rust console now ships a single-view operator cockpit with seven logical native surfaces:

| Surface | Purpose |
|---------|---------|
| `Overview` | Native runtime summary, provider default, memory counters, chain and vault counts |
| `Chat` | Native multi-turn operator chat with live streaming, transcript persistence, and native tool/runtime integration |
| `Memory` | Semantic recall, exact search status, and native memory index summary |
| `Sessions` | Native session listing from the runtime SQLite store |
| `Vault` | Native vault metadata view and explicit direct-read command surface |
| `Cases` | Native case / decision rows from the case index |
| `System` | Native runtime paths, bridge state, optional channel readiness, and health summary |

Current control keys:

| Key | Action |
|-----|--------|
| `Enter` | Submit the current prompt or `/command` |
| `Up` / `Down` | Navigate command and chat history |
| `Esc` | Clear the current input line |
| `Ctrl+R` | Refresh from the local runtime |
| `Ctrl+L` | Clear the transcript |
| `Ctrl+C` | Cancel the active command, or quit when idle |

Current built-in commands:

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
- `/doctor`, `agents list|discover|show`, `sync status`, `apps list|show|plan`, `reflect`, `insights`, and `config tools list|check|pending` now route through the TypeScript extension host
- every TS-owned command documented in this guide is expected to be host-backed
- still-unsupported or undocumented commands fall back to the legacy CLI bridge with `--json` as a temporary compatibility path, and the transcript shows that fallback explicitly

## Telegram Companion Mode

- `/telegram` is the primary Telegram operator surface in the Rust TUI; `/telegram status` is the explicit equivalent.
- The Telegram surface renders native readiness from `memphis-operator` and shows the last Telegram send result for the current TUI session only.
- `/telegram send ...` stays companion-mode and routes through the TypeScript extension host.
- The Rust TUI does not call the Telegram Bot API directly and does not resolve or hold the Telegram bot token itself.

## Runtime Model

Current architecture:
- `memphis-tui -> memphis-operator -> Rust crates`
- `memphis-napi` remains the Rust ↔ TypeScript bridge for the TypeScript runtime
- TS-owned TUI commands use a long-lived stdio JSON extension host as the standard seam, with the legacy CLI bridge retained only as a temporary fallback for undocumented commands
- the extension host is lazy-started, reused across the TUI session, and reset if the protocol stalls, disconnects, or misses cancel/handshake deadlines
- no TypeScript TUI fallback
- no HTTP-first Rust console architecture
- `memphis tui --check-only --json` is the non-interactive RC sanity path for the native console
- the `check-only` report now exposes `uiMode: "single-view"` plus the seven logical `surfaces`

Current native data sources already wired through `memphis-operator`:
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
