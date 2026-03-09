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
   - `npm run lint`
   - `npm run typecheck`
   - `npm test`
   - (if relevant) `npm run build`
4. Commit with clear message
5. Push to remote
6. Update changelog/docs if behavior changed

## Release discipline
- Tag format: `vX.Y.Z`
- Release notes must include:
  - scope,
  - what changed,
  - known limits,
  - rollback hint.

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
