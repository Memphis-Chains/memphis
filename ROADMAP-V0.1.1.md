# ROADMAP-V0.1.1.md — 7-day execution plan

Real-deal.

## Objective
Ship `v0.1.1` as a reliability increment with strict quality gates and zero rushed changes.

## P0 (must)

### P0-1: CI signal hardening
**Goal:** make local checks and release expectations explicit.
- [x] Add a short "CI/Quality Gate" section to README
- [x] Verify `lint`, `typecheck`, `test`, `build` commands are consistent
- [x] Ensure workflow docs match actual commands

**DoD:**
- README has exact copy-paste quality gate block
- local run passes end-to-end

---

### P0-2: Release process codification
**Goal:** make future releases predictable.
- [x] Add `docs/RELEASE-PROCESS.md`
- [x] Include steps: change -> test -> tag -> release -> verification
- [x] Include PAT note for workflow-scope edge case

**DoD:**
- single deterministic release checklist exists and is tested once

---

### P0-3: Blueprint alignment planning (Phase 0 prep)
**Goal:** prepare Rust/NAPI entry without rushed coding.
- [x] Create `docs/BLUEPRINT-GAP-ANALYSIS.md`
- [x] Map current state vs required Phase 0 items (`crates/*`, napi bridge, tests)
- [x] Define first safe implementation slice (no big-bang refactor)

**DoD:**
- clear gap table with owner/order/risk/rollback
- first slice approved for `v0.2.0` start

## P1 (should)

### P1-1: Repo hygiene polish
- [ ] Add `WORKING-AGREEMENT.md` reference in README
- [ ] Add short CONTRIBUTING note: PR-style flow, no fastest-path merges

**DoD:** onboarding docs are self-consistent.

## Release target
- Candidate tag: `v0.1.1`
- Type: reliability/documentation/process hardening
- Non-goal: full Rust core implementation in this release

## Risk policy
- If any gate fails, release is postponed.
- No partial release under pressure.
