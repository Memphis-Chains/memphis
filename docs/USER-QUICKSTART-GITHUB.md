# Memphis v4 — User Quickstart (GitHub)

This guide gets a new user from zero to a working local Memphis setup.

> One-shot installer: [`scripts/install.sh`](../scripts/install.sh)

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
git clone https://github.com/Memphis-Chains/memphis-v4.git
cd memphis-v4
```

## 2) Install dependencies

Recommended (automatic bootstrap):

```bash
./scripts/install.sh
```

Manual fallback:

```bash
npm install
cp .env.example .env
```

## 3) Configure `.env` (required)

The app reads `.env` at startup. At minimum, set values required by `doctor`:

```dotenv
# required for doctor required checks
DEFAULT_PROVIDER=local-fallback
DATABASE_URL=file:./data/memphis-v4.db
MEMPHIS_VAULT_PEPPER=memphis-dev-pepper-2026

# for local-first quickstart, keep this enabled
LOCAL_FALLBACK_ENABLED=true
```

Notes:

- `.env.example` contains all available variables.
- If you want `shared-llm`, you must also set `SHARED_LLM_API_BASE` and `SHARED_LLM_API_KEY`.

## 4) Build

```bash
npm run build
```

## 5) Verify it works (quick test)

Run these commands in order:

```bash
# 1) required environment + build checks
npm run -s cli -- doctor --json

# 2) basic runtime health endpoint payload
npm run -s cli -- health --json

# 3) local ask path
npm run -s cli -- ask --input "Hello Memphis, respond in one sentence." --provider local-fallback
```

Expected result:

- `doctor` returns JSON with `"ok": true`
- `health` prints `"status": "ok"`
- `ask` returns an answer with an `id` and `provider`

Optional TUI mode:

```bash
npm run -s cli -- tui
```

## Common commands

```bash
# Diagnostics
npm run -s cli -- doctor --json
npm run -s cli -- health --json
npm run -s cli -- providers:health --json

# Ask / chat
npm run -s cli -- ask --input "Summarize this setup" --provider local-fallback
npm run -s cli -- chat --input "What can you do?" --provider local-fallback

# Onboarding assistant
npm run -s cli -- onboarding wizard --json
npm run -s cli -- onboarding wizard --write --profile dev-local --out .env --force
```

## Troubleshooting

### 1) `doctor` fails: missing `.env` keys

Symptom:

- `.env required keys` check fails

Fix:

```bash
cp .env.example .env
# then set at least: DEFAULT_PROVIDER, DATABASE_URL, MEMPHIS_VAULT_PEPPER
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

### 5) `Permission denied` on `scripts/install.sh`

Fix:

```bash
chmod +x scripts/install.sh
./scripts/install.sh
```

## What you get after install

- Memphis v4 CLI/TUI runtime
- Built-in diagnostics (`doctor`, `health`, provider checks)
- Onboarding wizard profiles for local and production paths
