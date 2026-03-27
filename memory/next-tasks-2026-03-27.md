# Suggested Next Tasks - 2026-03-27

## Goal

Keep the active lane focused on **host-first Rust TUI closure and release hardening**.

The architecture is now stable enough that the next tasks should remove transition debt, not open new seams.

The manual Rust TUI cancel drill is now closed on the active runbook path, so the next tasks start after operator-proof closure rather than before it.

## Priority Order

### P0. Finish host-backed parity for documented TS-owned TUI commands

Targets:
- `crates/memphis-tui/src/app.rs`
- `src/infra/tui-host/commands.ts`
- `docs/TUI-OPERATOR-GUIDE.md`

Reason:
- every TS-owned command documented in the active TUI guide must be host-backed
- documented commands must not silently degrade to the legacy one-shot CLI bridge

Desired outcome:
- `/doctor`
- `agents list|discover|show`
- `sync status`
- `apps list|show|plan`
- `reflect`
- `insights`
- `config tools list|check|pending`
- `/telegram send ...`

all render as operator-readable transcript output through the extension host

### P0. Keep the extension host as the only preferred TS seam

Targets:
- `crates/memphis-tui/src/client.rs`
- `tests/unit/tui-host.test.ts`

Reason:
- the host is now the intended TS bridge for the Rust TUI
- the legacy CLI bridge should remain only as an explicit emergency escape hatch

Desired outcome:
- keep restart / timeout / cancel semantics explicit
- unknown slash commands fail closed by default
- keep the legacy bridge only behind `/legacy ...`
- do not add `memphis-napi` or direct Rust -> Telegram/API paths

### P1. Make RC proof reflect host-backed TUI reality

Targets:
- `scripts/rc-drill.sh`
- `docs/RELEASE-PROCESS.md`
- `docs/RELEASE-CHECKLIST.md`

Reason:
- the source-checkout RC drill is the proof path for the full Rust TUI runtime
- that proof should cover one real TS-owned host-backed TUI command, not only `--check-only`

Desired outcome:
- RC drill validates:
  - `memphis tui --check-only --json`
  - one documented extension-host-backed TUI command

### P1. Keep the `check-only` contract single-view only

Targets:
- `crates/memphis-tui/src/main.rs`
- RC truth/ops tests that inspect the report

Reason:
- `screens` was a migration alias only
- the active contract is now `uiMode + surfaces`

Desired outcome:
- no active tests, scripts, or docs rely on `screens`

## Out of Scope

- new providers
- direct Rust -> Telegram Bot API access
- Telegram token handling in Rust TUI
- `memphis-napi` as a TUI seam
- extension-host multi-request concurrency
- new product surfaces beyond the current TUI/host/release lane
