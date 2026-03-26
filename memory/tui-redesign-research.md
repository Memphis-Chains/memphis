# TUI Redesign Research

**Date:** 2026-03-26  
**Status:** active design note for post-hardening TUI phases

## Decision

Memphis should not jump directly from the current TypeScript TUI to a Rust rewrite.

The correct sequence is:

1. `TUI Phase 6A` — fix correctness and operator reliability in the current TypeScript TUI.
2. `TUI Phase 6B` — extract terminal/runtime seams for testability and cleaner ownership.
3. `TUI Phase 6C` — rebuild the screen model around real Memphis operator flows.
4. `TUI Phase 6D` — only then run a bounded Rust TUI spike and make a replacement decision.

## Verified Current-State Findings

The current TUI still has short-term TypeScript issues worth fixing before any rewrite:

- `RootLayout` scroll state can overshoot the available content, which can blank the visible pane.
- dashboard scrolling was not wired through the main key handler even though dashboard content can exceed the viewport.
- split width could become stale after terminal resize and leave the right panel too narrow.
- `ProcessTerminal` cached terminal dimensions incorrectly and did not reliably force a full redraw on resize.
- terminal I/O, render diffing, command dispatch, and runtime calls are still too coupled.

## Phase Plan

### Phase 6A — Correctness

- clamp scroll offsets against available wrapped lines
- enable dashboard scroll behavior
- make resize authoritative and force a correct redraw
- clamp split widths after terminal resize
- add tests for scroll math, resize behavior, and viewport semantics

### Phase 6B — Extraction

- introduce terminal input/output abstractions
- move `stdin` / `stdout` / raw-mode handling into process adapters only
- isolate command dispatch from the readline loop
- add fake-terminal integration tests

### Phase 6C — Product-Aware TUI

- replace legacy screen framing with:
  - `Overview`
  - `Chat`
  - `Memory`
  - `Sessions`
  - `Vault`
  - `Cases / Decisions`
  - `System`
- keep TUI as a thin operator surface over the shared Memphis runtime

### Phase 6D — Rust Decision Gate

- evaluate a separate `memphis-tui` binary only after 6A-6C
- use Memphis control-plane contracts, not `memphis-napi`, as the integration boundary
- prefer local HTTP as the first control surface for the spike
- require feature-parity and rollback criteria before any replacement

## Architecture Notes

- The TypeScript TUI must not invent provider, tool, or auth semantics that differ from CLI, HTTP, MCP, or gateway.
- A future Rust TUI should use Rust crates directly where that helps, but should still act as an operator surface over canonical Memphis runtime contracts.
- TUI polish does not outrank runtime correctness, vault boundaries, storage correctness, or prompt/persistence security.
