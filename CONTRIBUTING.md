# Contributing (Memphis v4)

## Workflow
1. Small, focused changes.
2. Run checks locally:
   - `npm run lint`
   - `npm run typecheck`
   - `npm test`
   - `npm run build`
   - `cargo test --workspace`
3. Open PR with clear scope, risk, and rollback note.

## Rules
- Quality over speed.
- Production-only scope in this repo: changes must improve production readiness, reliability, security, observability, or approved roadmap features.
- No secrets in repo.
- No breaking API changes without versioning.
- Prefer PR-style flow (avoid direct risky pushes).
- Ignore legacy/non-v4 tracks in this repository context.

## Before opening PR
- Link related issue (if exists).
- Update docs/changelog when behavior changes.
- Confirm feature-flag safety for Rust-path changes.
