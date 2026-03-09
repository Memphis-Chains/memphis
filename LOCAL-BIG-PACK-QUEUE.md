# LOCAL-BIG-PACK-QUEUE.md

Mode: local-first execution, delayed batch release.
Canonical repo: `/home/memphis_ai_brain_on_chain/memphis-v4`

## Status legend
- [ ] ready
- [~] in-progress
- [x] done
- [!] blocked

## P0 (now)
- [x] P0.1 Single source-of-truth cleanup
  - Canonical: `/home/memphis_ai_brain_on_chain/memphis-v4`
  - Archived duplicate workspace copy to `_archive_notes/memphis-v4-archival-20260309-1123`
- [x] P0.2 Main reference alignment (local)
  - Added `MEMPHIS-V4-CODELINE-BLUEPRINT.md`
  - README updated with primary reference pointer
- [x] P0.3 Queue board created
  - This file is the working local pack queue

## P1 (next)
- [x] P1.1 Hardening smoke bundle
  - Create single operator script for JS+Rust quality gate + runtime smoke summary
- [x] P1.2 Docs consistency sweep
  - Align README/ROADMAP/WORKING-AGREEMENT with canonical references
- [x] P1.3 Batch pack assembly
  - Prepare grouped commit plan + change-log draft for one larger publish pack

## Progress Log
- 2026-03-09 12:04 CET — P1.1 DONE: created `scripts/local-quality-runtime-pack.sh` as one-command operator quality/runtime bundle; final run PASS after cargo env bootstrap fix.
- 2026-03-09 12:12 CET — P1.2 DONE: docs consistency sweep completed across README/WORKING-AGREEMENT/release docs; canonical anchors unified.
- 2026-03-09 12:12 CET — P1.3 DONE: batch assembly artifacts added (`docs/BIG-PACK-ASSEMBLY-PLAN.md`, `docs/BIG-PACK-CHANGELOG-DRAFT.md`) with commit grouping + release gate criteria.

## Notes
- No release now (per directive).
- Work locally, validate thoroughly, publish later as one larger value pack.
