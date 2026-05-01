# Memphis — install from scratch (fresh user guide)

This document walks you through installing Memphis **with no help**. Every step states *what you do*, *why*, *which command to run*, *what you should see*, and *how to know it worked*.

If something fails, read the error message and check [Troubleshooting](#troubleshooting) at the bottom. Don't skip steps.

---

## What is Memphis

Memphis is a local AI agent that runs **on your computer**. Unlike ChatGPT or Claude:
- It doesn't send your data to a foreign cloud (you can use a local LLM via Ollama).
- It remembers your conversations in an encrypted file (vault + chain).
- It can write a journal, recall earlier decisions, run tools (read files, query the web, invoke commands).
- It's operator-driven — you decide what it does.

It runs as a **background service** + **terminal UI (TUI)** + **HTTP API** (if you want your own GUI).

---

## Requirements

| What | How much | Notes |
|------|----------|-------|
| OS | Linux (Ubuntu 22/24, Debian 12, Fedora), macOS, WSL2 on Windows | Heaviest testing on Ubuntu 24.04 |
| RAM | min 8 GB, recommended 16 GB | Without RAM Ollama will choke on 7B models |
| Disk | 20 GB free | Memphis itself ~2 GB, Ollama 7B model ~5 GB, the rest for chains/logs |
| CPU | any x86_64, 4 cores | Intel i3 is enough; ARM (Raspberry Pi 5) also works |
| Internet | only for the first download | Runs offline after install |
| Terminal access | yes | Everything is done by typing commands |
| `sudo` | yes | A few system packages need it |

---

## How to use this document

Each step looks like this:

> ### Step N — Title
> **What you do:** one sentence.
> **Why:** the reason.
> **Command:** what to type.
> **What to expect:** the visible output.
> **Verification:** how to confirm success.

---

## Step 0 — confirm you have a terminal and git

**What you do:** check your system has the basics.
**Why:** without a terminal and git nothing else installs.

Open a terminal (Ubuntu: `Ctrl+Alt+T`). Run:

```bash
git --version && echo "---" && uname -a && echo "---" && whoami
```

**What to expect:**
```
git version 2.43.0
---
Linux yourbox 6.8.0-... #112-Ubuntu ...
---
yourlogin
```

**Verification:** if `git --version` returns a version number, you're good. If `git: command not found`:
```bash
sudo apt update && sudo apt install -y git
```

---

## Step 1 — install base system packages

**What you do:** add the build tooling Memphis compiles with.
**Why:** Memphis compiles Rust and TypeScript; it needs a C/C++ compiler, archive tools, and a few libraries.

**Ubuntu/Debian:**
```bash
sudo apt update
sudo apt install -y git curl wget build-essential pkg-config zstd ffmpeg jq openssl ca-certificates
```

The package manager will list ~30 packages, ask for confirmation (press `Y` or Enter), and install them. Takes 1–3 minutes.

**Verification:**
```bash
gcc --version && curl --version | head -1 && zstd --version | head -1
```
Each should return a version. If all three are OK, continue.

> **Fedora**: use `sudo dnf install git curl wget gcc gcc-c++ make pkgconf zstd ffmpeg jq openssl-devel`.
> **macOS**: `brew install git curl wget zstd ffmpeg jq` (build tools come from Xcode CLI: `xcode-select --install`).

---

## Step 2 — install Node.js 22

**What you do:** install the runtime Memphis runs on.
**Why:** most of Memphis is TypeScript — it must run on Node.js. Version **22 or newer**.

**Ubuntu/Debian (official NodeSource repo):**
```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
```

**Verification:**
```bash
node --version
npm --version
```
`node` should report **v22.x.x** (or higher). `npm` should report ~10.x.x.

If `node --version` shows v18 or v20, remove the old version: `sudo apt remove nodejs` and repeat Step 2.

---

## Step 3 — install Rust

**What you do:** install Rust to build Memphis's core (cryptography, fast search, data integrity).
**Why:** part of Memphis (encrypted vault, hash-linked chain, embeddings) is in Rust for safety and performance.

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --default-toolchain stable
source "$HOME/.cargo/env"
```

The `rustup` installer fetches Rust + `cargo` (Rust's package manager). The `source` line loads env variables into the current shell.

**Verification:**
```bash
rustc --version
cargo --version
```
Should print something like `rustc 1.8x.x` and `cargo 1.8x.x`.

> **If a new terminal session reports `rustc: command not found`**, append to `~/.bashrc`: `echo '. "$HOME/.cargo/env"' >> ~/.bashrc && source ~/.bashrc`.

---

## Step 4 — install Ollama and pull a model

**What you do:** install Ollama (a local LLM engine) and pull a language model Memphis will talk to.
**Why:** Memphis can use the cloud (Anthropic, MiniMax, OpenAI, …) but defaults to a **local model** so your conversations never leave your computer.

```bash
curl -fsSL https://ollama.com/install.sh | sh
```

The installer adds Ollama as a system service and starts it. You'll see `>>> Installing ollama to /usr/local/bin...`.

Then pull a model (~5 GB, needs the internet, takes 10–30 min depending on your link):

```bash
ollama pull qwen2.5:7b
```

A progress bar fetches the model layers. When it finishes you see `success`.

**Verification:**
```bash
ollama list
curl http://127.0.0.1:11434/api/tags
```
- `ollama list` shows a row with `qwen2.5:7b`.
- `curl` returns JSON listing the models (Ollama is listening on port 11434).

> **Less than 8 GB RAM** or you want a faster/smaller model: `ollama pull qwen2.5:3b` or `ollama pull llama3.2:3b`. Remember the name — you'll set it in Step 7.

---

## Step 5 — clone Memphis

**What you do:** clone the official Memphis source into a folder on your computer.
**Why:** you need the source to build and run.

```bash
cd ~
git clone https://github.com/Memphis-Chains/memphis.git memphis
cd memphis
```

`git` shows a progress bar (Receiving objects…). About 45 MB total, 10–60s depending on your link.

**Verification:**
```bash
pwd
ls README.md package.json Cargo.toml
git log --oneline -3
```
- `pwd` should show `/home/YOURLOGIN/memphis`.
- `ls` should show all three files (you're in the source tree).
- `git log` shows the three latest commits.

> **Already have `~/memphis`?** Skip to Step 6. To start fresh: `rm -rf ~/memphis` then redo Step 5.

---

## Step 6 — build Memphis

**What you do:** install npm dependencies and compile Memphis (Rust + TypeScript).
**Why:** the source can't run as-is — it needs to be translated to executable form.

**In the `memphis` directory:**
```bash
npm install
npm run build
```

- `npm install` — fetches ~600 npm packages (2–5 min). "deprecated" warnings are fine; the only failure mode is a red `error` line.
- `npm run build` — compiles Rust first (first time: **10–15 minutes on Intel i3**, faster afterwards), then TypeScript (1–2 min).

When you see the prompt `$` again — done.

**Verification:**
```bash
ls dist/index.js
ls crates/memphis-napi/index.node
```
Both files must exist. If either is missing, `npm run build` failed — see [Troubleshooting](#troubleshooting).

> **Add the global `memphis` command:**
> ```bash
> sudo npm link
> which memphis   # should print a path
> memphis --version
> ```
> If you don't want `sudo npm link`, run locally with `./bin/memphis.js <command>`. This guide assumes you have the global `memphis`.

---

## Step 7 — configure environment (`.env` file)

**What you do:** create a config file — which Ollama model, where to store data, what token protects the HTTP API.
**Why:** Memphis doesn't know your preferences — they all live in `.env`.

```bash
cp .env.example .env
nano .env
```

**Generate the API token first** (always required — empty token = HTTP API returns 401 fail-closed; this is intentional):
```bash
openssl rand -hex 32
```
Copy the output. You'll paste it into `.env` below.

**What to set:**

```
NODE_ENV=development
HOST=127.0.0.1
PORT=3000
MEMPHIS_API_TOKEN=<paste-the-openssl-output>
DEFAULT_PROVIDER=ollama
OLLAMA_URL=http://127.0.0.1:11434
OLLAMA_MODEL=qwen2.5:7b               # if you pulled a different model, set its name
DATABASE_URL=file:./data/memphis.db
RUST_CHAIN_ENABLED=true
```

`MEMPHIS_API_TOKEN` is **mandatory** — it's the bearer token the HTTP API and TUI use to authenticate. If it's missing, every authenticated `/v1/*` route returns 401 with "MEMPHIS_API_TOKEN not configured". Generate a fresh one for every install (don't reuse).

Save (`Ctrl+O`, Enter, `Ctrl+X` in `nano`).

**Verification:**
```bash
grep '^MEMPHIS_API_TOKEN\|^DEFAULT_PROVIDER\|^OLLAMA_MODEL' .env
```
Should print your three lines.

---

## Step 8 — first run: `memphis init`

**What you do:** initialize Memphis's identity — set a vault passphrase, recovery question, first journal entries.
**Why:** Memphis needs a **passphrase** (long password) to encrypt vault secrets. Without it, password-protected features are unavailable.

```bash
memphis init
```

A series of interactive questions:

1. **Passphrase** (entered twice for confirmation) — long password (min 12 chars, 20+ recommended). **Save it in a password manager or on paper** — **without it you lose vault access**.
2. **Recovery question** — something you'll remember (e.g., "favorite primary-school teacher").
3. **Recovery answer** — remember **exactly** (case + spaces matter).
4. **Agent name** — your agent's name (e.g., "Memphis" or whatever).
5. **Owner name** — your handle (e.g., "Wodzu", "Marcin", "local operator").

Once answered, Memphis creates files under `~/.memphis/` (agent state) and prints "Memphis initialized successfully".

**Verification:**
```bash
ls ~/.memphis/config/
```
You should see: `soul-manifest.json`, `agent-profile.json`, `first-run.json`, plus identity/heartbeat files.

> **Lost your passphrase?** Recovery via Q&A: `memphis vault recovery-unlock`. If you lose recovery too, vault is gone. Only option: `rm -rf ~/.memphis` and start over with `memphis init`.

---

## Step 9 — verify everything works: `memphis doctor`

**What you do:** run diagnostics.
**Why:** doctor checks the Rust bridge loads, Ollama responds, the chain is intact, the vault is readable, every adapter is healthy.

```bash
memphis doctor
```

A table of checks, each `[✓]` or `[✗]`. At the bottom: `Summary: healthy` (green) or `degraded` / `unhealthy`.

**If anything is red**, run with auto-repair:
```bash
memphis doctor --fix
```

**Verification:**
```bash
memphis health
```
Should return `status: healthy` or JSON with `"status":"healthy"`.

---

## Step 10 — first conversation: `memphis tui`

**What you do:** open Memphis's interactive console and have a first conversation.
**Why:** `tui` = terminal UI, your main way to use Memphis (besides the API and `memphis ask "question"` for one-shot queries).

```bash
memphis tui
```

The screen splits into sections (history, input, status). Type:
```
Hi, who are you?
```
Press Enter. Memphis thinks for a moment (Ollama generates the reply locally — first time may take 5–30s while the model loads into RAM), then prints an answer.

**Verification:** you got a coherent reply. Exit with `Ctrl+C` or the command `/exit`.

**First things to try:**
```
Save in the journal: starting work on Memphis.
What do you remember from our conversation?
What tools do you have?
```

---

## Step 11 — (optional) run as a background service

**What you do:** make Memphis run as a **system service** so it's always up after reboot.
**Why:** without this, Memphis runs only while your terminal is open.

```bash
memphis service install
memphis service status
```

- `install` writes `memphis.service` to `~/.config/systemd/user/` **and immediately enables it (`systemctl --user enable --now`) — no separate `start` needed**.
- `status` shows whether the service is alive (`active (running)`).
- Already installed and want to refresh: `memphis service restart`.

**Confirm the HTTP API is listening:**
```bash
curl http://127.0.0.1:3000/health
```
Should return `{"ok":true,...}` or `{"status":"healthy"}`.

> **Using Memphis only via TUI?** Skip this step. Come back to it when you set up a LAN server or GUI.

---

## Daily commands (cheatsheet)

```bash
# Conversation
memphis tui                              # interactive console
memphis ask --input "what's in the journal today?"

# Memory
memphis chain verify                     # chain integrity check
memphis embed store                      # rebuild semantic search index
memphis recall --query "decision X"

# Management
memphis doctor                           # full diagnostics
memphis service status / restart / logs
memphis backup create                    # full state backup
memphis self-update check                # check for newer version

# Secrets (vault)
memphis secret add --key OPENAI_KEY --value sk-...
memphis secret list
memphis vault recovery-unlock            # if you lost the passphrase

# Agent data
memphis soul show                        # identity + capabilities
memphis trust list                       # tool-permission rules
memphis insights --daily
```

---

## Troubleshooting

### `node: command not found` or `node --version` shows v18/v20

You have an old Node. Remove it:
```bash
sudo apt remove nodejs
```
Then redo Step 2 (NodeSource repo + `apt install nodejs`).

### `rustc: command not found` in a new terminal

`source $HOME/.cargo/env` only loads in the current shell. Make it permanent:
```bash
echo '. "$HOME/.cargo/env"' >> ~/.bashrc
source ~/.bashrc
```

### `npm run build` fails on the Rust step

Most often: missing system packages. Install:
```bash
sudo apt install -y build-essential pkg-config libssl-dev
```
Then retry `npm run build`.

If you see `error: linker 'cc' not found`, you're missing `gcc`:
```bash
sudo apt install -y gcc
```

### Ollama doesn't respond (connection refused on :11434)

Check it's running:
```bash
systemctl --user status ollama
# or system-wide:
sudo systemctl status ollama
```
Start if stopped: `sudo systemctl start ollama`.

### `memphis init` doesn't see Ollama

Probably `OLLAMA_URL` is wrong in `.env`. Verify Ollama answers locally:
```bash
curl http://127.0.0.1:11434/api/tags
```
If yes, set `OLLAMA_URL=http://127.0.0.1:11434` in `.env` and retry.

### `memphis: command not found` after `npm link`

Either you skipped `npm link` or `~/.npm-global/bin` isn't on your `PATH`. Quickest:
```bash
which memphis || (sudo npm link && which memphis)
```
If still missing:
```bash
echo 'export PATH="$HOME/.npm-global/bin:$PATH"' >> ~/.bashrc
source ~/.bashrc
```

### `memphis doctor` reports `chain integrity failure`

Run auto-repair:
```bash
memphis doctor --fix
```
If that doesn't help, restore from a backup:
```bash
memphis backup list
memphis backup restore --file <name-from-list>
```

---

## Next steps

- Read the full [Operator Handbook](operator-handbook.md) for the Day 0 → Day 90 workflow.
- See [Troubleshooting Guide](TROUBLESHOOTING.md) for a decision tree on common failures.
- Add a cloud provider (Anthropic, MiniMax, GLM) via `memphis provider add <name> --api-key <key>` for cases where Ollama isn't enough.
- Configure Telegram if you want to talk to Memphis from your phone — see `setup-telegram.ts` handler help.

If something doesn't fit this guide — open an issue on GitHub. Memphis is operator-driven; your friction is the real signal.
