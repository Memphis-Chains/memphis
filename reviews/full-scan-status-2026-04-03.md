# Full Scan Status - 2026-04-03

## Current Shipped Truth

- Repository: `Memphis-Chains/memphis`
- `main` HEAD at scan time: `b739b7f1b8a73174948e3c0ab925c4dece3826e5`
- Latest published release: `v1.2.1`
- Release URL: `https://github.com/Memphis-Chains/memphis/releases/tag/v1.2.1`
- Package version in `package.json`: `1.2.1`
- Latest confirmed GitHub Actions `ci` pass for `main` at scan time:
  - Run: `https://github.com/Memphis-Chains/memphis/actions/runs/23922600010`
  - Result: `success`

Memphis is currently a shipped `v1.2.1` local-first runtime with:

- converged CLI, HTTP, MCP, gateway, and Rust TUI runtime paths,
- worker/session dispatch lane,
- session memory extraction and additive conversation compaction,
- surface-policy hardening and graceful degradation,
- active Rust-native operator console with token/context telemetry.

## Canonical Vs Historical Planning Files

### Canonical product and release truth

- `README.md`
- `docs/PROJECT-STATUS.md`
- `docs/ROADMAP-CURRENT.md`
- `docs/EXECUTION-PLAN.md`
- `docs/RELEASE-PROCESS.md`
- `docs/RELEASE-CHECKLIST.md`
- `docs/MUST-PASS-SMOKE.md`

These are the files that should define current product posture, release truth, and operator expectations.

### Historical or superseded planning files

- `SPRINT_STATUS.md`
- `ROADMAP-MASTER-QUEUE.md`
- `ROADMAP.md`
- `memory/next-tasks-2026-03-27.md`
- `notes/ATTACK-PLAN.md`

These still contain useful history, but they must not be treated as current prioritization or current runtime truth.

### Research notes that remain useful

- `notes/MEMPHIS-MASTER-PLAN.md`
- `notes/TOOLS-INTEGRATION-PLAN.md`
- `reviews/full-code-review-2026-04-01.md`

These remain useful because they explain why major runtime and adoption work existed, but they now need interpretation against the shipped `v1.2.1` baseline.

## GitHub Issue Audit

### Stale-open issues already reconciled in this pass

The following issues were stale-open at scan time and were closed during this reconciliation pass because the codebase and shipped `v1.2.x` line already cover them:

- `#33` `memphis secret` not registered
- `#34` `memphis explain` not registered
- `#39` Security: 5 findings from full-code-review
- `#43` Cognitive Engine config
- `#58` Tool factory + concurrency batching
- `#59` Conversation compaction
- `#60` Session memory extraction
- `#63` TUI overflow / history scroll / busy animation / token context

### Partially covered or needing retitling/narrowing

These issues map to real themes, but the current codebase already covers part of the problem:

- `#61` No feature flag system
- `#62` No centralized CLI registry with lazy loading
- `#55` exec-policy allowlist too restrictive
- `#57` no automatic learning extraction or self-reflection loop
- `#32` `memphis doctor --fix` does nothing
- `#40` first-run quality
- `#41` legacy-state and migration hardening
- `#42` Rust TUI onboarding phase

These should be reviewed and either:

- closed if obsolete,
- rewritten to the remaining narrow gap,
- or split into smaller follow-up issues.

### Genuinely still open future-work themes

These still read like real post-`v1.2.1` work:

- `#51` code analysis tools
- `#52` automated test generation / test runner tools
- `#53` structured git workflow tools
- `#54` build/deploy pipeline and health-check tools
- `#56` skills marketplace / creator adoption
- `#44` through `#50` v2.0 toolkit / phase roadmap

### Milestone drift

GitHub still shows milestone `v1.2.0` as open, but after the closures above it is now down to three open issues and two closed issues. The remaining open items are the mixed polish/follow-up issues:

- `#40` first-run quality
- `#41` legacy-state and migration hardening
- `#42` Rust TUI onboarding phase

The milestone should be closed only after those three are either narrowed, retargeted, or resolved explicitly.

## Local Plan Audit

### `notes/MEMPHIS-MASTER-PLAN.md`

Still valuable as the broad adoption/research source. It explains the rationale for:

- tool factory and batching,
- session memory,
- compaction,
- work polling,
- session tokens.

However, it is now partially historical because several high-priority adoption gaps described there are already implemented on `main`.

### `notes/ATTACK-PLAN.md`

Useful as a dependency graph and sequencing record, but stale as an active queue because it still treats:

- `#58` tool factory,
- `#59` compaction,
- `#60` session memory

as missing foundational work, even though those capabilities now exist in the runtime.

### `memory/next-tasks-2026-03-27.md`

Historical patch-lane note. It describes a post-GA cleanup lane that has largely been overtaken by `v1.2.0` and `v1.2.1`.

## Infrastructure And Product Truth

The codebase now reflects this infrastructure truth:

- TypeScript remains the orchestration and surface-runtime layer.
- Rust remains the deterministic/security-sensitive layer.
- Rust TUI is the active native operator console.
- HTTP, CLI, MCP, gateway, and TUI are converged onto the same runtime model.
- Session memory and additive conversation compaction exist.
- Worker session tokens, work polling, and local worker execution exist.
- Surface policies and degradation rules are enforced explicitly.
- Release gates and smoke validation are real and mechanically enforced.

Memphis should no longer be described as:

- a pre-release `v1.1.0` system,
- a repo still blocked on its foundational hardening lane,
- or a runtime without memory extraction / compaction / batching / TUI telemetry.

## Feedback From Memphis: Version-Truth Gap

Operator feedback from Telegram showed a concrete truth problem:

- the runtime-facing response reported version `1.1.1`,
- while the actual shipped package/release truth is `1.2.1`.

That means there is still a version-truth drift risk between:

- packaged release truth,
- repo docs truth,
- and at least one operator-facing runtime/reporting surface.

This scan treats that as a real documentation and runtime-reporting concern, not just a cosmetic mismatch. Even when the code and GitHub release are correct, an agent or operator surface that reports the wrong version weakens trust in the whole system.

This follow-up is now tracked on GitHub as `#64` `Version truth drifts across operator-facing surfaces`.

## What Is Actually Left

### Docs and governance cleanup

- update public docs from `v1.1.0` to `v1.2.1`
- keep README, project status, publish status, and docs index aligned
- reconcile historical planning files against the shipped runtime

### GitHub hygiene

- keep narrowing or rewriting partially covered issues
- close milestone `v1.2.0` only after `#40`, `#41`, and `#42` are reconciled

### Real product work still open

- continue first-run and onboarding trust improvements
- continue bounded legacy-state clarity and migration correctness
- decide whether to add a broader feature-flag layer
- decide whether to add lazy CLI loading
- deeper future-agent capability work:
  - code analysis
  - test generation
  - git workflow tooling
  - build/deploy tooling
  - stronger self-reflection / learning loops

## Recommended GitHub Follow-Up

1. Revisit `#32`, `#40`, `#41`, `#42`, `#55`, `#57`, `#61`, and `#62` and either narrow, roll forward, or close them.
2. Close or retarget the still-open `v1.2.0` milestone once `#40`, `#41`, and `#42` are reconciled.
3. Track version-truth convergence under `#64` `Version truth drifts across operator-facing surfaces`.
