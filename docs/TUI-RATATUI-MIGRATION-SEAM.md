# Ratatui Migration Seam

## Purpose

This note defines the seam for a later `ratatui` migration without changing the supported
operator contract in the current sprint. The active renderer remains the hardened
`crossterm` diff-line backend.

## Current Split

The Rust TUI should be treated as three layers:

1. `App state / commands`
   - input handling
   - background refresh scheduling
   - host/native command dispatch
   - screen selection and busy/cancel transitions

2. `View model`
   - derived rows, status lines, panels, and transcript entries
   - no terminal writes
   - deterministic from app state + latest snapshots

3. `Renderer backend`
   - terminal-specific drawing
   - cursor policy
   - diffing / frame presentation

## Active Backend

Current production backend:

- framework: `crossterm`
- mode: retained renderer with diff-line redraw
- full clear allowed only for:
  - session enter
  - hard resize reset
  - explicit renderer reset

This backend is the release path until a dedicated migration sprint lands.

## Future Ratatui Backend

The future `ratatui` migration should replace only the renderer backend first.

Target sequence:

1. preserve app state and command flow
2. preserve view-model contract
3. add a `ratatui` renderer implementation behind the same backend seam
4. prove parity with the existing screens and host-backed commands
5. retire the legacy `crossterm` backend only after parity + acceptance are green

## Non-Goals For This Sprint

- no screen redesign
- no command contract changes
- no host protocol changes
- no partial renderer rewrite mixed into feature work

## Exit Criteria For A Future Migration Sprint

- `check-only` remains green
- transcript/chat no longer depends on manual diff-line logic
- resize, refresh, and active command flows remain flicker-free
- native surfaces and host-backed commands render the same operator truth as before
