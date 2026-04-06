# Memphis User Guide

Complete operator manual for Memphis v1.3.0. Covers installation, configuration, daily operation, cognitive modes, vault management, provider setup, Telegram gateway, and self-modification.

## Table of Contents

1. [Installation](#installation)
2. [First Run](#first-run)
3. [Providers & Models](#providers--models)
4. [Autonomy Modes](#autonomy-modes)
5. [CLI Commands](#cli-commands)
6. [TUI (Operator Console)](#tui-operator-console)
7. [Chain Memory System](#chain-memory-system)
8. [Vault & Secrets](#vault--secrets)
9. [Cognitive Modes (A-E)](#cognitive-modes-a-e)
10. [MCP Tools & Tier Authorization](#mcp-tools--tier-authorization)
11. [Telegram Gateway](#telegram-gateway)
12. [Self-Modification](#self-modification)
13. [Backup & Restore](#backup--restore)
14. [Systemd Service](#systemd-service)
15. [Doctor & Troubleshooting](#doctor--troubleshooting)
16. [Update & Uninstall](#update--uninstall)

---

## Installation

### One-liner (recommended)

```bash
curl -fsSL https://raw.githubusercontent.com/Memphis-Chains/memphis/main/scripts/install.sh | bash
```

This handles everything: prerequisites (Node.js 22, Rust stable, build tools), cloning the repo, building the Rust NAPI bridge and TypeScript, npm linking, and systemd service setup.

### Manual install

If you prefer manual control:

```bash
# Prerequisites (Ubuntu/WSL)
sudo apt-get update
sudo apt-get install -y build-essential git curl pkg-config libssl-dev

# Node.js 22
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs

# Rust stable
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal
source "$HOME/.cargo/env"

# Clone and build
git clone https://github.com/Memphis-Chains/memphis.git ~/.memphis/memphis
cd ~/.memphis/memphis
npm run bootstrap
```

### Verify installation

```bash
memphis doctor
```

---

## First Run

After installation, run the initialization flow:

```bash
memphis init
```

This guided process handles:

1. **Operator passphrase enrollment** — creates your vault master key.
2. **Vault initialization** — encrypted store for API keys, tokens, and secrets.
3. **First-state mode selection**:
   - `minimal-baseline` — smallest transparent starting state.
   - `guided-conversation` — interactive dialogue that creates meaningful first chains.
4. **Preview of initial chain writes** — you see exactly what gets written before confirming.
5. **Health summary** — green/yellow/red status of all subsystems.

### Connect a provider

Memphis needs an LLM provider. Anthropic (Claude) is recommended:

```bash
# Option A: Browser OAuth (recommended)
memphis auth anthropic
# Opens browser → log in → token stored in vault automatically

# Option B: API key
memphis vault add --key anthropic_api_key --value "sk-ant-..."
```

Then set in `.env`:

```dotenv
DEFAULT_PROVIDER=anthropic
ANTHROPIC_MODEL=claude-sonnet-4-6
```

### Verify everything works

```bash
memphis health --json     # Quick health
memphis doctor            # Deep diagnostic (should show PASS)
```

### What init creates

```
~/.memphis/
  chains/
    journal/           # Your memory chain
    decisions/         # Decision records
    reflections/       # Self-reflection output
    cases/             # Knowledge graph entries
    system/            # Boot, heartbeat, mode changes
    collective/        # Multi-agent coordination
    patterns/          # Predictive pattern storage
  config/
    agent-profile.json # Agent identity
    soul-manifest.json # Capabilities + autonomy mode
  vault/               # Encrypted secrets
  did.json             # Decentralized identity
  embed-index.json     # Persisted embedding vectors
data/
  memphis.db           # SQLite indexes (derived, rebuildable)
```

---

## Providers & Models

Memphis supports multiple LLM providers with automatic fallback.

### Provider Priority (default)

| Priority | Provider | Auth | Default Model |
|----------|----------|------|---------------|
| 1 | **Anthropic** | OAuth or API key | `claude-sonnet-4-6` |
| 2 | **Ollama** | None (local) | `qwen2.5-coder:3b` |
| 3 | **DeepSeek** | API key | `deepseek-chat` |
| 4 | **MiniMax** | API key | `MiniMax-M2.7` |
| 5 | **GLM** | API key | `glm-4-flash` |
| 6 | **local-fallback** | None | deterministic (no LLM) |

### Anthropic Setup

Three auth modes, in priority order:

**1. Browser OAuth (recommended for developers)**

```bash
memphis auth anthropic
```

Opens your browser at Anthropic's login page. After you authenticate, a refresh token is stored in vault. Memphis refreshes access tokens automatically.

**2. API key (simplest)**

```bash
memphis vault add --key anthropic_api_key --value "sk-ant-api03-..."
```

Set in `.env`:
```dotenv
DEFAULT_PROVIDER=anthropic
ANTHROPIC_MODEL=claude-sonnet-4-6
```

**3. Client credentials (for server/daemon deployments)**

Set in `.env`:
```dotenv
ANTHROPIC_OAUTH_CLIENT_ID=your-client-id
ANTHROPIC_OAUTH_CLIENT_SECRET=your-client-secret
```

### Ollama Setup (local, offline)

```bash
curl -fsSL https://ollama.ai/install.sh | sh
ollama pull qwen2.5-coder:3b       # Chat model
ollama pull nomic-embed-text        # Embedding model
```

Memphis auto-detects Ollama on `http://127.0.0.1:11434`. If Ollama is unreachable, it falls back to `local-fallback`.

### Other Cloud Providers

```bash
# DeepSeek
memphis vault add --key deepseek_api_key --value "sk-..."

# MiniMax
memphis vault add --key minimax_api_key --value "sk-..."

# GLM
memphis vault add --key glm_api_key --value "sk-..."
```

Set `DEFAULT_PROVIDER` in `.env` to the one you want as primary.

### Provider Health Check

```bash
memphis providers health    # Test all configured providers
memphis providers list      # Show providers and status
```

---

## Autonomy Modes

Memphis uses an autonomy mode system that controls how much approval the agent needs before acting.

| Mode | Tier 0 | Tier 1 | Tier 2 | Use Case |
|------|--------|--------|--------|----------|
| `full` | allow | allow | allow | Full autonomous operation, no prompts |
| `quiet` | allow | allow | require-approval | Default for most operators |
| `balanced` | allow | require-approval | require-approval | Conservative |
| `paranoid` | require-approval | require-approval | require-approval | Maximum oversight |

### Setting Autonomy Mode

**Via environment variable** (highest priority):

```dotenv
MEMPHIS_AUTONOMY_MODE=full
```

**Via CLI**:

```bash
memphis trust mode set full
```

**Via soul manifest**: The mode is stored in `~/.memphis/config/soul-manifest.json` under `mode`.

### Full Mode

`MEMPHIS_AUTONOMY_MODE=full` gives the agent complete autonomy:
- All tool tiers auto-approved without passphrase
- Self-modification passphrase gate bypassed
- Doctor surface hardening check downgraded to warning

This is the recommended mode when you trust the agent and want it to work independently (similar to `--yolo` in other tools).

---

## CLI Commands

Memphis CLI follows the pattern `memphis <command> [options]`.

### Health & Diagnostics

```bash
memphis health --json          # Quick runtime check
memphis doctor                 # Deep diagnostic (51 checks across 7 tiers)
memphis doctor --fix           # Auto-repair what can be fixed
memphis doctor --deep          # Extended checks (shell, network)
```

### Memory Operations

```bash
memphis journal "Today I deployed the new API"    # Write to journal chain
memphis recall "API deployment"                    # Semantic search (embeddings)
memphis search --query "exact phrase"              # FTS5 exact match
memphis decide "Use PostgreSQL for prod"           # Record a decision
```

### Cognitive Operations

```bash
memphis mode A                 # Conscious Capture (default)
memphis mode B                 # Inferred Decisions
memphis mode C                 # Predictive Patterns
memphis mode D                 # Collective Coordination
memphis mode E                 # Meta-Cognitive Reflection
memphis reflect                # Trigger reflection cycle
memphis insights               # Show recent cognitive insights
```

### Vault & Secrets

```bash
memphis vault init --passphrase "..." --recovery-question "..." --recovery-answer "..."
memphis vault add --key my_secret --value "..."    # Encrypt and store
memphis vault get --key my_secret                  # Decrypt (needs operator passphrase)
memphis vault list                                 # List entries (metadata only)
```

### Provider Management

```bash
memphis providers list         # All providers and their status
memphis providers health       # Health check all providers
memphis auth anthropic         # Browser OAuth login for Anthropic
```

### Embeddings

```bash
memphis embed reindex          # Rebuild embedding index from chains
memphis embed search "query"   # Semantic vector search
memphis embed store "text"     # Store and index a value
```

### Telegram

```bash
memphis telegram status        # Check bot readiness
memphis telegram send --value "Hello" --to <chat_id>
```

### System Operations

```bash
memphis tui                    # Launch native Rust operator console
memphis service install        # Install systemd user service
memphis service status         # Check service health
memphis service restart        # Restart the daemon
memphis service logs           # View recent logs
memphis backup                 # Backup chains and state
memphis repair runtime         # Fix degraded state
```

### MCP Server

```bash
memphis mcp serve              # Start MCP server (stdio transport)
memphis mcp serve --transport http --port 3030  # HTTP transport
```

---

## TUI (Operator Console)

Launch with `memphis tui`. Native Rust terminal built with Ratatui.

### Screens

| Key | Screen | Shows |
|-----|--------|-------|
| `1` | Overview | Runtime summary, chain health, provider status, PULSE heartbeat |
| `2` | Chat | Multi-turn conversation with live streaming |
| `3` | Memory | Semantic recall + exact search results |
| `4` | Sessions | Session list, active session indicator |
| `5` | Vault | Stored secret names and metadata |
| `6` | Cases | Case/decision entries from chains |
| `7` | System | Runtime paths, health, configuration |

### Status Bar

Bottom bar shows: cognitive mode, active provider, PULSE status, session ID.

### Navigation

- Number keys `1-7` switch screens
- `q` or `Esc` quit
- `/` open command input
- `Tab` cycle focus areas within a screen

### TUI Commands

In the Chat screen (`2`), type `/` followed by:

| Command | Action |
|---------|--------|
| `/embed store <id> <text>` | Store a memory entry |
| `/embed search <query>` | Semantic search |
| `/vault list` | List vault entries |
| `/mode A-E` | Switch cognitive mode |
| `/config tools list` | Show tool permissions |

---

## Chain Memory System

Memphis is chain-first: append-only SHA-256 signed chains are the source of truth. SQLite indexes are derived and rebuildable.

### Chain Types

| Chain | Purpose | Written By |
|-------|---------|-----------|
| `journal` | General memory, notes, observations | Mode A, `memphis journal` |
| `decisions` | Recorded decisions with context | Mode B, `memphis decide` |
| `reflections` | Self-reflection output, blind spot analysis | Mode E, `memphis reflect` |
| `cases` | Knowledge graph entries (grammatical cases) | Case index, cognitive engine |
| `system` | Boot, heartbeat, mode changes, errors | PULSE heartbeat, bootstrap |
| `collective` | Multi-agent proposals, votes, consensus | Mode D |
| `patterns` | Predictive patterns and suggestions | Mode C |

### Chain Block Structure

Each block is cryptographically signed and linked:

```json
{
  "type": "journal",
  "source": "model-a",
  "schemaVersion": 1,
  "content": "...",
  "timestamp": "2026-04-06T...",
  "signature": "ed25519:...",
  "previousHash": "sha256:..."
}
```

Chains are append-only. You cannot delete individual entries. This provides a tamper-evident audit trail.

### Inspecting Chains

```bash
memphis doctor --json          # Chain block counts and integrity
memphis chain verify           # Verify chain signatures
memphis chain export --chain journal --out journal.json
```

---

## Vault & Secrets

Memphis vault uses AES-256-GCM encryption backed by the Rust NAPI bridge. Your passphrase never leaves the machine.

### Decryption Chain

1. `MEMPHIS_VAULT_PEPPER` (in `.env`) + scrypt = state encryption key
2. State encryption key + AES-256-GCM = master key
3. Master key + Rust `vault_retrieve` = decrypted secret

### What Goes in Vault

- Provider API keys (Anthropic, MiniMax, DeepSeek, GLM)
- OAuth refresh tokens (from `memphis auth anthropic`)
- Telegram bot token
- Matrix access token
- Custom secrets

### Vault References in .env

Instead of raw API keys in `.env`, use vault references:

```dotenv
# Vault-first (recommended):
ANTHROPIC_VAULT_KEY=anthropic_api_key

# Plaintext fallback (for quick setup):
ANTHROPIC_API_KEY=sk-ant-...
```

Memphis checks vault first, then falls back to plaintext `.env`. If both are set, a conflict warning is logged.

### Vault Recovery

If you forget your passphrase, the recovery Q&A is your backup:

```dotenv
MEMPHIS_RECOVERY_QUESTION=What is the agent project name?
MEMPHIS_RECOVERY_ANSWER=Memphis
```

If both passphrase and recovery are lost, vault contents cannot be recovered. You must reinitialize:

```bash
rm -rf ~/.memphis/vault
memphis vault init --passphrase "..." --recovery-question "..." --recovery-answer "..."
# Re-add all secrets
```

---

## Cognitive Modes (A-E)

Five cognitive models that change how Memphis processes and stores information.

### Mode A: Conscious Capture (Default)

- **Temperature**: 0.3 | **Style**: Fast, concise
- Records decisions, notes, milestones to `journal` chain
- Best for: daily operation, note-taking

### Mode B: Inferred Decisions

- **Temperature**: 0.5 | **Style**: Deliberate, detailed
- Detects implicit decisions from activity patterns (git, files)
- Writes to `decisions` chain. Best for: post-session analysis

### Mode C: Predictive Patterns

- **Temperature**: 0.7 | **Style**: Reflective, analogical
- Learns from A+B history, generates predictive suggestions
- Writes to `patterns` chain. Best for: planning, trend analysis

### Mode D: Collective Coordination

- **Temperature**: 0.4 | **Style**: Socratic, collaborative
- Multi-agent voting, consensus, proposals with signatures
- Writes to `collective` chain. Best for: multi-agent environments

### Mode E: Meta-Cognitive Reflection

- **Temperature**: 0.2 | **Style**: Meta, concise
- Self-reflection, contradiction detection, blind spot analysis
- Writes to `reflections` chain. Best for: end-of-day reflection

### Switching

```bash
memphis mode A     # CLI
```

Mode persists to soul-manifest.json and survives restarts.

---

## MCP Tools & Tier Authorization

Memphis exposes an MCP (Model Context Protocol) server with 19 tools across 3 tiers.

### Tool Tiers

| Tier | Auth | Tools |
|------|------|-------|
| **0** | None | `memphis_journal`, `memphis_recall`, `memphis_search`, `memphis_decide`, `memphis_health`, `memphis_repair`, `memphis_soul_read`, `memphis_soul_write`, `memphis_case_append`, `memphis_case_query`, `memphis_loop_step` |
| **2** | Vault passphrase | `memphis_code_read`, `memphis_grep`, `memphis_glob`, `memphis_git`, `memphis_test`, `memphis_exec`, `memphis_cron`, `memphis_web_fetch`, `memphis_self_modify` |

In `full` autonomy mode, all tiers are auto-approved without passphrase.

### Using with Claude Code or Other Agents

Add to your MCP configuration (`~/.claude.json` or similar):

```json
{
  "mcpServers": {
    "memphis": {
      "command": "memphis",
      "args": ["mcp", "serve"]
    }
  }
}
```

### Trust Rules

Override tier defaults for specific tools:

```bash
memphis trust add memphis_exec       # Auto-approve memphis_exec
memphis trust remove memphis_exec    # Revert to tier default
memphis trust list                   # Show current trust rules
```

---

## Telegram Gateway

Memphis connects to Telegram for bidirectional communication.

### Setup

1. Create a bot via [@BotFather](https://t.me/BotFather) and copy the token.
2. Send a message to your bot, then get your chat ID from `https://api.telegram.org/bot<TOKEN>/getUpdates`.
3. Configure in `.env`:

```dotenv
MEMPHIS_CHANNEL_GATEWAY_ENABLED=true
MEMPHIS_TELEGRAM_BOT_TOKEN=123456:ABC-DEF...
MEMPHIS_TELEGRAM_CHAT_ID=your-chat-id
MEMPHIS_TELEGRAM_ALLOWED_USER_IDS=your-user-id
```

4. Restart: `memphis service restart`
5. Verify: `memphis telegram status`

### Telegram Commands

| Command | Action |
|---------|--------|
| `/status` | System health summary |
| `/mode A-E` | Switch cognitive mode |
| `/recall query` | Memory search |
| `/journal note` | Add journal entry |
| Text message | Chat turn through gateway |

### Surface Policy

Telegram is classified as a `chat` surface. Its capabilities are controlled via env vars:

```dotenv
MEMPHIS_SURFACE_TELEGRAM_MAX_TOOL_TIER=2
MEMPHIS_SURFACE_TELEGRAM_ALLOW_UNKNOWN_TOOLS=true
MEMPHIS_SURFACE_TELEGRAM_ALLOW_URL_FETCH=true
MEMPHIS_SURFACE_TELEGRAM_ALLOW_OPERATOR_OVERRIDE=true
```

In `full` autonomy mode, elevated chat surface permissions produce a warning instead of a failure.

---

## Self-Modification

Memphis can modify its own source code through a gated process.

### Requirements

- In `full` mode: no passphrase needed
- In other modes: tier 2 authorization (vault passphrase)
- Clean git state
- All tests passing

### Flow

1. `memphis evolve` initiates a self-modification session
2. Memphis creates a git snapshot (safety net)
3. Creates an isolated branch
4. Makes proposed changes
5. Runs full test suite
6. Presents diff for operator approval
7. If approved: merges. If rejected: rolls back.

### Audit Trail

Every attempt is logged to the `system` chain with timestamp, scope, test results, approval status, and snapshot reference.

---

## Backup & Restore

```bash
memphis backup                     # Create timestamped backup
memphis backup --list              # List all backups
memphis backup --restore <id>      # Restore from backup
```

Backups include: chains, SQLite database, vault state, soul manifest, config.

---

## Systemd Service

Memphis runs as a systemd user service.

### Management

```bash
memphis service install    # Install and enable
memphis service status     # Check health
memphis service restart    # Restart
memphis service logs       # View logs
memphis service uninstall  # Remove service
```

### Manual systemd commands

```bash
systemctl --user status memphis
journalctl --user -u memphis -f    # Live logs
```

---

## Doctor & Troubleshooting

### Running Doctor

```bash
memphis doctor             # Human-readable report
memphis doctor --json      # Machine-readable
memphis doctor --fix       # Auto-repair degraded state
memphis doctor --deep      # Extended checks
```

### Doctor Tiers

| Tier | Category | Checks |
|------|----------|--------|
| 1 | Core Infrastructure | Node, Rust, .env, chains, vault, embeddings, search |
| 2 | Provider Health | Provider connectivity, latency, offline mode |
| 3 | Performance | Query latency, embed latency, RSS memory, disk |
| 4 | Security | Vault encryption, 2FA, DID, pepper, surface hardening |
| 5 | State Health | Orphan files, stale locks, backups, daemon |
| 6 | Integration | Plugin, MCP server, multi-agent sync |
| A | Architecture | Provider fallback, recall contract, type safety |

### Common Fixes

| Issue | Fix |
|-------|-----|
| Vault cycle failed | `memphis vault init --passphrase "..." --recovery-question "..." --recovery-answer "..."` |
| Embeddings empty | `memphis embed reindex` |
| Legacy state | `memphis repair runtime` |
| Service not running | `memphis service install && memphis service restart` |
| MCP unreachable | `memphis service restart` (server listens on PORT from .env) |

---

## Update & Uninstall

### Update

```bash
cd ~/.memphis/memphis   # or wherever you cloned
git pull origin main
npm install
npm run build
memphis doctor          # Verify
```

### Uninstall

```bash
# Stop and remove service
memphis service uninstall

# Remove CLI link
cd ~/.memphis/memphis && npm unlink

# Remove data (DESTRUCTIVE)
cp -r ~/.memphis ~/memphis-backup   # Back up first!
rm -rf ~/.memphis
```

### Keep Data, Remove Code

```bash
memphis service uninstall
cd ~/.memphis/memphis && npm unlink
rm -rf ~/.memphis/memphis
# Chains, vault, config remain in ~/.memphis/
```
