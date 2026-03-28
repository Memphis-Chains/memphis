# Memphis Project Status

Updated: 2026-03-28

## Current Position

Memphis is currently **operational but not yet broadly stable**.

The latest published release is `v1.0.1`. Current `main` is ahead of that tag
only in documentation/status truth and related cleanups unless a later release
explicitly says otherwise.

The correct current statement is:

- Memphis is a real local-first runtime, not a mock or placeholder
- the core runtime, release path, and native operator path exist
- the product still needs more stabilization before it should be described as
  effortless or fully mature

## What Is Verified Working

- source checkout plus `npm run bootstrap`
- controlled first-run through `memphis init`
- chain-first memory with derived recall/index layers
- CLI, HTTP, MCP, and Rust TUI on the same core runtime contract
- health, doctor, and repair flows
- release preflight, package artifact generation, and CI gating

## What Is Still In Progress

- first-run and onboarding quality
- broader product clarity around current maturity and supported workflows
- smoother legacy-state migration for older local runtimes
- future TUI onboarding work after the planned ratatui-connected phase

## Current Product Truth

- `bootstrap` is technical install/build only
- `init` is the controlled operator-first first-run flow
- local chains are the canonical memory source of truth
- derived indexes, pattern lanes, and helper stores are rebuildable support
  surfaces
- Rust TUI is the active native console, but first-run onboarding remains
  CLI-first today
- GitHub is backup/review/CI infrastructure, not runtime memory truth

## Current Risks / Remaining Gaps

These are the main reasons Memphis is still in stabilization rather than being
described as fully stable:

1. first-run must continue getting simpler and more trustworthy
2. legacy runtime migration must remain bounded and explicit
3. documentation and release messaging must keep matching the real product
4. some future-facing work, especially TUI onboarding and deeper polish, is
   still intentionally deferred

## Where To Look Next

- [ROADMAP-CURRENT.md](./ROADMAP-CURRENT.md) for the actual next milestones
- [FIRST-RUN-STOP-SHIP.md](./FIRST-RUN-STOP-SHIP.md) for the historical trigger
  behind the onboarding recovery
- [RUNTIME-STATE-MODEL.md](./RUNTIME-STATE-MODEL.md) for canonical runtime
  state roots
- [PUBLISH-STATUS.md](./PUBLISH-STATUS.md) for package/release publication truth
