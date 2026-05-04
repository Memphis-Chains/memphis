# Memphis Installation Guide

Fresh install guide for Memphis — a sovereign AI agent runtime with Rust core and TypeScript orchestration.

## The one-liner (recommended)

Linux / macOS / WSL:

```bash
curl -fsSL https://raw.githubusercontent.com/Memphis-Chains/memphis/main/scripts/install.sh | bash
```

The installer auto-detects your OS and package manager and handles everything:

1. Installs `git`, `curl`, and a C/C++ build toolchain (`build-essential` / `Development Tools` / `base-devel` / Xcode CLI tools)
2. Installs **Node.js 22+** from NodeSource / Homebrew / your distro
3. Installs **Rust stable** via `rustup` (or upgrades from nightly)
4. Clones Memphis into `~/.memphis/memphis` (or reuses an existing checkout)
5. Runs `npm install` + `npm run build` (Rust crates + TypeScript)
6. Links the global `memphis` CLI via `npm link`
7. Prints a post-install banner with next-step commands

**No soul state, no vault, no agent identity is created by the installer.** First-run is a deliberate, gated step — see [After install](#after-install) below.

**Audit without running:**

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/Memphis-Chains/memphis/main/scripts/install.sh) --check-only --json
```

**Environment overrides:**

| Variable              | Default                                         | Purpose                                     |
| --------------------- | ----------------------------------------------- | ------------------------------------------- |
| `MEMPHIS_INSTALL_DIR` | `$HOME/.memphis`                                | Parent dir for the checkout                 |
| `MEMPHIS_TARGET_DIR`  | `$MEMPHIS_INSTALL_DIR/memphis`                  | Exact checkout path                         |
| `MEMPHIS_REPO_URL`    | `https://github.com/Memphis-Chains/memphis.git` | Alternate git remote                        |
| `MEMPHIS_YES=1`       | unset                                           | Non-interactive mode (auto-confirm prompts) |

## After install

Run these commands in order — they're short, explicit, and each one is gated on the previous succeeding:

```bash
memphis init              # passphrase, vault, identity, first chain writes
memphis doctor            # verify everything is healthy
memphis service install   # install & enable systemd user service
memphis service restart   # start (or restart) the runtime
memphis tui               # open the native operator console
```

### Optional: local voice stack

If you want voice messages in Telegram or TUI handled fully on-device (faster-whisper STT + Piper TTS, ~80 MB Polish voice download):

```bash
memphis voice install                  # default: gosia (female, Polish)
memphis voice install --voice darkman  # male voice instead
memphis voice status                   # confirm both engines reachable
```

After install, set `MEMPHIS_VOICE_MODE=local` in `.env` and restart the service. See `docs/operator/voice-local-stt.md` + `voice-local-tts.md` for details.

### Smoke test

Verify the install end-to-end with the post-install smoke script:

```bash
bash scripts/post-install-smoke.sh           # green/yellow/red summary
bash scripts/post-install-smoke.sh --json    # machine-readable
bash scripts/post-install-smoke.sh --strict  # exit 1 on warnings too
```

Checks: CLI on PATH, systemd service active, HTTP /health reachable, memphis health/doctor pass, vault initialized, chains writable, providers configured, voice stack (if MEMPHIS_VOICE_MODE=local).

### Everyday commands

```bash
memphis health                 # runtime health check
memphis service status         # is the daemon alive?
memphis service logs -n 100    # recent logs
memphis doctor --fix           # diagnose + auto-repair degraded state
memphis providers list         # configured LLM providers
memphis vault list             # inspect vault entries
memphis vault add <key>        # store a secret in the encrypted vault
memphis journal "<text>"       # write to the journal chain
memphis recall "<query>"       # semantic recall (embedding-backed)
memphis search "<phrase>"      # exact search (FTS5-backed)
memphis evolve log             # agent self-modification history
memphis tui                    # interactive terminal console
```

Run `memphis --help` for the full command surface.

---

## Manual install

If you prefer to install each dependency yourself (contributing to Memphis, reviewing the build, air-gapped machines, etc.), follow the steps below.

### Requirements

| Dependency | Version                  | Required    | Purpose                                       |
| ---------- | ------------------------ | ----------- | --------------------------------------------- |
| Node.js    | >= 22 (22.x recommended) | Yes         | TypeScript runtime, CLI, HTTP server          |
| Rust       | stable (latest)          | Yes         | Chain integrity, vault encryption, embeddings |
| git        | any recent               | Yes         | Clone repo, version control                   |
| Ollama     | latest                   | Recommended | Local LLM + embedding provider                |

## Step 1: Install Node.js

**Ubuntu / Debian:**

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
```

**macOS:**

```bash
brew install node@22
```

**Verify:**

```bash
node --version   # v22.x.x or newer
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

This source-checkout path is the canonical full-runtime operator flow for GA.
GitHub Releases and GitHub Packages publish the package artifact and CLI
distribution path, but they do not replace bootstrap for the full local runtime.

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
7. Installs systemd user service (if available)

Bootstrap is technical install/build only. It does not silently create
meaningful identity or soul state.

To verify the installer contract without mutating the host, run:

```bash
bash ./scripts/install.sh --check-only --json
```

## Step 5: Run Controlled First-Run

Run the canonical controlled first-run:

```bash
npm run -s cli -- init
```

`init` now owns:

- operator passphrase enrollment
- vault initialization
- first-state mode selection
- preview/confirmation of first chain writes
- final health summary

If `memphis` is already on your `PATH`, the same step is:

```bash
memphis init
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

Cloud providers (MiniMax, DeepSeek, GLM) are configured via the `memphis provider add` command, which securely stores API keys in vault:

```bash
# MiniMax
memphis provider add minimax --api-key sk-your-key-here

# DeepSeek
memphis provider add deepseek --api-key sk-your-key-here

# GLM
memphis provider add glm --api-key sk-your-key-here
```

Keys are stored encrypted in vault, not in `.env`. The `.env` file holds only vault references (e.g., `MINIMAX_VAULT_KEY=minimax_api_key`).

Restart after adding a provider:

```bash
npm run -s cli -- service restart
# or: npm run dev
```

Verify provider connectivity:

```bash
npm run -s cli -- providers health
```

## Configure Telegram (optional)

Private 1:1 Telegram bot with bidirectional communication.

```bash
memphis telegram configure --bot-token <token> --allowed-user-ids <your_telegram_user_id>
```

- Get bot token from https://t.me/BotFather
- Get your Telegram user ID from https://t.me/userinfobot
- Secrets are stored encrypted in vault; `.env` holds only `VAULT:` references
- Enable the gateway: set `MEMPHIS_CHANNEL_GATEWAY_ENABLED=true` in `.env`

Verify:

```bash
npm run -s cli -- telegram status
npm run -s cli -- doctor --json | grep telegram
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
