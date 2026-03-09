# Onboarding / Install Path

## Bootstrap (recommended)

```bash
./scripts/install.sh
```

What it does:
- validates `node`, `npm`, `cargo`
- runs `npm install`
- creates `.env` from `.env.example` (if missing)
- builds TS + Rust path
- runs `doctor --json` baseline

## Manual install

```bash
npm install
cp .env.example .env
npm run build
```

## Preflight doctor

```bash
npx tsx src/infra/cli/index.ts doctor --json
```

Checks include:
- Node runtime version
- npm availability
- cargo availability
- `.env` presence
- rust bridge enable flag (`RUST_CHAIN_ENABLED`)
- rust bridge path + existence
- embed API availability from bridge
- vault pepper configured (`MEMPHIS_VAULT_PEPPER` len >= 12)

## Guided wizard

```bash
# checklist/progress
npx tsx src/infra/cli/index.ts onboarding wizard --json

# generate profile into .env (non-interactive)
npx tsx src/infra/cli/index.ts onboarding wizard --write --profile dev-local --out .env --force

# interactive first-run wizard
npx tsx src/infra/cli/index.ts onboarding wizard --interactive
```

Profiles:
- `dev-local` (safe default local mode)
- `prod-shared` (production + shared provider)
- `prod-decentralized` (production + decentralized provider)
- `ollama-local` (local ollama embeddings flow)

Checklist output shows setup progress (env file, rust bridge, vault pepper, provider choice, embed mode).

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
