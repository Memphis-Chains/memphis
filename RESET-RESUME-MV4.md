# RESET-RESUME-MV4.md

Updated: 2026-03-10 10:24 CET

## Repo anchor
- Path: `/home/memphis_ai_brain_on_chain/memphis-v4`
- Branch: `main`
- Upstream anchor: `db67d9d`
- Local checkpoint commit: `7a3f9e2` (`test(phase6): add native MCP lifecycle and proof smoke scripts`)
- Status: local ahead `1` vs `origin/main`

## Closure state (execution truth)
- V4-H4.1: DONE
- V4-H4.2: DONE
- V4-H4.3: DONE
- Next: V4-H4.4 `/exec` hardening pack

## Must-pass checks (latest)
- `npm run -s ops:native-closure-check` → PASS
- `npm run -s ops:phase8-ledger-status` → PASS

## What was persisted now
- Added smoke scripts (phase6 lifecycle/proof paths):
  - `scripts/smoke-phase6-native-mcp-serve-single-instance.sh`
  - `scripts/smoke-phase6-native-mcp-serve-stale-state.sh`
  - `scripts/smoke-phase6-native-mcp-proof-positive.sh`
  - `scripts/smoke-phase6-native-mcp-proof-negative.sh`
  - `scripts/smoke-phase6-native-mcp-instance-negative.sh`
  - `scripts/smoke-phase6-native-mcp-proof-artifact.sh`
- Updated status docs:
  - `docs/CLOSURE-STATUS-LATEST.md`
  - `docs/NATIVE-CLOSURE-SNAPSHOT.md`
  - `docs/BLUEPRINT-COMPLIANCE-MATRIX.md`

## Open work
1. H4.4 Gateway `/exec` hardening (allowlist/restricted-mode + smoke + docs)
2. Final Phase8 multi-node production-style proof

## Notes
- Do not commit local secrets/runtime artifacts (`.env`, `data/*.jsonl`, `.bak`).
- Work in 3 commits + 1 PR packs, merge only on green.
