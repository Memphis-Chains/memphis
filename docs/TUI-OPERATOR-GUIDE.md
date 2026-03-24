# TUI Operator Guide

**Date:** 2026-03-24
**Scope:** MemphisOS Terminal UI (TUI) — operator observability and actions

---

## Two TUI Entry Points

MemphisOS has two TUI implementations:

| Entry Point | Command | Description |
|-------------|---------|-------------|
| **Split-panel TUI** | `memphis tui` | Full 5-screen split-panel terminal UI |
| **Line TUI** | `memphis` (no args) | Simple readline prompt (`memphis>`) |

This guide covers the split-panel TUI (`memphis tui`).

---

## Launching the TUI

```bash
memphis tui
```

The TUI requires a running MemphisOS process. It connects to the local HTTP API (default `http://localhost:4499`) and reads from the observability store.

---

## 5 Screens

| Key | Screen | Purpose |
|-----|--------|---------|
| `Ctrl+1` | Chat | Text generation / multi-turn agentic chat |
| `Ctrl+2` | Health | Provider status, latency, error rates |
| `Ctrl+3` | Embed | Vector store search and storage |
| `Ctrl+4` | Vault | Secret management (init, add, get, list) |
| `Ctrl+5` | Dashboard | Chain stats, activity feed, insights |

Switch screens with `Ctrl+1` through `Ctrl+5`, or `Ctrl+Tab` to cycle.

---

## Dashboard Screen (`Ctrl+5`)

**Left panel** — Live metrics:
- Total chain blocks, today's blocks
- Model status (which cognitive models are active)
- Embedding count (stored vectors)
- Uptime

**Right panel** — Observability:
- Request count and average latency
- Fallback rate (% of requests that fell back to secondary provider)
- Last provider used, last error
- Snapshot age

**Bottom bar** — Quick actions:
- `j` — Jump to vault screen
- `a` — Jump to chat screen
- `r` — Jump to embed screen
- `q` — Quit

The dashboard auto-refreshes every 5 seconds.

---

## Observability Panel

The right panel is always visible and shows live telemetry from `data/tui-observability.json`:

```
Request count:   1,247
Avg latency:     142ms
Fallback rate:   3.2%
Last provider:   ollama
Last error:      connection refused
Snapshot age:    4s
```

Export observability data:
```
/obs export --json   # dump to data/tui-observability.json
/obs reset           # clear all counters
```

---

## Slash Commands

Available in the TUI input field (bottom of screen):

| Command | Action |
|---------|--------|
| `/help` | Show command list |
| `/exit` | Quit TUI |
| `/health` | Refresh provider health |
| `/obs` | Show observability panel inline |
| `/screen <name>` | Switch to named screen |
| `/provider <name>` | Set active LLM provider (`auto`, `ollama`, `shared-llm`, `decentralized-llm`, `local-fallback`) |
| `/strategy <type>` | Set routing strategy (`default`, `latency-aware`) |
| `/model <id>` | Set model identifier |
| `/vault init <pass> <q> <a>` | Initialize vault |
| `/vault add <key> <val>` | Add secret |
| `/vault get <key>` | Retrieve secret |
| `/vault list [key]` | List vault contents |
| `/embed reset` | Reset embedding index |
| `/embed store <id> <val>` | Store embedding |
| `/embed search <q> [topK] [tuned]` | Search embeddings |
| `/backup list` | List backups |
| `/backup create` | Create backup |
| `/decisions list` | List recorded decisions |
| `/decide` | Create a decision |
| `/sync status` | Show sync status |
| `/sync push` | Push sync |
| `/insights` | Show insights |
| `/connections scan` | Scan connections |
| `/suggest` | Show suggestions |

---

## Health Screen (`Ctrl+2`)

Lists all configured LLM providers with:
- **Status** — `up`, `down`, `degraded`
- **Latency** — last observed response time
- **Errors** — error count and last error message

Use `/health` to manually refresh.

---

## Vault Screen (`Ctrl+4`)

Run vault operations without leaving the terminal:

```
/vault init mypass "What is your mother maiden name?" "answer"
/vault add github-token ghp_xxxxxxxxxxxx
/vault get github-token
/vault list
```

All vault operations require the vault to be initialized first (`vault init`).

---

## Embed Screen (`Ctrl+3`)

Query and populate the vector store:

```
/embed store user-1 "Alice likes running and hiking"
/embed search "outdoor activities" 5
/embed reset
```

Note: Embedding behavior depends on `RUST_EMBED_MODE`:
- `local` (default) — Rust LocalDeterministic, dim-32
- `ollama` — Ollama HTTP, dim-768, requires running Ollama server

---

## Keyboard Navigation

| Key | Action |
|-----|--------|
| `Ctrl+1..5` | Switch to screen 1-5 |
| `Ctrl+Tab` | Cycle to next screen |
| `Ctrl+L` | Redraw TUI |
| `Ctrl+K` | Clear history |
| `Ctrl+P` | Command palette (fuzzy search of slash commands) |
| `Ctrl+Left/Right` | Resize split panel |
| `PageUp/PageDown` | Scroll history (non-dashboard screens) |
| `j/a/r` | Dashboard quick-jump to vault/chat/embed |
| `q` | Quit (on dashboard) |

---

## TUI vs CLI

| Aspect | TUI | CLI |
|--------|-----|-----|
| Purpose | Observability + real-time actions | Control plane operations |
| Mode | Read-heavy, interactive | Single commands |
| Chain operations | View only | `import_json`, `verify`, `rebuild` |
| Backup | View only | `backup create`, `backup restore` |
| Bootstrap | Not supported | `npm run bootstrap` |

The TUI is **not a replacement for the CLI**. Heavy operations (bootstrap, chain import, backup restore) must be done via the CLI.

---

## Configuration

| Environment Variable | Default | Purpose |
|---------------------|---------|---------|
| `MEMPHIS_API_URL` | `http://localhost:4499` | API endpoint |
| `TUI_OBSERVABILITY_PATH` | `data/tui-observability.json` | Observability store path |

---

## References

- `src/tui/index.ts` — split-panel TUI implementation (1030 lines)
- `src/tui/core.ts` — screen types, keybindings
- `src/infra/cli/interactive-tui.ts` — line-based TUI
- `src/tui/observability-store.ts` — snapshot persistence
- `src/tui/dashboard-data.ts` — dashboard data loading
