# Memphis Installation Guide

Fresh install guide for Memphis — a sovereign AI agent runtime with Rust core and TypeScript orchestration.

## Requirements

| Dependency | Version | Required | Purpose |
|-----------|---------|----------|---------|
| Node.js | >= 20 (24.x recommended) | Yes | TypeScript runtime, CLI, HTTP server |
| Rust | stable (latest) | Yes | Chain integrity, vault encryption, embeddings |
| git | any recent | Yes | Clone repo, version control |
| Ollama | latest | Recommended | Local LLM + embedding provider |

## Step 1: Install Node.js

**Ubuntu / Debian:**

```bash
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt install -y nodejs
```

**macOS:**

```bash
brew install node@24
```

**Verify:**

```bash
node --version   # v24.x.x
npm --version    # 10.x+
```

## Step 2: Install Rust

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
source ~/.cargo/env
```

**Verify:**

```bash
rustc --version   # rustc 1.8x.x
cargo --version   # cargo 1.8x.x
```

## Step 3: Install Ollama (recommended)

Ollama provides the local LLM runtime and embedding model. Memphis works without it (falls back to cloud providers or local-fallback), but it's the recommended default.

```bash
curl -fsSL https://ollama.com/install.sh | sh
```

Pull the models Memphis uses:

```bash
ollama pull cogito:3b          # local chat model
ollama pull nomic-embed-text   # embedding model (768-dim)
```

**Verify:**

```bash
ollama list   # should show cogito:3b and nomic-embed-text
```

## Step 4: Clone and Bootstrap

```bash
git clone https://github.com/Memphis-Chains/memphis.git
cd memphis
npm run bootstrap
```

Bootstrap handles everything:

1. Creates `.env` from `.env.example` with generated secrets
2. Generates `MEMPHIS_API_TOKEN` (HTTP auth) and `MEMPHIS_VAULT_PEPPER` (vault encryption anchor)
3. Creates agent profile (`~/.memphis/config/agent-profile.json`)
4. Installs npm dependencies (`npm ci`)
5. Builds Rust crates + TypeScript (`npm run build`)
6. Initializes workspace context
7. Seeds soul identity (agent name, capabilities, foundational chain entries)
8. Installs systemd user service (if available)

## Step 5: Initialize the Vault

The vault stores encrypted secrets (API keys, tokens). Initialize it with a passphrase you'll remember:

```bash
npm run -s cli -- vault init \
  --passphrase "your-secret-passphrase" \
  --recovery-question "your recovery question" \
  --recovery-answer "your recovery answer"
```

## Step 6: Verify Installation

```bash
npm run -s cli -- doctor --fix    # diagnose and auto-repair
npm run -s cli -- health --json   # runtime health check
npm run -s cli -- soul show       # verify agent identity
```

Expected:

- `doctor` reports zero failures
- `health` returns all subsystems OK
- `soul show` displays agent name, owner, and populated memory

## Step 7: Start Memphis

**Option A: systemd service (recommended for always-on)**

If bootstrap installed the service:

```bash
npm run -s cli -- service status
npm run -s cli -- service restart
```

**Option B: manual (foreground)**

```bash
npm run dev
```

## Step 8: Open the TUI

In another terminal:

```bash
npm run -s cli -- tui
```

You now have a running Memphis agent with persistent memory, chain-backed audit trail, and semantic recall.

## Configure Cloud Providers (optional)

Edit `.env` to add cloud LLM providers:

```bash
# MiniMax (OpenAI-compatible)
MINIMAX_API_KEY=sk-your-key-here
MINIMAX_MODEL=MiniMax-M2.7

# DeepSeek
DEEPSEEK_API_KEY=sk-your-key-here

# Set primary provider (default: ollama)
SOUL_PROVIDER=minimax
```

Restart after changes:

```bash
npm run -s cli -- service restart
# or: npm run dev
```

Verify provider connectivity:

```bash
npm run -s cli -- providers health
```

## Directory Structure After Install

```
memphis/                    # project root
  .env                      # local config + secrets (git-ignored)
  data/                     # SQLite, embed index, WAL
  crates/                   # Rust source (core, vault, embed, napi)
  src/                      # TypeScript source
  dist/                     # compiled output

~/.memphis/                 # runtime data (outside repo)
  config/
    agent-profile.json      # agent identity
    soul-manifest.json      # capabilities manifest (auto-generated)
    soul-memory.json        # persistent learned knowledge
  chains/
    journal/                # memory chain (semantic-indexed)
    system/                 # audit trail
    decisions/              # recorded choices
    reflections/            # self-assessment
    cases/                  # semantic knowledge graph
  embed/                    # HNSW vector index
  vault/                    # encrypted secret storage
```

## Managing the Service

```bash
# Memphis CLI
npm run -s cli -- service status
npm run -s cli -- service restart
npm run -s cli -- service logs --latest 100

# systemd equivalents
systemctl --user status memphis.service
systemctl --user restart memphis.service
journalctl --user -u memphis -f
```

## HTTP API Quick Test

```bash
TOKEN=$(grep '^MEMPHIS_API_TOKEN=' .env | cut -d= -f2-)

# Health
curl http://127.0.0.1:3000/health

# Store a memory
curl -X POST http://127.0.0.1:3000/api/journal \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"content":"test memory entry","tags":["test"]}'

# Recall
curl -X POST http://127.0.0.1:3000/api/recall \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"query":"test memory","limit":5}'
```

## Troubleshooting

### `npm run bootstrap` fails during Rust build

```bash
# Ensure Rust is in PATH
source ~/.cargo/env
rustc --version

# Rebuild
npm run build:rust
npm run build
```

### `better-sqlite3` or `NODE_MODULE_VERSION` mismatch

Node.js version changed since last install. Rebuild native modules:

```bash
npm ci
npm run build
```

### Server does not respond on `:3000`

```bash
npm run -s cli -- service status
npm run -s cli -- service logs --latest 100
# If no service, run manually:
npm run dev
```

### `chain integrity check failed` during startup

```bash
npm run -s cli -- doctor --fix
# If persists after fix:
npm run -s cli -- doctor --force
```

### Vault commands fail

- Check `MEMPHIS_VAULT_PEPPER` exists in `.env`
- Confirm vault was initialized: `npm run -s cli -- vault list`
- The pepper must match the one used during `vault init`

### Soul memory empty

```bash
npm run -s cli -- soul seed
# or auto-fix via doctor:
npm run -s cli -- doctor --fix
```

## Uninstall

```bash
# Stop service
systemctl --user stop memphis.service
systemctl --user disable memphis.service

# Remove runtime data
rm -rf ~/.memphis

# Remove repo
cd .. && rm -rf memphis
```
