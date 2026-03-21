# Memphis Quickstart (GitHub)

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
git clone https://github.com/Memphis-Chains/memphis.git
cd memphis
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

## 3) Bootstrap the runtime

```bash
npm run bootstrap
```

Bootstrap ensures:

- `.env` exists,
- `MEMPHIS_API_TOKEN` and `MEMPHIS_VAULT_PEPPER` exist,
- embed persistence is enabled,
- a local agent profile exists,
- the repo root is initialized as a workspace.

## 4) Start Memphis

Terminal 1:

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
npm run -s cli -- guide
npm run -s cli -- chat --input "Hello Memphis, respond in one sentence." --provider local-fallback
```

Expected result:

- `doctor` returns JSON with `ok=true`
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

### 5) `Permission denied` on `scripts/install.sh`

Fix:

```bash
chmod +x scripts/install.sh
./scripts/install.sh
```

## What you get after install

- Memphis CLI/TUI runtime
- Built-in diagnostics (`doctor`, `health`, provider checks)
- Onboarding wizard profiles for local and production paths
