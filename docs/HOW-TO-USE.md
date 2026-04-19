# How to Use Memphis

Quick reference for daily operation. For full details see [USER-GUIDE.md](./USER-GUIDE.md).

---

## Quick Start

```bash
# Install (one command)
curl -fsSL https://raw.githubusercontent.com/Memphis-Chains/memphis/main/scripts/install.sh | bash

# Initialize (passphrase, vault, identity)
memphis init

# Connect Anthropic (recommended provider)
memphis auth anthropic          # browser OAuth
# OR: memphis vault add --key anthropic_api_key --value "sk-ant-..."

# Verify
memphis doctor
```

Set in `~/memphis/.env`:

```dotenv
DEFAULT_PROVIDER=anthropic
ANTHROPIC_MODEL=claude-sonnet-4-6
MEMPHIS_AUTONOMY_MODE=full
```

---

## Three Ways to Talk to Memphis

### 1. CLI (quick commands)

```bash
memphis health                  # runtime status
memphis providers list          # configured LLM providers
memphis vault list              # vault entries (metadata only)
memphis doctor                  # full diagnostic
memphis doctor --fix            # auto-repair
```

### 2. TUI (operator console)

```bash
memphis tui
```

Native Rust terminal UI. Always runs at **tier 2** (full tool access). Type messages, Memphis responds with full tool use — exec, code read/write, git, grep, tests, everything.

### 3. Telegram Bot

Set in `.env`:

```dotenv
MEMPHIS_CHANNEL_GATEWAY_ENABLED=true
MEMPHIS_TELEGRAM_BOT_TOKEN=<your-bot-token>
MEMPHIS_TELEGRAM_CHAT_ID=<your-chat-id>
MEMPHIS_TELEGRAM_ALLOWED_USER_IDS=<your-user-id>
```

Start the service, then message your bot on Telegram.

---

## Tool Tiers & Authorization

Memphis tools are organized in 3 tiers:

| Tier  | Tools                                                       | Access           |
| ----- | ----------------------------------------------------------- | ---------------- |
| **0** | journal, recall, search, soul, health, case, decide, repair | Always available |
| **1** | code_read, grep, glob, git (read), web_fetch                | Network/read     |
| **2** | exec, test, self_modify, cron, git (write)                  | Execute/write    |

### Tier Switching in Telegram

```
/tier              Show current tier
/tier 0            Safe mode (memory only)
/tier 1            Network/read access
/tier 2 <pass>     Full access (requires vault passphrase)
```

Tier elevation expires after **15 minutes**.

### TUI Tiers

TUI always runs at tier 2. No switching needed — it's the operator console.

### Full Autonomy Mode

When `MEMPHIS_AUTONOMY_MODE=full`:

- All tools auto-approved (no passphrase prompts)
- Exec runs any command (no allowlist/denylist)
- Self-modify skips passphrase gate

---

## Telegram Commands

| Command                 | What it does                            |
| ----------------------- | --------------------------------------- |
| `/start`, `/help`       | Show available commands                 |
| `/status`               | Runtime status                          |
| `/tier [0\|1\|2]`       | Switch tool tier                        |
| `/mode [A\|B\|C\|D\|E]` | Switch cognitive mode                   |
| `/recall`               | What Memphis remembers about you        |
| `/chains`               | Chain integrity & block counts          |
| `/search <query>`       | Semantic memory search                  |
| `/evolve <intent>`      | Self-modify codebase (tier 2)           |
| Text message            | Chat with full tool use at current tier |
| Voice message           | STT → chat → TTS response               |

---

## Autonomy Modes

| Mode       | Description                            |
| ---------- | -------------------------------------- |
| `full`     | No approval needed. Agent runs freely. |
| `quiet`    | Tier 0-1 auto, tier 2 needs approval   |
| `balanced` | Only tier 0 auto, rest needs approval  |
| `paranoid` | Everything needs approval              |

Set via env var or CLI:

```bash
export MEMPHIS_AUTONOMY_MODE=full

# Or in .env:
MEMPHIS_AUTONOMY_MODE=full
```

---

## Cognitive Modes

| Mode | Name       | Purpose                        |
| ---- | ---------- | ------------------------------ |
| A    | Capture    | Record observations and facts  |
| B    | Inferred   | Draw connections, analyze      |
| C    | Predictive | Anticipate, plan ahead         |
| D    | Collective | Multi-agent coordination       |
| E    | Meta       | Self-reflection, introspection |

Switch via Telegram: `/mode B`

---

## Service Management

```bash
memphis service install         # install systemd user service
memphis service start           # start daemon
memphis service stop            # stop daemon
memphis service restart         # restart
memphis service status          # check if running
memphis service logs -n 100     # recent logs
```

---

## Common Operations

```bash
# Health & diagnostics
memphis health --json
memphis doctor
memphis doctor --fix

# Providers
memphis providers list
memphis providers health

# Vault
memphis vault list
memphis vault add --key <name> --value <secret>

# Backup
memphis backup create
memphis backup restore <path>

# Update
cd ~/memphis && git pull && npm install && npm run build
memphis service restart
```

---

## File Layout

```
~/memphis/                      # Source code + runtime
  .env                          # Configuration
  crates/                       # Rust crates (operator, vault, embed, etc.)
  src/                          # TypeScript runtime

~/.memphis/                     # Data directory
  chains/                       # Append-only memory chains
    journal/                    # Your memory
    decisions/                  # Decision records
    system/                     # Boot, heartbeat events
  config/
    soul-manifest.json          # Agent identity + capabilities
    soul-memory.json            # Persistent soul state
  vault/                        # Encrypted secrets
  data/
    memphis.db                  # SQLite indexes (derived)
```

---

## Troubleshooting

```bash
# Full diagnostic
memphis doctor --verbose

# Check specific subsystem
memphis health --json | jq .providers
memphis health --json | jq .chains

# Reset to clean state (careful!)
memphis reset

# Rebuild derived indexes
memphis reindex
```

If `memphis doctor` shows failures, run `memphis doctor --fix` first. Most issues auto-resolve.
