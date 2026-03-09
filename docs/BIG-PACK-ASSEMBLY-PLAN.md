# BIG-PACK-ASSEMBLY-PLAN.md

Mode: local-first preparation, delayed release.

## Objective
Prepare one consolidated, high-signal release pack after meaningful value bundle is complete.

## Commit groups (proposed)
1. **ops/scripts**
   - `scripts/local-quality-runtime-pack.sh`
   - `package.json` script alias
2. **docs/canonical-alignment**
   - README, WORKING-AGREEMENT consistency updates
   - docs consistency matrix
3. **planning/queue**
   - `LOCAL-BIG-PACK-QUEUE.md`
   - release-pack planning docs

## Pre-PR gate (must pass)
- `npm run ops:quality-runtime-pack`
- `git status --short` reviewed
- docs links verified

## PR template checklist
- [ ] Scope is additive hardening/docs/ops only
- [ ] No legacy path changes
- [ ] Rollback is simple (`git revert` group)
- [ ] Risks + known limits listed

## Release decision gate
Release only if:
- quality/runtime checks green,
- docs coherent,
- batch value is meaningful,
- user confirms publish window.
