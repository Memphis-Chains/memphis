# CHANGELOG_v0.1.1.md

Real-deal.

## Scope
Reliability + public-readiness + Blueprint Phase 0 progress after `v0.1.0` baseline.

## Added
- `WORKING-AGREEMENT.md` (quality-first operating rules)
- `ROADMAP-V0.1.1.md` (7-day execution plan)
- `docs/RELEASE-PROCESS.md` (deterministic release flow)
- `docs/BLUEPRINT-GAP-ANALYSIS.md` (target vs current state)
- `ROADMAP-V0.2.0-BLUEPRINT-P0.md` (day-by-day Phase 0 plan)
- Rust workspace bootstrap:
  - root `Cargo.toml`
  - `crates/memphis-core`
  - `crates/memphis-napi`
- Rust core tests:
  - deterministic hash
  - SOUL/genesis/link validation
- NAPI v1 contract and docs:
  - `docs/NAPI-CONTRACT-V1.md`
  - bridge functions: `chain_validate`, `chain_append`, `chain_query`
- TS feature-flag adapter for safe Rust path entry:
  - `RUST_CHAIN_ENABLED` (default OFF)
  - fallback to TS legacy path if bridge unavailable
- RC gate documentation:
  - `docs/V0.2.0-RC-CHECKLIST.md`
- Public-facing polish:
  - `LICENSE` (MIT)
  - README overhaul
  - `docs/SUCCESS-PATH.md`
  - `docs/ARCHITECTURE-MAP.md`
- Repeatable smoke utility:
  - `scripts/rust-napi-smoke.sh`

## Changed
- README now reflects public baseline, roadmap links, quality gate, and contributor entry points.
- CONTRIBUTING now includes complete pre-PR checks and rollback-aware expectations.
- Config schema extended with Rust adapter flags.
- Test fixtures updated to include new config fields.

## Quality evidence
- `cargo test --workspace` PASS
- `npm run lint` PASS
- `npm run typecheck` PASS
- `npm test` PASS
- `npm run build` PASS
- CI checks passed on PR merges

## Notes
- Main branch now follows PR-style workflow (direct pushes can be blocked by repo rules).
- History includes revert/revert-revert around smoke-script PR; final state keeps smoke script present and functional.

## Release intent
`v0.1.1` is a reliability + execution-discipline release preparing safe transition toward Blueprint Phase 1.
