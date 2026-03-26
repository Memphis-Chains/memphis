# Memphis — Production Closure Brief
> Non-canonical planning note.  
> Canonical product roadmap: `docs/EXECUTION-PLAN.md`

This brief is a short-lived execution note for the post-hardening closure work. It must never outrank the canonical roadmap or architecture docs.

Verified against current repo state on 2026-03-26 after:

- provider and tool-surface convergence
- vault boundary hardening
- rollback/storage alignment
- prompt boundary and output guard hardening
- TUI `6B` and `6C`
- Matrix trusted-pilot setup hardening
- durable write contract hardening
- hybrid recall (`memphis_recall` + `memphis_search`)
- chain export and remote branch cleanup execution

## What is already true

- Memphis is much closer to `v1.0.0` runtime safety than this brief's older phase language suggests.
- Matrix remains bounded and optional.
- Rust TUI, OpenClaw dependency growth, provider expansion, and public federation hardening remain out of GA scope.
- The live self-evolution tool names are `memphis_journal`, `memphis_recall`, and `memphis_soul_write`.
- The primary full-runtime path is still source checkout plus bootstrap.

## Remaining blockers that still matter

1. RC shakeout on a fresh host or clean environment:
   - prove the source-first operator path outside the current dev checkout.
2. Final entrypoint docs cleanup:
   - trim any remaining stale install/runbook language that survived the main closure work.
3. Final `v1.0.0` scope call on non-critical extras:
   - keep or defer anything still marked planned but not required for the release candidate.

## Chosen closure defaults

- Supported Node baseline: `22 LTS`
- Canonical GA operator path: source checkout + bootstrap
- Package artifact: bounded CLI/distribution path, not the primary full-runtime path
- Matrix: trusted pilot only, non-blocking

## Next sprint

The next sprint should be `RC Shakeout + Final Docs Closure`:

1. Run a fresh-host or clean-env release-candidate drill.
2. Clean the last live entrypoint docs that still drift from shipped behavior.
3. Prepare the repo for tag/release readiness, not for another architecture refactor.

If this brief becomes stale again, trim or replace it instead of expanding it.
