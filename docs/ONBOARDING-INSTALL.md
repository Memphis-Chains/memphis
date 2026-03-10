# Onboarding / Install Path

## Prerequisites

- OS: Ubuntu/Debian or macOS
- Git
- Node.js 20+
- npm
- Rust toolchain (`cargo`)
- Write access to project `data/` and `dist/` directories

If any prerequisite is missing, use the bootstrap installer below.

## Bootstrap (recommended)

Run the one-shot installer:

```bash
./scripts/install.sh
```

Script: [`scripts/install.sh`](../scripts/install.sh)

What it does:
- detects OS (Ubuntu/Debian/macOS)
- installs required system/tooling deps (build tools, Node.js 20+, Rust via rustup)
- clones repo if needed (or uses existing checkout)
- runs `npm install`
- creates `.env` from `.env.example` (if missing)
- builds TS + Rust path
- runs final `doctor --json` baseline

## Manual install

```bash
npm install
cp .env.example .env
npm run build
```

Set minimum required env values (matches `.env.example` keys used by required doctor checks):

```dotenv
DEFAULT_PROVIDER=local-fallback
DATABASE_URL=file:./data/memphis-v4.db
MEMPHIS_VAULT_PEPPER=memphis-dev-pepper-2026
LOCAL_FALLBACK_ENABLED=true
```

## Preflight doctor

```bash
npm run -s cli -- doctor --json
```

Checks include:
- Rust version (warn if < 1.70)
- Node version (warn if < 20)
- write permissions for `data/` and `dist/`
- `.env` presence + required keys (`MEMPHIS_VAULT_PEPPER`, `DATABASE_URL`, `DEFAULT_PROVIDER`)
- build artifacts (`dist/` exists and is populated)
- embedding endpoint reachability (optional warning)
- MCP service reachability on configured port (optional warning)

Output modes:
- default: human-readable with `✓ / ✗ / ⚠`
- `--json`: structured check list for scripting
- exit code: `0` when all required checks pass, otherwise `1`

## Guided wizard

```bash
# checklist/progress
npm run -s cli -- onboarding wizard --json

# generate profile into .env (non-interactive)
npm run -s cli -- onboarding wizard --write --profile dev-local --out .env --force

# interactive first-run wizard
npm run -s cli -- onboarding wizard --interactive
```

Profiles:
- `dev-local` (safe default local mode)
- `prod-shared` (production + shared provider)
- `prod-decentralized` (production + decentralized provider)
- `ollama-local` (local ollama embeddings flow)

Checklist output shows setup progress (env file, rust bridge, vault pepper, provider choice, embed mode).

## Verify it works

Run this sequence after install/onboarding:

```bash
npm run -s cli -- doctor --json
npm run -s cli -- health --json
npm run -s cli -- ask --input "Onboarding verification" --provider local-fallback
```

## Troubleshooting

### 1) `.env required keys` fails in doctor

- Ensure `.env` exists (`cp .env.example .env`)
- Set `DEFAULT_PROVIDER`, `DATABASE_URL`, `MEMPHIS_VAULT_PEPPER`

### 2) `SHARED_LLM_API_BASE` / `SHARED_LLM_API_KEY` required

- Happens when `DEFAULT_PROVIDER=shared-llm`
- For local onboarding, set `DEFAULT_PROVIDER=local-fallback`
- Or configure both shared LLM variables

### 3) `dist/` missing or empty

```bash
npm run build
```

### 4) Permission check fails for `data/` or `dist/`

```bash
chmod -R u+rw data dist
```

### 5) Installer cannot execute

```bash
chmod +x scripts/install.sh
./scripts/install.sh
```

## Fresh setup smoke

```bash
npm run smoke:onboarding-doctor
```

This validates that a fresh `.env` baseline can pass doctor without manual edits.

## H3.3 rollback

If onboarding changes must be rolled back:

1. remove generated `.env` (if created by install script): `rm -f .env`
2. restore previous script versions from git: `git checkout -- scripts/install.sh scripts/smoke-bootstrap-doctor.sh`
3. rerun manual install path and doctor
