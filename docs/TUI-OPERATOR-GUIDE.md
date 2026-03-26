# TUI Operator Guide

**Date:** 2026-03-26
**Scope:** Memphis terminal operator console (`memphis tui`)

## Entry Points

Memphis has two terminal modes:

| Entry Point | Command | Description |
|-------------|---------|-------------|
| Split-panel TUI | `memphis tui` | Product-aware operator console on top of the unified runtime |
| Line TUI | `memphis` | Minimal readline loop for quick chat/commands |

This guide covers the split-panel TUI.

## Launch

```bash
memphis tui
```

The TUI runs against the same provider, tool, auth, and vault/runtime contracts as CLI, HTTP, MCP, and the gateway paths.

## Screen Model

The TUI now uses the canonical 7-screen model:

| Key | Screen | Purpose |
|-----|--------|---------|
| `Ctrl+1` | Overview | Runtime overview, activity, memory/insight summary |
| `Ctrl+2` | Chat | Multi-turn operator chat |
| `Ctrl+3` | Memory | Embeddings and recall-oriented operator view |
| `Ctrl+4` | Sessions | Persisted session inventory |
| `Ctrl+5` | Vault | Secret metadata and vault operations |
| `Ctrl+6` | Cases | Cases / decision history |
| `Ctrl+7` | System | Provider health and observability |

`Ctrl+Tab` cycles through all screens.

Legacy names still normalize internally:
- `dashboard` -> `overview`
- `embed` -> `memory`
- `decisions` -> `cases`
- `health` -> `system`

## Overview

`Overview` replaces the old dashboard semantics.

It shows:
- chain activity and uptime
- memory/embedding count
- insight topics and pattern stats
- observability summary in the right panel

Quick actions on `Overview`:
- `c` -> `Chat`
- `m` -> `Memory`
- `v` -> `Vault`
- `q` -> quit

`j`, `a`, and `r` remain accepted as compatibility aliases for the older quick-jump flow.

## Product Screens

### Chat

`Chat` is the operator conversation surface. Slash commands still work from the input line.

### Memory

`Memory` focuses on runtime memory state:
- embedding count
- top recall topics
- pattern/learning stats
- embed commands

Available commands:

```bash
/embed reset
/embed store <id> <value>
/embed search <query> [topK] [tuned]
```

### Sessions

`Sessions` reads from the real `SessionRepository` and shows the persisted session inventory.

If the runtime does not expose a session repository, the screen says so explicitly instead of inventing local state.

### Vault

`Vault` shows metadata-only latest entries per key and uses the same vault boundary as the CLI and HTTP routes.

Available commands:

```bash
/vault init <passphrase> <recovery-question> <recovery-answer>
/vault add <key> <value>
/vault get <key>
/vault list [key]
```

Direct `vault get` results return only to the explicit operator response path. They must not be copied into memory, prompt fragments, audit payloads, or background model output.

### Cases

`Cases` is the operator view for cases / decisions.

Available commands:

```bash
/cases list
```

`/decisions list` is still accepted as a compatibility alias.

### System

`System` absorbs provider health plus observability state.

Use:

```bash
/health
/obs
/obs export --json
/obs reset
```

## Slash Commands

Core commands:

| Command | Action |
|---------|--------|
| `/help` | Show commands |
| `/guide` | Show runtime/operator guide |
| `/exit` | Quit the TUI |
| `/screen <name>` | Switch screen (`overview`, `chat`, `memory`, `sessions`, `vault`, `cases`, `system`) |
| `/provider <name>` | Set provider |
| `/strategy <type>` | Set routing strategy |
| `/model <id>` | Set model |
| `/health` | Refresh `System` provider health |
| `/obs` | Inline observability |
| `/obs export --json` | Export observability snapshot |
| `/obs reset` | Clear observability counters |
| `/vault ...` | Vault operations |
| `/embed ...` | Memory/index operations |
| `/cases list` | Cases / decisions view refresh |

## Keyboard Navigation

| Key | Action |
|-----|--------|
| `Ctrl+1..7` | Switch to a screen |
| `Ctrl+Tab` | Cycle screens |
| `Ctrl+L` | Redraw |
| `Ctrl+K` | Clear chat/history panel |
| `Ctrl+P` | Open command palette |
| `Ctrl+Left/Right` | Resize split panel |
| `PageUp/PageDown` | Scroll active left pane |
| `Home/End` | Jump to oldest/latest visible content |

## Operator Semantics

The split-panel TUI is not a separate product runtime.

It must stay thin over the same:
- provider path
- tool surface
- auth/policy checks
- vault boundary
- session/memory state

Heavy control-plane operations still belong in CLI where appropriate, but the TUI must not invent different runtime semantics.

## References

- `src/tui/index.ts`
- `src/tui/io.ts`
- `src/tui/core.ts`
- `src/tui/RootLayout.ts`
- `src/tui/screens/session-screen.ts`
