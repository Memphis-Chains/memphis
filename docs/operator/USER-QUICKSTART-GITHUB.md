# Memphis Quickstart (GitHub)

This guide gets a new operator from zero to a working local Memphis setup using
the supported source-first runtime path.

GitHub Releases and GitHub Packages are publication channels, but this
quickstart remains source-first because it is the supported full-runtime path
for local bootstrap, vault setup, and Rust-backed memory.

## Prerequisites

Before you start, make sure you have:

- Linux x64 (Ubuntu 22.04+ or WSL2 Ubuntu)
- git
- Node.js 22+
- npm
- Rust stable

If you do not have these yet, use [INSTALLATION.md](./INSTALLATION.md) first.

## 1) Clone the repository

```bash
git clone https://github.com/Memphis-Chains/memphis.git
cd memphis
```

## 2) Bootstrap

```bash
npm run bootstrap
```

`bootstrap` ensures:

- `.env` exists with generated secrets
- `MEMPHIS_API_TOKEN` and `MEMPHIS_VAULT_PEPPER` exist
- `RUST_CHAIN_ENABLED=true` is present
- embed persistence is enabled
- a local agent profile exists
- a user `memphis.service` is installed when Linux `systemd --user` is available
- meaningful first-state creation is deferred to `memphis init`

If you prefer the underlying script directly, `npm run bootstrap` maps to the
same repo bootstrap flow.

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

If `systemd --user` is available and you want a background runtime:

```bash
npm run -s cli -- service install
npm run -s cli -- service restart
```

## 5) Verify it works

```bash
npm run -s cli -- init status --json
npm run -s cli -- doctor --json
npm run -s cli -- health --json
npm run -s cli -- guide
npm run -s cli -- chat --input "Hello Memphis, respond in one sentence." --provider local-fallback
```

Expected result:

- `init status` shows first-run is complete
- `doctor` returns JSON with `ok=true` on a healthy configured machine
- `health` reports initialized and healthy runtime state
- `guide` prints the current operator story and supported flows
- `chat` returns an answer with provider and session metadata

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

### `doctor` fails: missing `.env` keys

```bash
cp .env.example .env
npm run bootstrap
```

### `dist/` is missing in doctor

```bash
npm run build
```

### `cargo` not found

- install Rust via https://rustup.rs
- reopen the shell
- verify with `cargo --version`

### `Permission denied` on bootstrap

```bash
chmod +x scripts/bootstrap.sh
npm run bootstrap
```

## What you get after install

- Memphis CLI and Rust TUI runtime
- built-in diagnostics (`doctor`, `health`, provider checks)
- one canonical `bootstrap -> init` operator path
- a source-backed local runtime path that matches current vault and memory docs
