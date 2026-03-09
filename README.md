Real-deal.

# memphis-v4

Production-first Memphis v4 foundation.

Status:
- Public baseline release: `v0.1.0`
- Current track: BLUEPRINT Phase 0 execution (`ROADMAP-V0.2.0-BLUEPRINT-P0.md`)
- Operating mode: quality-first, no rushed shortcuts
- Execution mode: production-only, local-first, delayed batch release
- Baseline freeze active after `v0.2.0-rc.2`: additive hardening by default (incident/approved-roadmap exceptions)

Primary reference (main):
- `MEMPHIS-V4-CODELINE-BLUEPRINT.md` — canonical architecture/build blueprint

Badges:
- CI quality-gate: ![ci](https://github.com/Memphis-Chains/memphis-v4/actions/workflows/ci.yml/badge.svg)
- Nightly ollama runtime smoke: ![ollama-runtime-smoke](https://github.com/Memphis-Chains/memphis-v4/actions/workflows/ollama-runtime-smoke.yml/badge.svg)

## What this is
`memphis-v4` is the clean codebase line for next-gen Memphis architecture:
- TypeScript shell
- Rust core entry (workspace + core + NAPI bridge)
- Safe migration path via feature-flag fallback

## What works now
- Stable TS runtime with tests
- Rust workspace bootstrap (`memphis-core`, `memphis-napi`, `memphis-embed`)
- NAPI v1 contract + smoke-tested bridge functions
- Embed pipeline increment (`memphis-embed` local deterministic mode + NAPI store/search bridge)
- Chain migration entry command: `chain import_json --file <path>` (dry-run default, transactional write opt-in)
- Deterministic release process and RC checklist

## Quick start
```bash
./scripts/install.sh
npm run dev
```

Manual fallback:
```bash
npm install
cp .env.example .env
npm run build
```

CLI/TUI highlights:
```bash
npx tsx src/infra/cli/index.ts ask --input "hello"
npx tsx src/infra/cli/index.ts ask --input "hello" --tui
npx tsx src/infra/cli/index.ts tui
npx tsx src/infra/cli/index.ts doctor --json
```

## Quality gate (required before push)
```bash
npm run lint
npm run typecheck
npm test         # rust + ts + smoke-test.sh
npm run build:rust
npm run build
```

## Operator one-command pack
```bash
npm run ops:quality-runtime-pack
npm run ops:quality-runtime-pack:json
```
Runs JS gate + Rust tests + runtime smoke summary in one pass (text or JSON).

## Release
Use deterministic flow:
- `docs/RELEASE-PROCESS.md`

## Roadmaps
- `ROADMAP-V0.1.1.md` — reliability/documentation hardening
- `ROADMAP-V0.2.0-BLUEPRINT-P0.md` — Rust/NAPI Phase 0 execution
- `docs/BLUEPRINT-GAP-ANALYSIS.md` — blueprint target vs current state
- `docs/SUCCESS-PATH.md` — staged execution path

## Contributing
- Read: `CONTRIBUTING.md`
- Working mode: `WORKING-AGREEMENT.md`
- Open issues for bugs/features/questions (templates included)

## Key technical docs
- `docs/NAPI-CONTRACT-V1.md`
- `docs/PHASE0-CLOSURE-CRITERIA.md`
- `docs/EMBED-PIPELINE.md`
- `docs/ONBOARDING-INSTALL.md`
- `docs/VAULT-CLI.md`
- `docs/CHAIN-IMPORT-JSON.md`
- `docs/MUST-PASS-SMOKE.md`
- `docs/V0.2.0-RC-CHECKLIST.md`
- `docs/OPERATOR-5MIN-RUNBOOK.md`
- `docs/STATUS-PAGE.md`
- `docs/POST-RELEASE-FREEZE-v0.2.0-rc.2.md`
- `docs/releases/v0.2.0-rc.2.md`

## Security notes
- Never commit secrets.
- Keep `.env` local only.
- Prefer short-lived PAT tokens with minimal scopes.
