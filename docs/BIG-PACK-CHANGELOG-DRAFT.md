# BIG-PACK-CHANGELOG-DRAFT.md

Status: draft (pre-release)

## Scope
Consolidated local-first hardening and release-prep pack.

## Planned sections

### 1) Ops / quality runtime pack
- add one-command operator gate: `npm run ops:quality-runtime-pack`
- bundle JS gate + Rust tests + runtime smoke summary
- improve non-login shell compatibility for cargo path

### 2) Canonical docs alignment
- enforce production-only + local-first wording consistency
- align README/WORKING-AGREEMENT/roadmap references
- add docs consistency matrix for auditability

### 3) Big Pack release discipline
- define batch boundaries (IN/OUT)
- add entry/exit checklists for PR/merge
- add known pitfalls and rollback guidance

## Known limits (draft)
- no publish/tag yet (approval window pending)
- some advanced runtime policy items remain queued

## Rollback hint
- revert by thematic commit group (ops/docs/planning)
- rerun `npm run ops:quality-runtime-pack` after rollback
