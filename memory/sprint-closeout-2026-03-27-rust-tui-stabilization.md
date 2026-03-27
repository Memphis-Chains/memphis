# Rust TUI Stabilization Sprint Closeout - 2026-03-27

## Summary

This sprint should be remembered as a Rust TUI stabilization and product-truth sprint, not as a Telegram feature sprint.

The main outcome is that the active Rust console is now a credible operator cockpit:

- single-view transcript UX instead of screen-switched tabs
- native `memphis-operator` chat streaming
- non-blocking worker runtime
- `Ctrl+C` cancel-when-busy / quit-when-idle behavior
- `check-only` truth updated to `uiMode: "single-view"` and logical `surfaces`
- release/docs truth aligned with the shipped Rust-first console

## Delivered This Sprint

### Rust TUI product behavior

- the interactive Rust TUI now behaves as a single-view transcript cockpit
- plain text routes to native chat
- supported local commands run inside the Rust operator path
- unsupported commands can fall back through the existing Node CLI bridge
- the footer and status bar now reflect active task state instead of pretending the UI is idle

### Runtime and safety behavior

- native chat streams live through `memphis-operator`
- active work no longer blocks the TUI event loop
- `Ctrl+C` cancels active work first and exits only when the TUI is idle
- cancelled streams do not persist partial assistant turns into the transcript store

### Product truth and release proof

- active docs now describe the Rust TUI as a single-view cockpit over seven logical surfaces
- RC and launcher truth tests are aligned with the shipped Rust console
- `memphis tui --check-only --json` now reports:
  - `uiMode: "single-view"`
  - `surfaces`

## What Remains In The TUI Lane

These are still real follow-up items, but they are no longer architecture blockers for the Rust TUI:

1. manual interactive proof of the cancel path during a real long-running stream
2. removal or further narrowing of the remaining legacy CLI fallback paths
3. stronger mid-flight cancel behavior for non-stream provider paths that still resolve request/response synchronously

## Telegram Companion Mode Position

Telegram should be recorded as the strongest next-sprint candidate, not as unfinished work in this stabilization sprint.

Recommended position:

- Rust TUI stays a companion client
- Telegram action paths route through the existing TypeScript infrastructure first
- the first slice should be command-first:
  - `/telegram status`
  - `/telegram send ...`
- these should reuse the existing TS-owned bridge instead of opening a new Rust-direct Telegram path

Why this is the right default:

- it preserves TS-owned policy and safety boundaries
- it avoids moving Telegram token handling into the Rust TUI
- it reuses already shipped command surfaces before inventing a new seam
- it keeps this sprint cleanly scoped as stabilization

## What We Should Not Do

- direct Rust TUI -> Telegram Bot API calls
- token resolution or long-lived Telegram credentials inside the Rust TUI
- a new Rust-native LLM or channel path that bypasses existing TS-owned policy enforcement
- NAPI as the first Telegram integration step without a measured CLI-bridge problem and explicit threat review

## Recommended Next Sprint Entry

If Telegram companion mode is opened next, the first slice should be:

1. `/telegram status` in the Rust TUI using the existing readiness/system truth
2. `/telegram send ...` routed through the current TS-owned host path
3. manual validation that the TUI path inherits the intended TS-owned security and audit behavior

The dedicated Telegram view, richer message UX, or any NAPI work should wait until that first slice proves insufficient.

## Addendum After Host-First Closure

The main follow-up items above have since shifted:

- the dedicated TypeScript extension host is now the active seam for documented TS-owned TUI commands
- the `check-only` report no longer carries the transitional `screens` alias
- the RC drill now includes a source-checkout proof of one documented host-backed TUI command

The remaining TUI debt is now narrower:

1. manual interactive cancel proof
2. remove or further shrink the legacy CLI fallback path
3. deeper host-backed parity and transcript polish where needed
