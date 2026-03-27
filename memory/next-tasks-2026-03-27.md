# Suggested Next Tasks - 2026-03-27

## Goal

Keep the active lane focused on **patch-lane closure**, not new seams.

The host-first Rust TUI architecture, RC proof path, and cancel drill are now closed enough that the next tasks should target only the remaining transition debt.

## Priority Order

### P0. Further demote the remaining `/legacy ...` path

Targets:
- `crates/memphis-tui/src/app.rs`
- `docs/TUI-OPERATOR-GUIDE.md`

Reason:
- the legacy CLI bridge is now intentionally only an emergency escape hatch
- it should not keep visual weight comparable to native or host-backed paths

Desired outcome:
- `/legacy ...` remains explicit only
- main TUI UX and active docs treat it as last-resort compatibility, not standard operator flow

### P0. Transcript polish for edge cases

Targets:
- `crates/memphis-tui/src/app.rs`
- `crates/memphis-tui/src/ui.rs`
- `src/infra/tui-host/commands.ts`

Reason:
- the major host-backed command families are now normalized
- the remaining work is edge-case readability, not missing architecture

Desired outcome:
- cancelled, failed, reset, and compatibility-path outputs stay short and operator-readable
- no raw JSON or ambiguous generic phrasing leaks into the transcript where a bounded label would do better

### P1. Roll active docs from pre-GA wording to shipped-baseline truth

Targets:
- active operator/release/install docs
- `memory/sprint-progress.md`

Reason:
- canonical runtime truth is already shipped
- some docs and notes still describe transition more than baseline

Desired outcome:
- active docs read like a shipped baseline with bounded debt
- historical plans stay historical instead of leaking into current operator truth

### P1. Remove remaining workflow/runtime deprecation debt from automation

Targets:
- release / CI scripts and workflows

Reason:
- the shared release contract is already converged
- the remaining work is cleanup of stale assumptions and compatibility leftovers

Desired outcome:
- no active automation path suggests a deprecated runtime or release entrypoint
- release automation reflects the shipped host-first Rust TUI reality end to end

## Out of Scope

- new providers
- direct Rust -> Telegram Bot API access
- Telegram token handling in Rust TUI
- `memphis-napi` as a TUI seam
- extension-host multi-request concurrency
- new product surfaces beyond the current TUI/host/release lane
