# Archived docs — 2026-04-14 post-roadmap cleanup

These documents are preserved for historical reference but are no longer
part of the active documentation set. The 14-sprint roadmap (V5 → V14)
is fully shipped; the items below describe state that has since moved
into the code or been superseded by a current doc.

## What was archived

### Release / ship-readiness snapshots

Frozen in time; the current release process is documented in
`docs/RELEASE-PROCESS.md`.

- `BIG-PACK-ASSEMBLY-PLAN.md`, `BIG-PACK-CHANGELOG-DRAFT.md`
- `FINAL-CLOSURE-SNAPSHOT.md`, `NATIVE-CLOSURE-SNAPSHOT.md`
- `FIRST-RUN-STOP-SHIP.md`, `GO-LIVE-CHECKLIST-V1.md`
- `POST-RELEASE-FREEZE-v0.2.0-rc.2.md`, `V0.2.0-RC-CHECKLIST.md`
- `PUBLISH-STATUS.md`

### Planning docs for work that is now merged

The plans are history; the features they described are in the code.

- `DEVELOPMENT-PHASES.md`, `EXECUTION-PLAN.md`
- `ROADMAP-CURRENT.md`, `ROADMAP-FULL-SPRINT3-TO-M8.md`
- `TODO.md`, `TUI-REFACTOR-PLAN.md`, `VAULT-PHASE1-PLAN.md`
- `VISION-REFACTOR-2026-03-10.md`, `WEB-SEARCH-v1.2.0-DESIGN.md`
- `RUST-CHAIN-SIGNING-ROLLOUT.md`, `PR-NOTES-VAULT-PHASE1.md`
- `COGNITIVE-MODELS-STATUS.md`

### Deployment-specific reports (not reusable)

Each describes a one-off host state; future deployments should not
use these as runbooks.

- `MEMPHIS-PC-ZONA-DEPLOYMENT-REPORT-2026-03-11.md`
- `PC-ZONA-FIX-INSTRUCTIONS.md`
- `HOTEL-DEPLOYMENT-REFERENCE.md`
- `PRODUCTION-INSTALLATION-FIXES.md`
- `OPS-RUNBOOK-S2.4.md`

### Evidence / validation artifacts

Captured at the time of a specific PR or external run; no longer
authoritative.

- `V3-PACK-2-1-3-EVIDENCE.md`, `V3-PACK-3-1-3-EVIDENCE.md`, `V3-PACK-4-1-3-EVIDENCE.md`
- `NEXT-PACK-3PR-EVIDENCE.md`
- `MULTI-NODE-TRANSPORT-EVIDENCE.md`
- `EXTERNAL-INSTALL-EVIDENCE-FRAMEWORK.md`, `EXTERNAL-VALIDATION-RESULTS.md`
- `RECOVERY-DRILLS-2026-03-09.md`
- `TEST-REPORT-2026-03-11.md`
- `SNYK-SCAN-RESULTS.md`
- `RETRIEVAL-BENCHMARK.md`

### Status snapshots / point-in-time state

Moved to archive because "current" is more useful than "as of date X".

- `PROJECT-STATUS.md` → superseded by the commit log and
  `docs/ROADMAP-CURRENT.md` (also archived now that the roadmap
  is complete).
- `STATUS-PAGE.md`
- `RUNTIME-ISSUES-2026-04-09.md`
- `PROCESS-HISTORY-2026-03.md`
- `SUCCESS-PATH.md`
- `DOCS-CONSISTENCY-MATRIX.md` — snapshot-only; the actual audit
  runs in CI now.

## Current documentation entry points

- `docs/operator-handbook.md` — single-page operator workflow by time horizon
- `docs/CANONICAL-ARCHITECTURE.md` — current architecture overview
- `docs/RELEASE-PROCESS.md` — how we cut releases today
- `docs/slo-baseline.md` — current SLO targets
- `README.md` — links to all current docs
