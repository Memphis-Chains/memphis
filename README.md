Real-deal.

# memphis-v4

Production-first Memphis v4 foundation.

Status:
- Public baseline release: `v0.1.0`
- Current track: BLUEPRINT Phase 0 execution (`ROADMAP-V0.2.0-BLUEPRINT-P0.md`)
- Operating mode: quality-first, no rushed shortcuts

## What this is
`memphis-v4` is the clean codebase line for next-gen Memphis architecture:
- TypeScript shell
- Rust core entry (workspace + core + NAPI bridge)
- Safe migration path via feature-flag fallback

## What works now
- Stable TS runtime with tests
- Rust workspace bootstrap (`memphis-core`, `memphis-napi`)
- NAPI v1 contract + smoke-tested bridge functions
- Deterministic release process and RC checklist

## Quick start
```bash
npm install
cp .env.example .env
npm run dev
```

## Quality gate (required before push)
```bash
npm run lint
npm run typecheck
npm test
npm run build
cargo test --workspace
```

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
- `docs/V0.2.0-RC-CHECKLIST.md`

## Security notes
- Never commit secrets.
- Keep `.env` local only.
- Prefer short-lived PAT tokens with minimal scopes.
