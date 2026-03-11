# Release Notes — v0.3.0-beta.3

Release date: 2026-03-11

## Summary
This beta release finalizes the cleanup workflow across reliability, security, performance, and documentation readiness.

## Highlights

### Phase 1 — Critical Bug Fixes (P0)
- Fixed `process.argv` undefined behavior in test environments (resolved 27 failing tests).
- Fixed Vault cache key collision that could cause data corruption.
- Fixed QueryBatcher race condition during concurrent flush operations.
- Fixed backup command routing (`list` / `verify` now route correctly).
- Hardened `--help` handling to avoid accidental destructive actions.

### Phase 2 — Security Hardening
- Added security audit logging to:
  - `/api/decide`
  - `/api/recall`
  - `/v1/vault/*`
- Added global gateway rate limiting: **100 req/min**.

### Phase 3 — Performance Optimizations
- Introduced HNSW graph traversal search path.
- Reduced query latency from **0.533ms → 0.102ms** (~5x faster).
- Reduced embed search from **0.611ms → 0.102ms** (~6x faster).
- Optimized memory RSS from **119MB → 97.4MB** (under 100MB target, ~18% reduction).

### Phase 4 — Documentation Sync
- Added `docs/DEBUG-COMMANDS.md`.
- Added `docs/CLI-COMMAND-MATRIX.md`.
- Added `docs/PERFORMANCE-TUNING.md`.
- Consolidated docs into a single `QUICKSTART.md` flow.

### Phase 5 — Code Quality Improvements
- Consolidated chain routing to the storage handler.
- Improved debug handler consistency.
- Standardized runtime requirement on Node.js **>=20**.

## Quality Gates
- Test status: **307/307 passing (100%)**.
- Added regression tests for all P0 bug fixes.
- Added security coverage tests.
- Added performance benchmark tests.

## Upgrade Notes
- Required runtime: **Node.js >=20**.
- No breaking API changes introduced in this beta increment.
