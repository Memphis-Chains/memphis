# Memphis v4 — Production Operator Notes

This document keeps the production-first execution context that was previously front-loaded in README.

## Execution mode
- production-only
- quality-first
- local-first
- merge on green gates

## Core references
- `MEMPHIS-V4-CODELINE-BLUEPRINT.md`
- `ROADMAP-V0.2.0-BLUEPRINT-P0.md`
- `docs/BLUEPRINT-COMPLIANCE-MATRIX.md`
- `docs/CLOSURE-STATUS-LATEST.md`
- `docs/NATIVE-CLOSURE-SNAPSHOT.md`

## Must-pass checks
```bash
npm run -s ops:native-closure-check
npm run -s ops:phase8-ledger-status
```

## Release discipline
- Use `docs/RELEASE-PROCESS.md`
- Keep package/release versions aligned
- Prefer batched value releases with evidence docs
