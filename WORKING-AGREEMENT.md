# WORKING-AGREEMENT.md — memphis-v4

Real-deal.

## Purpose
Operational rules for safe, repeatable, production-grade work on `memphis-v4`.

## Non-negotiables
1. **Pro over fast** — we optimize for quality and reliability, never for the fastest path.
2. **Single source of truth** — work only in:
   - `/home/memphis_ai_brain_on_chain/memphis-v4`
3. **Production-only execution mode** — this repo/environment is for production delivery and hardening only (no side experiments, no legacy track work, no playground changes).
4. **No direct chaos on main** — prefer PR-style flow even when technical enforcement is limited.
5. **Test before push** — no push without minimal verification.

## Standard change flow
1. `git status` + `git remote -v`
2. Implement one scoped change
3. Run quality gate:
   - preferred: `npm run ops:quality-runtime-pack`
   - minimum fallback:
     - `npm run lint`
     - `npm run typecheck`
     - `npm test`
     - (if relevant) `npm run build`
4. Commit with clear message
5. Push to remote
6. Arm auto-merge (CLI): `./scripts/pr-enable-automerge.sh`
7. Update changelog/docs if behavior changed

## Release discipline
- Tag format: `vX.Y.Z`
- Release notes must include:
  - scope,
  - what changed,
  - known limits,
  - rollback hint.

## Baseline freeze policy (after `v0.2.0-rc.2`)
- Default mode: **additive hardening only** (docs, runbooks, alert quality, observability, reliability tweaks).
- No broad architectural pivots unless one of these is true:
  1. active production incident,
  2. explicit operator-approved roadmap step.
- For non-incident changes, prefer smallest safe PR slices.
- If an incident occurs, fix-forward is allowed with post-incident note.

## Auth policy (this host)
- Preferred push path: **HTTPS + PAT**.
- PAT scopes:
  - `repo`
  - `workflow` (only if `.github/workflows/*` is touched)
- Use short-lived PATs with rotation.

## Session handoff
At end of each major session:
- write achievements to `memory/YYYY-MM-DD.md`
- keep long-term decisions in `MEMORY.md`
- include next-step checklist.
