# RELEASE-PROCESS.md — memphis-v4

Real-deal.

## Goal
Deterministic release flow with clear gates, rollback-ready discipline, and batch-oriented publish cadence.

## Canonical anchors
- Source-of-truth repo: `/home/memphis_ai_brain_on_chain/memphis-v4`
- Primary architecture reference: `MEMPHIS-V4-CODELINE-BLUEPRINT.md`
- Working mode: production-only, quality-first, local-first with delayed larger release packs

## Big Pack policy
- Default cadence: frequent local work, less frequent **value-based Big Pack** release.
- Do **not** publish every small increment.
- Publish only when grouped changes create meaningful operator/product value.

## Batch boundaries (what goes in / out)
### IN (preferred)
- additive hardening
- docs/runbook consistency
- ops scripts and safety checks
- reliability fixes with clear rollback path

### OUT (for this mode)
- legacy-track changes
- playground/experimental refactors
- broad architectural pivots without approved roadmap step

## Entry checklist (before preparing PR)
- [ ] `git status --short` reviewed
- [ ] scope matches Big Pack boundaries (IN/OUT)
- [ ] docs references coherent (`README`, `WORKING-AGREEMENT`, roadmap docs)
- [ ] rollback path is simple (`git revert` possible by commit group)

## 1) Quality gate (must-pass before PR)
Preferred one-command gate:
```bash
npm run ops:quality-runtime-pack
```

Fallback explicit gate:
```bash
npm run lint
npm run typecheck
npm test
npm run build
cargo test --workspace
./scripts/smoke-ollama-bridge-runtime.sh
```

If any step fails: **stop release path**.

## 2) Prepare batch commits (thematic)
Recommended groups:
1. ops/scripts
2. docs/canonical-alignment
3. planning/release-prep

```bash
git add <group-files>
git commit -m "<scope>: <group summary>"
```

## 3) Open PR (Big Pack, no tag yet)
- push branch
- open PR with:
  - scope
  - what changed
  - known limits
  - rollback hint
  - risk notes

## 4) Exit checklist (before merge)
- [ ] PR checks green
- [ ] must-pass smoke confirmed
- [ ] status/artefacts updated (roadmap/progress docs)
- [ ] no unresolved blocker in release notes

## 5) Merge to main (still no tag if publish window not approved)
- merge PR after checks
- sync local main to origin/main
- rerun quick verification

## 6) Publish step (only when approved)
### Tag
```bash
git tag -a vX.Y.Z -m "release: vX.Y.Z"
git push origin vX.Y.Z
```

### GitHub release
- repository: `https://github.com/Memphis-Chains/memphis-v4`
- include: scope, change summary, known limits, rollback hint

## 7) Post-release verification
```bash
git fetch --tags
git tag -l | grep vX.Y.Z
```
Verify release page and attached notes/assets.

## Known pitfalls
- Non-login shell may miss rustup path (`cargo` unavailable) → load `~/.cargo/env`.
- Vault runtime policy can block requests if `MEMPHIS_API_TOKEN` env collides with test path (401 edge case).
- Workflow changes may require PAT scope `workflow` in addition to `repo`.

## PAT note (HTTPS flow)
On this host, stable push path is HTTPS + PAT.
If release touches `.github/workflows/*`, PAT must include:
- `repo`
- `workflow`

## Rollback hint
If release is broken:
1. Identify last known-good tag
2. Communicate rollback intent
3. Revert by thematic commit group or hotfix branch
4. Re-release with explicit incident note
