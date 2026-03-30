# Memphis User Guide

This is the complete operator manual for Memphis. It covers everything from first run to daily operation, cognitive modes, vault management, Telegram setup, and self-modification.

## Table of Contents

1. [First Run](#first-run)
2. [CLI Commands](#cli-commands)
3. [TUI (Operator Console)](#tui-operator-console)
4. [Chain Memory System](#chain-memory-system)
5. [Vault & Secrets](#vault--secrets)
6. [Cognitive Modes (A-E)](#cognitive-modes-a-e)
7. [Providers & Models](#providers--models)
8. [Telegram Gateway](#telegram-gateway)
9. [Sessions](#sessions)
10. [MCP Tools & Tier Authorization](#mcp-tools--tier-authorization)
11. [Self-Modification](#self-modification)
12. [Backup & Restore](#backup--restore)
13. [Systemd Service](#systemd-service)
14. [Uninstall](#uninstall)
15. [Update](#update)

---

## First Run

After [installation](INSTALLATION.md), your first interaction with Memphis is:

```bash
memphis init
```

This guided flow handles:

1. **Operator passphrase enrollment** — creates your vault master key. This passphrase protects tier-2 operations (self-modification, source changes). Write it down.
2. **Vault initialization** — creates the encrypted store for API keys, tokens, and secrets.
3. **First-state mode selection**:
   - `minimal-baseline` — smallest transparent starting state. Creates only essential chain entries.
   - `guided-conversation` — interactive dialogue that creates meaningful first chains.
4. **Preview of initial chain writes** — you see exactly what will be written before confirming.
5. **Health summary** — green/yellow/red status of all subsystems.

After init, verify:

```bash
memphis health --json     # Quick health
memphis doctor --json     # Deep diagnostic
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
    agent-profile.json
  soul-manifest.json   # Agent identity + capabilities
  ISKRA.md             # Identity prompt (auto-generated)
  memory.md            # Burn-after-action log
  PULSE.md             # Heartbeat monitor
data/
  memphis.db           # SQLite indexes (derived from chains)
  vault-state.json     # Vault metadata
  vault-entries.json   # Encrypted secrets
```

---

## CLI Commands

Memphis CLI follows the pattern `memphis <command> [options]`.

### Health & Diagnostics

```bash
memphis health --json          # Quick runtime check
memphis doctor --json          # Deep check: chains, vault, providers, Rust bridge
memphis doctor --verbose       # Include stack traces
memphis status                 # Current session and mode info
memphis version                # Version and build info
```

### Memory Operations

```bash
memphis journal "Today I deployed the new API"    # Write to journal chain
memphis journal --tags api,deploy "..."            # Write with tags
memphis recall "API deployment"                    # Semantic search (embeddings)
memphis search "exact phrase"                      # FTS5 exact match
memphis decide "Use PostgreSQL for prod"           # Record a decision
```

### Cognitive Operations

```bash
memphis mode A                 # Switch to Conscious Capture
memphis mode B                 # Switch to Inferred Decisions
memphis mode C                 # Switch to Predictive Patterns
memphis mode D                 # Switch to Collective Coordination
memphis mode E                 # Switch to Meta-Cognitive Reflection
memphis reflect                # Trigger reflection cycle (mode E)
memphis insights               # Show recent cognitive insights
```

### Vault & Secrets

```bash
memphis secret set MINIMAX_API_KEY           # Prompt for value, encrypt, store
memphis secret get MINIMAX_API_KEY           # Decrypt and display (needs passphrase)
memphis secret list                          # List stored secret names (not values)
memphis secret delete MINIMAX_API_KEY        # Remove secret
```

### Provider Management

```bash
memphis provider list                        # Show all providers and status
memphis provider add minimax --api-key <key> # Add provider (key goes to vault)
memphis provider add ollama                  # Add local Ollama
memphis providers health                     # Health check all providers
```

### Telegram

```bash
memphis telegram configure --bot-token <token> --allowed-user-ids <id1,id2>
memphis telegram status                      # Check readiness
memphis telegram send --value "Hello" --to <chat_id>
```

### Sessions

```bash
memphis session list                         # All sessions with timestamps
memphis session new                          # Create fresh session
memphis session switch <id>                  # Change active session
```

### System Operations

```bash
memphis tui                    # Launch native Rust operator console
memphis service install        # Install systemd user service
memphis service status         # Check service health
memphis backup                 # Backup chains and state
memphis restore <path>         # Restore from backup
memphis evolve                 # Self-modification (tier 2, needs passphrase)
```

### MCP Server

```bash
memphis serve                  # Start MCP server (JSON-RPC 2.0)
memphis tools                  # List available MCP tools
memphis tools --tier 0         # List tier-0 tools only
```

---

## TUI (Operator Console)

Launch with `memphis tui`. This is a native Rust terminal application built with Ratatui.

### Screens

| Key | Screen | Shows |
|-----|--------|-------|
| `1` | Overview | Runtime summary, chain health, provider status, PULSE heartbeat |
| `2` | Chat | Multi-turn conversation with live streaming |
| `3` | Memory | Semantic recall + exact search results |
| `4` | Sessions | Session list, active session indicator |
| `5` | Vault | Stored secret names and metadata (not values) |
| `6` | Cases | Case/decision entries from chains |
| `7` | System | Runtime paths, health, configuration |

### Status Bar

The bottom bar shows at a glance:
- Current cognitive mode: `[Mode: A]`
- Active provider: `[Provider: ollama/cogito:3b]` or `[FALLBACK: local]`
- PULSE status: `[PULSE: healthy]` or `[PULSE: degraded]`
- Active session ID

### Navigation

- Number keys `1-7` switch screens
- `q` or `Esc` quit
- `/` open command input
- `Tab` cycle focus areas within a screen

---

## Chain Memory System

Memphis is chain-first: append-only signed chains are the source of truth. SQLite indexes are derived and rebuildable.

### Chain Types

| Chain | Purpose | Written By |
|-------|---------|-----------|
| `journal` | General memory, notes, observations | Model A (Conscious Capture), `memphis journal` |
| `decisions` | Recorded decisions with context | Model B (Inferred Decisions), `memphis decide` |
| `reflections` | Self-reflection output, blind spot analysis | Model E (Meta-Cognitive Reflection) |
| `cases` | Knowledge graph entries (Polish grammatical cases) | Case index, cognitive processing |
| `system` | Boot, heartbeat, mode changes, errors | PULSE heartbeat, bootstrap |
| `collective` | Multi-agent proposals, votes, consensus | Model D (Collective Coordination) |
| `patterns` | Predictive patterns and suggestions | Model C (Predictive Patterns) |

### Chain Block Structure

Each block contains:
```json
{
  "type": "journal",
  "source": "model-a",
  "schemaVersion": 1,
  "content": "...",
  "timestamp": "2026-03-30T...",
  "signature": "ed25519:...",
  "previousHash": "sha256:..."
}
```

### Inspecting Chains

```bash
memphis doctor --json          # Chain block counts and health
ls ~/.memphis/chains/          # Raw chain directories
```

Chains are append-only. You cannot delete individual entries. This is by design — it provides a tamper-evident audit trail.

---

## Vault & Secrets

Memphis vault uses AES-256-GCM encryption with Argon2id key derivation. Your passphrase never leaves the machine.

### What Goes in Vault

- Provider API keys (MiniMax, DeepSeek, GLM)
- Telegram bot token and allowed user IDs
- Matrix access token (if federation enabled)
- Custom secrets via `memphis secret set`
- `MEMPHIS_VAULT_PEPPER` (auto-generated during bootstrap)

### Vault References in .env

Instead of raw API keys in `.env`, Memphis uses vault references:

```dotenv
# Don't do this:
MINIMAX_API_KEY=sk-abc123...

# Do this:
MINIMAX_API_KEY=VAULT:minimax_api_key
```

When Memphis sees `VAULT:key_name`, it resolves the value from the encrypted vault at runtime.

### Vault Operations

```bash
memphis secret set minimax_api_key      # Encrypt and store
memphis secret list                     # Names only
memphis secret get minimax_api_key      # Decrypt (needs passphrase)
memphis secret delete minimax_api_key   # Remove
```

### Vault Recovery

If you forget your passphrase, vault contents cannot be recovered (by design). You will need to:

1. Delete `data/vault-state.json` and `data/vault-entries.json`
2. Run `memphis init` to create a new vault
3. Re-add all secrets

---

## Cognitive Modes (A-E)

Memphis has five cognitive models that change how it processes and stores information.

### Mode A: Conscious Capture (Default)

- **Temperature**: 0.3 (focused, precise)
- **Style**: Fast, concise
- **Function**: Explicitly records decisions, notes, milestones
- **Writes to**: `journal` chain
- **Best for**: Daily operation, note-taking, explicit memory recording

### Mode B: Inferred Decisions

- **Temperature**: 0.5 (balanced)
- **Style**: Deliberate, detailed
- **Function**: Detects implicit decisions from activity patterns (git commits, file changes)
- **Writes to**: `decisions` chain
- **Best for**: Post-session analysis, decision archaeology

### Mode C: Predictive Patterns

- **Temperature**: 0.7 (creative, exploratory)
- **Style**: Reflective, analogical
- **Function**: Learns from A+B history, generates predictive suggestions
- **Writes to**: `patterns` chain
- **Best for**: Planning, trend analysis, "what should I do next?"

### Mode D: Collective Coordination

- **Temperature**: 0.4 (precise but collaborative)
- **Style**: Socratic, collaborative
- **Function**: Multi-agent voting, consensus, proposals with cryptographic signatures
- **Writes to**: `collective` chain
- **Best for**: Multi-agent environments, group decisions

### Mode E: Meta-Cognitive Reflection

- **Temperature**: 0.2 (most focused)
- **Style**: Meta, concise
- **Function**: Self-reflection, contradiction detection, blind spot analysis
- **Writes to**: `reflections` chain
- **Best for**: End-of-day reflection, quality audits, self-improvement

### Switching Modes

```bash
memphis mode A                 # CLI
```

In TUI: use the mode indicator in the status bar or the `/mode` command.

Mode persists to `soul-manifest.json` and survives restarts.

---

## Providers & Models

Memphis supports multiple LLM providers with automatic fallback.

### Provider Priority

1. **Ollama** (local) — default, no API key needed, fully offline
2. **MiniMax** — cloud provider, needs API key in vault
3. **DeepSeek** — cloud provider, needs API key in vault
4. **GLM** — cloud provider, needs API key in vault
5. **local-fallback** — deterministic 32-dim embeddings, no generation. Used when nothing else works.

### Ollama Setup

```bash
# Install Ollama (if not present)
curl -fsSL https://ollama.ai/install.sh | sh

# Pull required models
ollama pull cogito:3b            # Chat/generation model
ollama pull nomic-embed-text     # Embedding model

# Verify
curl http://127.0.0.1:11434/api/tags
```

Memphis auto-detects Ollama on startup. If Ollama is unavailable, it falls back to `local-fallback` with a clear indicator in TUI.

### Adding Cloud Providers

```bash
memphis provider add minimax --api-key <your-key>
```

This stores the API key in vault and configures the provider. Switch the active provider in `.env`:

```dotenv
DEFAULT_PROVIDER=minimax
```

### Small Model Detection

Memphis detects model size and applies tier-based feature gating:
- **Small models** (< 7B params): Tier 0 tools only
- **Medium models** (7-30B): Tier 0-1 tools
- **Large models** (30B+): All tiers

---

## Telegram Gateway

Memphis can connect to Telegram for bidirectional communication.

### Setup

1. **Create a bot** via [@BotFather](https://t.me/BotFather) on Telegram:
   - Send `/newbot` to BotFather
   - Choose a name and username
   - Copy the bot token (looks like `123456:ABC-DEF...`)

2. **Get your chat ID**:
   - Send a message to your new bot
   - Visit `https://api.telegram.org/bot<TOKEN>/getUpdates`
   - Find your `chat.id` in the response

3. **Configure Memphis**:
   ```bash
   memphis telegram configure \
     --bot-token <your-bot-token> \
     --allowed-user-ids <your-chat-id>
   ```
   Both values are stored in vault.

4. **Enable the gateway** in `.env`:
   ```dotenv
   MEMPHIS_CHANNEL_GATEWAY_ENABLED=true
   ```

5. **Verify**:
   ```bash
   memphis telegram status
   ```

### Telegram Commands

Once configured, send these to your bot:

| Command | Action |
|---------|--------|
| `/status` | System health summary |
| `/mode A-E` | Switch cognitive mode |
| `/recall query` | Memory search |
| `/journal note` | Add journal entry |
| Text message | Chat turn through the gateway |

### Events Out

When the gateway is enabled, Memphis sends notifications to your Telegram for:
- Boot/shutdown events
- Health state changes (healthy to degraded)
- Self-modification results
- Cognitive mode changes

---

## Sessions

Memphis supports multiple sessions to prevent file conflicts and allow context switching.

### Session Isolation

Each session has its own:
- Conversation history
- Active cognitive mode (inherited from soul-manifest at creation)
- Chain write context (entries tagged with session ID)

### Managing Sessions

```bash
memphis session list           # Show all with timestamps and status
memphis session new            # Create fresh session
memphis session switch <id>    # Change active session
```

In TUI: navigate to the Sessions screen (`4`) to view and switch.

---

## MCP Tools & Tier Authorization

Memphis exposes an MCP (Model Context Protocol) server with 15+ tools.

### Tool Tiers

| Tier | Auth | Tools |
|------|------|-------|
| **0** | None | `memphis_journal`, `memphis_recall`, `memphis_search`, `memphis_health`, `memphis_soul_read`, `memphis_case_query` |
| **1** | API Token | `memphis_vault_secrets`, `memphis_config_write`, `memphis_provider_change`, `memphis_channel_config` |
| **2** | Vault Passphrase | `memphis_self_modify`, `memphis_tool_install`, `memphis_branch_create`, `memphis_snapshot` |

### Starting MCP Server

```bash
memphis serve                  # Start JSON-RPC 2.0 server
```

### Using with Claude Code or Other Agents

Add to your MCP configuration:

```json
{
  "mcpServers": {
    "memphis": {
      "command": "memphis",
      "args": ["serve"]
    }
  }
}
```

---

## Self-Modification

Memphis can modify its own source code through a gated process.

### Requirements

- Tier 2 authorization (vault passphrase)
- Clean git state
- All tests passing

### Flow

1. `memphis evolve` — initiates self-modification session
2. Memphis creates a git snapshot (safety net)
3. Creates an isolated branch
4. Makes proposed changes
5. Runs full test suite
6. Presents diff for operator approval
7. If approved: merges. If rejected: rolls back to snapshot.

### Audit Trail

Every self-modification attempt is logged to the `system` chain with:
- Timestamp
- Scope of changes
- Test results
- Approval status
- Snapshot reference (for rollback)

---

## Backup & Restore

### Backup

```bash
memphis backup                 # Creates timestamped backup
```

This backs up:
- All chains (`~/.memphis/chains/`)
- SQLite database (`data/memphis.db`)
- Vault state (`data/vault-state.json`, `data/vault-entries.json`)
- Soul manifest and config

### Restore

```bash
memphis restore <backup-path>
```

### Manual Backup

```bash
cp -r ~/.memphis/chains/ ~/memphis-backup-chains/
cp data/memphis.db ~/memphis-backup-db.sqlite
cp data/vault-entries.json ~/memphis-backup-vault.json
```

---

## Systemd Service

Memphis can run as a systemd user service for persistent operation.

### Install

```bash
memphis service install
```

### Manage

```bash
systemctl --user start memphis
systemctl --user stop memphis
systemctl --user restart memphis
systemctl --user status memphis
journalctl --user -u memphis -f   # Live logs
```

### Common Issue: WorkingDirectory

If the service crash-loops, check the WorkingDirectory in the unit file:

```bash
systemctl --user cat memphis
```

Ensure it points to your actual Memphis installation directory.

---

## Uninstall

### Remove Memphis

```bash
# Stop service if running
systemctl --user stop memphis
systemctl --user disable memphis

# Remove npm link
cd /path/to/memphis
npm unlink

# Remove data (DESTRUCTIVE - backs up chains first)
cp -r ~/.memphis ~/memphis-chains-backup
rm -rf ~/.memphis
rm -rf /path/to/memphis/data

# Remove source
rm -rf /path/to/memphis
```

### Keep Data, Remove Code

If you want to preserve your chains and vault for a future reinstall:

```bash
systemctl --user stop memphis
cd /path/to/memphis && npm unlink
# Data remains in ~/.memphis/ and data/
rm -rf /path/to/memphis
```

---

## Update

### From Source

```bash
cd /path/to/memphis
git pull origin main
npm install
npm run build
memphis health --json          # Verify
```

### Version-Specific Migration

Check [UPGRADE.md](UPGRADE.md) for version-specific migration notes.

### After Update

```bash
memphis doctor --json          # Full diagnostic
memphis health --json          # Quick health
```

Chain format is append-only and backwards compatible. Updates never modify existing chain entries.
