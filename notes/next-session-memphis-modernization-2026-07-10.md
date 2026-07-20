# Next session — Memphis modernization handoff

**Saved:** 2026-07-10T21:02:46+02:00

## Completed in this working tree

- Fixed graceful shutdown ownership for Telegram, reflection, and scheduler.
- Hardened LR Dashboard Telegram pH saves: same-message only, date-aware,
  range-checked, and never inferred from history.
- Removed confirmed unreachable legacy/cache/session/parser/federation code and
  the dormant nightly-training implementation; retained a documented deferral.
- Added Knip file/dependency gate, coverage reporting, and CI coverage artifact.
- Started modularization:
  - doctor report renderer extracted;
  - LR tool metadata extracted into a registry domain module;
  - HTTP health/metrics, public status, and ops-status routes extracted.

## Verified during this session

- `npm run typecheck`
- `npm run lint`
- `npm run deadcode:check`
- Targeted LR, lifecycle, registry/schema, metrics, and ops-status Vitest suites.

The full Vitest command was started, but this execution environment returned
partial dot output without a final summary. Re-run it before release.

## Resume priorities

1. Continue HTTP route extraction: dashboard, tier/capabilities, then config,
   vault, approval, session, and soul routes.
2. Split Telegram into command, text-turn, media, voice, and delivery modules.
3. Split the in-process tool executor by domain while retaining one policy gate.
4. Expand domain-owned tool metadata beyond LR Dashboard.
5. Review coverage artifact and add no-regression ratchets before numeric gates.
6. Classify the 178 Knip unused-export candidates by public/test/dynamic ownership;
   do not bulk-delete them.
7. Run full release-equivalent validation: build, full TS suite, Rust suite, and
   smoke/recovery gates.

## Continued 2026-07-11

- Extracted tier-3 session/elevation and capability HTTP routes.
- Extracted Telegram operator probes and TTS text preparation.
- Extracted tool-executor input normalization while retaining the centralized
  authorization and hook gate.
- Moved journal metadata into a domain-owned registry module and wired the LR
  Dashboard tool into the MCP surface; the three-surface audit is green.
- Classified the Knip export inventory in
  `notes/knip-export-audit-2026-07-11.md` without bulk deletion.
- Confirmed the earlier incomplete output was terminal polling, not a Vitest
  exit. The persistent full run passed 3,373 tests across 535 files (one file
  skipped) and produced the coverage artifact.
- Added no-regression floors from that baseline: statements 66%, branches 57%,
  functions 72%, and lines 67%, plus an explicit artifact verifier.
- Extracted dashboard and operational config/restart HTTP routes; config, vault,
  approval, session, soul, and Model-D route groups remain the next extraction
  sequence.

## Worktree safety

The worktree contains pre-existing shared edits in gateway, CLI, onboarding,
and tests. Do not commit all changes blindly. Review and stage only intentional
scope before committing.

## Closed 2026-07-13

The modernization plan is implemented. HTTP, Telegram, tool-executor, and
tool-registry facades now delegate to focused domain modules. The final facade
sizes are 454, 103, 291, and 381 lines respectively.

Closeout also removed the remaining ESLint environment-access warnings by
registering typed accessors, and made the Rust NAPI tests hermetic: case tests
now serialize against process-wide signing variables, while embed tests
serialize singleton access and disable operator-owned persistence.

Final validation:

- `npm run -s lint`, `npm run -s typecheck`, and
  `npm run -s deadcode:check` pass.
- `npm run build:release` and `git diff --check` pass.
- Canonical `npm test` passes outside the restricted socket sandbox:
  Rust workspace green, 535 TypeScript files / 3,373 tests green,
  `SMOKE_TEST_OK`, and `TEST_STACK_OK`.

No commit or push was performed. The remaining repository action is an
intentional staging review because this shared worktree contains a broad set of
pre-existing modernization edits and deletions.
