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

## What is already true

- Memphis is much closer to `v1.0.0` runtime safety than this brief's older phase language suggests.
- Matrix remains bounded and optional.
- Rust TUI, OpenClaw dependency growth, provider expansion, and public federation hardening remain out of GA scope.
- The live self-evolution tool names are `memphis_journal`, `memphis_recall`, and `memphis_soul_write`.
- The primary full-runtime path is still source checkout plus bootstrap.

## Remaining blockers that still matter

1. Support-matrix drift:
   - `package.json` engine policy, CI Node version, install script, and several live docs still disagree.
2. Install-path drift:
   - package distribution exists, but the full-runtime operator path is still source checkout.
   - package validation is stronger than before, but install/release/operator docs must say the same thing.
3. CI modernization:
   - GitHub workflows need the current supported action majors and one consistent Node baseline.
4. Docs entrypoint convergence:
   - install and operations docs still contain old version/support claims and stale reinstall language.

## Chosen closure defaults

- Supported Node baseline: `22 LTS`
- Canonical GA operator path: source checkout + bootstrap
- Package artifact: bounded CLI/distribution path, not the primary full-runtime path
- Matrix: trusted pilot only, non-blocking

## Next sprint

The next sprint should be `Release / Install / CI Closure`:

1. Align `package.json`, `scripts/install.sh`, CI workflows, and live docs to the same Node support matrix.
2. Add a non-mutating `install.sh --check-only` contract.
3. Add source-checkout bootstrap smoke and real temp-prefix package-install validation to the release gate.
4. Clean up live install/release/operator docs so they match the actual supported paths.

If this brief becomes stale again, trim or replace it instead of expanding it.
