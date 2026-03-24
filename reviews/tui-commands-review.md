# TUI Commands Review - MemphisOS

## Screens (5 total)

| Screen | Key | Description |
|--------|-----|-------------|
| dashboard | Ctrl+5 / default | Main overview: stats, activities, insights, auto-refreshes every 5s |
| chat | Ctrl+1 | LLM chat with multi-turn + tools (or text fallback via orchestration.generate) |
| health | Ctrl+2 | Provider health status (ollama, shared-llm, decentralized-llm, local-fallback, auto) |
| embed | Ctrl+3 | Embedding ops: store and search memories |
| vault | Ctrl+4 | Encrypted secret storage ops |
| decision | (not directly accessible from TUI) | Decision history — referenced in dashboard-data.ts but not wired as a screen |

Screen navigation: `Ctrl+1..5` or `/screen <name>`.

---

## Keybindings

### Dashboard-only quick actions (lowercase, only active on dashboard):
| Key | Action |
|-----|--------|
| J | Switch to vault screen (journal) |
| A | Switch to chat screen (ask) |
| R | Switch to embed screen (recall) |
| Q | Quit TUI |

### Global keybindings (always active):
| Key | Action |
|-----|--------|
| Ctrl+L | Redraw screen |
| Ctrl+K | Clear history |
| Ctrl+1 | Switch to chat |
| Ctrl+2 | Switch to health |
| Ctrl+3 | Switch to embed |
| Ctrl+4 | Switch to vault |
| Ctrl+5 | Switch to dashboard |

---

## Slash Commands (typed in input)

### Help & Info
| Command | Description |
|---------|-------------|
| /help | Show all commands |
| /guide | Show runtime operator guide |
| /exit or /quit | Exit TUI |
| /health | Refresh provider health screen |
| /obs | Show observability panel |
| /obs export | Export observability path/entry count |
| /obs export --json | Export as JSON |
| /obs reset | Reset all observability counters |

### Navigation
| Command | Description |
|---------|-------------|
| /screen chat | Switch to chat screen |
| /screen health | Switch to health screen |
| /screen embed | Switch to embed screen |
| /screen vault | Switch to vault screen |
| /screen dashboard | Switch to dashboard screen |

### Provider & Model Config
| Command | Description |
|---------|-------------|
| /provider auto | Set routing to auto |
| /provider ollama | Set provider to ollama |
| /provider shared-llm | Set provider to shared-llm |
| /provider decentralized-llm | Set provider to decentralized-llm |
| /provider local-fallback | Set provider to local-fallback |
| /strategy default | Set default routing |
| /strategy latency-aware | Set latency-aware routing |
| /model <id> | Set model ID |

### Vault Operations
| Command | Description |
|---------|-------------|
| /vault init <pass> <q> <a> | Initialize vault with password, question, answer |
| /vault add <key> <val> | Add secret to vault |
| /vault get <key> | Retrieve secret from vault |
| /vault list [key] | List vault keys |

### Embed Operations
| Command | Description |
|---------|-------------|
| /embed reset | Reset embedding index |
| /embed store <id> <val> | Store durable memory |
| /embed search <q> [topK] | Search embeddings (default topK=5) |
| /embed search <q> <topK> true | Search with tuned ranking |

### Default: Anything else → chat prompt
Non-slash input on chat screen (or any screen with chat provider) goes to the LLM. Without a chat provider, it falls back to `orchestration.generate()`.

---

## Observability Panel (always visible on right)
Tracks: requests, avg ms, fallback rate, last provider, latency sparkline, last error, health summary, persisted age.

---

## Notes
- `decision-screen.ts` is defined but not wired to any TUI route — only `TuiScreen = chat|health|embed|vault|dashboard` are valid.
- Dashboard auto-refreshes every 5 seconds.
- Vault and embed screens do NOT have dedicated quick-action keys (J/A/R/Q are dashboard-only).
- `/obs` commands are export/reset only; no import functionality.
