# Memphis Current Roadmap

Updated: 2026-03-28

## Why This Roadmap Exists

Memphis moved fast over the last month and accumulated too many competing
stories about what had shipped, what was only partially repaired, and what was
still aspirational. This document is the canonical roadmap for the current
phase after `v1.0.1`.

It replaces informal interpretation of older roadmap files. Historical roadmap
artifacts still exist for auditability, but they are not the current plan.

## The Last Month: What Actually Happened

The month-long arc looked like this:

1. Memphis started from a fragmented state: multiple roadmap narratives,
   divergent operator surfaces, legacy TUI baggage, mixed release/install
   stories, and incomplete runtime convergence.
2. The core runtime was then progressively unified around local-first,
   chain-first behavior: one turn runtime, one memory truth, one release path,
   and one native Rust operator console.
3. `v1.0.0` and `v1.0.1` were cut after the core runtime, release gates, and
   source-first install path became coherent enough to ship.
4. After that, a critical truth gap became clear: first-run and onboarding were
   not trustworthy enough, and the repo docs still mixed product truth with old
   internal narratives.
5. The current phase began as a recovery-and-truth phase: controlled `init`,
   explicit first-state creation, legacy-state detection, and documentation
   correction.

## What Is Already Done

- chain-first runtime and memory are the product core
- CLI, HTTP, MCP, and Rust TUI share the core runtime contract
- Rust TUI replaced the old TypeScript TUI as the active native console
- release and CI gates are real and enforced
- `bootstrap -> init` is now the intended first-run contract
- legacy roadmap files have been demoted from active product truth

## Where We Are Now

Memphis is in a **stabilization and trust-consolidation phase**.

That means:

- do not expand features just to make the roadmap look bigger
- do make the current product easier to trust, install, understand, and operate
- do keep documentation, release status, and runtime behavior aligned

## Current Milestones

### M1. Documentation and public truth closure

Goal:

- make the repo tell the full truth on `main`

Outcomes:

- rewritten public README
- canonical current-status doc
- canonical current-roadmap doc
- release/publication truth clarified after `v1.0.1`
- Apache-2.0 made explicit and mechanically verified

### M2. First-run quality and operator trust

Goal:

- make `init` feel intentional and reviewable, not just technically correct

Outcomes:

- better guided-conversation quality
- clearer first-state preview and reporting
- simpler operator language around identity, memory, and chain creation

### M3. Legacy-state and migration hardening

Goal:

- make older local runtime state fail early and recover clearly

Outcomes:

- more reliable legacy detection
- bounded normalization/migration paths
- fewer “late crash” scenarios during normal use

### M4. Rust TUI onboarding phase

Goal:

- bring the controlled first-run flow into the next TUI generation without
  wasting work on the current renderer layer

Outcomes:

- shared onboarding state machine reused by future TUI work
- ratatui-connected TUI onboarding later, not during the current docs/trust
  phase

### M5. Post-core polish and optional surfaces

Goal:

- harden optional channels and polish operator experience only after the core
  product story is stable

Outcomes:

- bounded optional channel improvements
- remaining legacy/debug cleanup
- packaging/distribution clarity

## Explicitly Deferred

These are not current blockers and should not outrun the stabilization phase:

- broad provider expansion
- federation as a core dependency
- OpenClaw revival
- “AI slop” feature growth without operator-trust payoff
- large Rust TUI UX expansion before the ratatui-connected phase

## Historical Pointers

Older files remain as historical records:

- `ROADMAP.md`
- `ROADMAP-MASTER-QUEUE.md`
- `docs/ROADMAP-FULL-SPRINT3-TO-M8.md`
- `docs/EXECUTION-PLAN.md`

Use them to understand how Memphis got here, not to decide what happens next.
