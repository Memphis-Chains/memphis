# First-Run Stop-Ship History

Updated: 2026-03-28

## Summary

This document records the stop-ship assessment that forced the first-run
recovery work for Memphis `v1.0.1`.

The source-first clean-install path has since been repaired around:

- `npm run bootstrap` as technical install/build only,
- `memphis init` as the canonical controlled first-run,
- explicit first-state preview and write,
- bounded legacy-state normalization and repair.

Keep this note as historical context for why the contract was changed. Current
open follow-up work lives in `memory/ACTIVE-FIX-BACKLOG.md`.

## What Is Confirmed Working

- fresh source checkout plus `npm run bootstrap`
- Rust + TypeScript build
- release and CI path
- health, doctor, repair, and TUI on a clean runtime
- isolated offline acceptance

## What Triggered The Stop-Ship

- one canonical first-run command
- controlled creation of the first meaningful chains
- explicit operator approval over initial soul/identity state
- reliable upgrade path for older local runtime state
- install and onboarding docs that all tell the same story

## Historical Rule

At the time, no further product expansion was to be prioritized ahead of:

1. controlled first-run and explicit chain formation
2. legacy chain compatibility/migration
3. onboarding/install surface consolidation

## Active Backlog

The active recovery list is tracked in:

- `memory/ACTIVE-FIX-BACKLOG.md`

That file is the implementation start point for repair work.
