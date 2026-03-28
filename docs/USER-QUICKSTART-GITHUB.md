# Memphis Quickstart (GitHub)

This guide gets a new user from zero to a working local Memphis setup.

GitHub Releases and GitHub Packages are the publication channels, but this quickstart remains source-first because it is the supported full-runtime path for local bootstrap, vault setup, and Rust-backed memory.

> One-shot bootstrap: [`scripts/bootstrap.sh`](../scripts/bootstrap.sh)

## Prerequisites

Before you start, make sure you have:

- Linux (Ubuntu/Debian) or macOS
- Git
- Node.js 20+
- npm
- Rust (cargo)

If you do **not** have these yet, run the one-shot installer and it will install what is missing.

## 1) Clone repository

```bash
git clone https://github.com/Memphis-Chains/memphis.git
cd memphis
```

## 2) Bootstrap (recommended)

```bash
./scripts/bootstrap.sh
```

`bootstrap.sh` ensures:

- `.env` exists with generated secrets,
- `MEMPHIS_API_TOKEN` and `MEMPHIS_VAULT_PEPPER` exist,
- `RUST_CHAIN_ENABLED=true` is present,
- embed persistence is enabled,
- a local agent profile exists,
- a user `memphis.service` is installed and enabled when Linux `systemd --user` is available,
- the repo root is initialized as a workspace,
- meaningful first-state creation is deferred to `memphis init`.

Manual fallback (no systemd, no auto-secrets):

```bash
npm install
npm run build
cp .env.example .env
npm run -s cli -- service install   # optional: systemd service
```

## 3) Run controlled first-run

```bash
npm run -s cli -- init
```

`memphis init` is the canonical operator-first path. It enrolls the operator
passphrase, initializes the vault, previews the first chain writes, and records
the first-run result.

## 4) Start Memphis

If bootstrap did not enable the service automatically, use Terminal 1:

```bash
npm run dev
```

Terminal 2:

```bash
npm run -s cli -- tui
```

## 5) Verify it works

```bash
npm run -s cli -- doctor --json
npm run -s cli -- health --json
npm run -s cli -- guide
npm run -s cli -- chat --input "Hello Memphis, respond in one sentence." --provider local-fallback
```

Expected result:

- `doctor` returns JSON with `ok=true`
- `health` reports initialized and healthy runtime state
- `guide` prints the current operator story and supported flows
- `chat` returns an answer with a provider and session metadata

## Common commands

```bash
# Diagnostics
npm run -s cli -- doctor --json
npm run -s cli -- health --json
npm run -s cli -- providers:health --json

# Ask / chat
npm run -s cli -- ask --input "Summarize this setup" --provider local-fallback
npm run -s cli -- ask --session demo --input "Hello" --provider local-fallback
npm run -s cli -- chat --input "What can you do?" --provider local-fallback

# Controlled first-run
npm run -s cli -- init status --json
npm run -s cli -- init --state guided-conversation
```

## Troubleshooting

### 1) `doctor` fails: missing `.env` keys

Symptom:

- `.env required keys` check fails

Fix:

```bash
cp .env.example .env
npm run bootstrap
```

### 2) `Invalid configuration: SHARED_LLM_API_*` error

Symptom:

- CLI exits before running command

Fix:

- For quickstart, use `DEFAULT_PROVIDER=local-fallback`
- Or provide both `SHARED_LLM_API_BASE` and `SHARED_LLM_API_KEY`

### 3) `dist/ directory is missing` in doctor

Symptom:

- Build artifacts check fails

Fix:

```bash
npm run build
```

### 4) `cargo not found` / Rust warning

Symptom:

- Rust check warns/fails in setup scripts

Fix:

- Install Rust via https://rustup.rs
- Restart shell and verify:

```bash
cargo --version
```

### 5) `Permission denied` on `scripts/bootstrap.sh`

Fix:

```bash
chmod +x scripts/bootstrap.sh
./scripts/bootstrap.sh
```

## What you get after install

- Memphis CLI/TUI runtime
- Built-in diagnostics (`doctor`, `health`, provider checks)
- One canonical `bootstrap -> init` operator path
- A source-backed local runtime path that matches the current bootstrap and vault documentation
