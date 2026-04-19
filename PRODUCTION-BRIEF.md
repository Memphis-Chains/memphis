# Memphis — Production Closure Brief

> Non-canonical planning note.  
> Canonical product roadmap: `docs/EXECUTION-PLAN.md`

This brief is a short-lived execution note for the post-hardening closure work. It must never outrank the canonical roadmap or architecture docs.

Verified against current repo state on 2026-03-26 after:

- provider and tool-surface convergence
- vault boundary hardening
- rollback/storage alignment
- prompt boundary and output guard hardening
- TypeScript TUI convergence through `6C`
- Matrix trusted-pilot setup hardening
- durable write contract hardening
- hybrid recall (`memphis_recall` + `memphis_search`)
- chain export and remote branch cleanup execution

## What is already true

- Memphis is much closer to `v1.0.0` runtime safety than this brief's older phase language suggests.
- Matrix remains bounded and optional.
- Rust TUI is now being promoted into the `v1.0.0` critical path.
- OpenClaw dependency growth, provider expansion, and public federation hardening remain out of GA scope.
- The live self-evolution tool names are `memphis_journal`, `memphis_recall`, and `memphis_soul_write`.
- The primary full-runtime path is still source checkout plus bootstrap.

## Remaining blockers that still matter

1. Rust-native primary TUI:
   - the old TypeScript TUI is no longer the release target.
   - `memphis tui` must become the Rust console, not a preview side path.
   - `memphis-operator` is now the live native operator boundary for non-chat Rust TUI screens on `main`.
   - the remaining blocker is native operator chat parity on top of that seam, not more HTTP bootstrap work.
2. Final prompt-injection / untrusted-content hardening:
   - current guards are strong, but indirect injection and poisoned-content tests still need the final pass.
3. RC shakeout on a fresh host or clean environment:
   - prove the source-first operator path outside the current dev checkout.
4. Final entrypoint docs cleanup:
   - trim any remaining stale install/runbook language that survived the main closure work.

## Chosen closure defaults

- Supported Node baseline: `22 LTS`
- Canonical GA operator path: source checkout + bootstrap
- Package artifact: bounded CLI/distribution path, not the primary full-runtime path
- Matrix: trusted pilot only, non-blocking
- TUI: Rust-only for the release path; TypeScript TUI becomes migration source, not fallback truth

## Next sprint

The next sprint should be `Rust Operator Boundary + Native Rust TUI Parity`:

1. Rebase the roadmap around a Rust-native operator seam for the Rust console.
2. Extend `memphis-operator` from native non-chat parity into full native operator parity.
3. Land native chat parity for the Rust console instead of accepting a TypeScript/HTTP fallback.
4. Follow with prompt-injection hardening and RC shakeout after the real Rust operator path exists.

If this brief becomes stale again, trim or replace it instead of expanding it.
