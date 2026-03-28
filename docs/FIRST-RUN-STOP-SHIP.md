# First-Run Stop-Ship Status

Updated: 2026-03-28

## Summary

Memphis `v1.0.1` passes clean-install, release, and CI gates, but the product's
first-run contract is not trustworthy enough yet.

The stop-ship issue is not "the runtime does nothing". The stop-ship issue is
that first-run state formation is still too opaque and too fragmented:

- there is no single clear operator-first `init` story
- bootstrap, setup/init, onboarding flows, and deprecated configure overlap
- baseline soul/identity seeding still happens automatically
- the operator is not given one explicit, reviewable first-state creation step
- older local runtime state can still hit chain-format incompatibilities

Until that is repaired, Memphis should not be treated as having a stable
operator-first onboarding experience.

## What Is Confirmed Working

- fresh source checkout plus `npm run bootstrap`
- Rust + TypeScript build
- release and CI path
- health, doctor, repair, and TUI on a clean runtime
- isolated offline acceptance

## What Is Not Good Enough Yet

- one canonical first-run command
- controlled creation of the first meaningful chains
- explicit operator approval over initial soul/identity state
- reliable upgrade path for older local runtime state
- install and onboarding docs that all tell the same story

## Current Rule

No further product expansion should be prioritized ahead of:

1. controlled first-run and explicit chain formation
2. legacy chain compatibility/migration
3. onboarding/install surface consolidation

## Active Backlog

The active recovery list is tracked in:

- `memory/ACTIVE-FIX-BACKLOG.md`

That file is the implementation start point for repair work.
