# Memphis Remaining Scope Summary

Updated: 2026-03-28

## Current Position

Memphis is operational but not yet broadly stable.

Already closed:

- core local-first runtime
- chain-first memory and decision model
- one shared runtime across CLI, HTTP, MCP, and Rust TUI
- Rust TUI as the active native console
- release and CI path
- controlled clean install path: `bootstrap -> init`
- public docs/status rewrite
- Apache-2.0 visibility and docs contract

## What Is Still Left

### 1. First-run / onboarding consolidation

- finish removing ambiguity between `bootstrap`, `init`, `setup`, legacy onboarding commands, and deprecated `configure`
- make one obvious answer for a new user: what command to run first
- keep package install vs full-runtime install impossible to confuse

### 2. Guided onboarding quality

- improve the guided conversation used for first meaningful state creation
- improve first-state preview, wording, and final report
- make the operator understand exactly what chains are being created and why

### 3. `memphis init` expectation gap

- make `memphis init` fully deserve the name as the true product entrypoint
- keep it canonical, intentional, and easier to trust

### 4. Bootstrap completion decision

- decide whether bootstrap remains strictly technical forever
- or whether it should guide users more clearly to operator-ready completion
- current flow is valid, but still feels half-complete to a new user unless docs are followed carefully

### 5. Legacy-state hardening

- keep improving detection and normalization of older local runtime state
- fail early and clearly when migration is unsafe
- prevent late failures during normal commands

### 6. Future TUI onboarding

- intentionally deferred for now
- future onboarding should be wired into the next TUI phase, not bolted onto the current renderer
- no big work on the current Rust TUI just to replace it later

### 7. Post-core polish

- optional channel hardening
- remaining legacy/debug cleanup
- packaging/distribution clarity
- operator UX polish after onboarding trust is solid

## What Is Not The Priority Now

- provider expansion
- federation as a core dependency
- OpenClaw revival
- large new TUI UX work before the ratatui-connected phase
- feature growth that does not improve operator trust

## Practical Next Sequence

1. onboarding/install surface consolidation
2. guided conversational bootstrap polish
3. make `init` fully match user expectation
4. decide and polish bootstrap handoff/completeness
5. legacy-state migration hardening
6. future TUI onboarding on the new seam

## Source Of Truth

This summary was derived from:

- `docs/PROJECT-STATUS.md`
- `docs/ROADMAP-CURRENT.md`
- `memory/ACTIVE-FIX-BACKLOG.md`
