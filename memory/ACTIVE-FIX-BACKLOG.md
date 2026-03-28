# Memphis Active Fix Backlog

Updated: 2026-03-28

## Purpose

This file is the active start point for Memphis fix work.

Rules:
- append new bugs and fix candidates here as soon as they are discovered
- keep the highest-priority open items near the top
- use this file as the working backlog, not as product truth
- keep historical context in:
  - `memory/production-audit-findings.md`
  - `memory/bugs-2026-03-27-post-ga.md`

## Current State

- `v1.0.1` shipped and passed release/CI gates
- fresh isolated acceptance passed
- fresh source checkout plus `npm run bootstrap` works
- the biggest remaining gap is not core runtime correctness on clean install
- the biggest remaining gap is install/onboarding coherence and legacy-state upgrade behavior

## Stop-Ship Decision

Current operator assessment:

- work should be treated as blocked until first-run/init is made controlled and explicit
- uncontrolled baseline "soul" seeding is not acceptable as the core product story
- Memphis must not appear to gain internal "awareness" outside operator knowledge and consent
- automatic chain creation that is opaque to the operator is a product contradiction
- if chain creation is also capable of landing in a broken or incompatible state, no further forward product work should proceed before this is fixed

Practical rule from this point:

- no new product expansion before first-run/state-formation is repaired
- this backlog section is now a release-blocking gate, not a polish item

## Start Here

If fix work resumes later, start in this order:

1. `FX-000` controlled first-run and explicit chain formation
2. `FX-001` legacy chain migration vs Rust append
3. `FX-002` onboarding/install surface consolidation
4. `FX-003` missing conversational soul bootstrap
5. `FX-004` `init` semantics vs actual user expectation

## Open Fixes

### FX-000 — No controlled first-run state formation; stop-ship blocker

Priority: P0
Status: open

Observed behavior:
- there is no single controlled first-run flow that:
  - installs Memphis
  - configures Memphis
  - initializes the vault
  - establishes the first identity/memory chains with operator knowledge
  - ends with a runtime the operator can actually trust
- current bootstrap path seeds baseline soul/identity automatically
- the operator does not get a clear, explicit, reviewable step where the first important chains are intentionally formed
- separate evidence already shows chain-state incompatibility can exist in the wild

Why this is a blocker:
- product trust collapses if Memphis appears to create "awareness" or identity state outside operator control
- if the system writes chains the operator did not consciously establish, and some chains can later be broken or incompatible, then Memphis has no trustworthy first-run contract
- without a trustworthy first-run contract, further feature work should stop

Required fix:
- define one explicit first-run contract
- first important state creation must be operator-visible and operator-intentional
- if baseline seeding remains, it must be:
  - minimal
  - fully documented
  - inspectable
  - justified
  - clearly separated from any real soul/persona/onboarding flow
- if conversational first-run is the intended product story, implement it for real and make it canonical
- no more ambiguous overlap between seeded baseline, init/setup, wizard, and bootstrap

Suggested implementation areas:
- `scripts/bootstrap.sh`
- `src/soul/seed.ts`
- `src/infra/cli/commands/setup.ts`
- `src/infra/cli/onboarding-wizard.ts`
- install/onboarding/soul docs

Acceptance target:
- a new operator can answer:
  - what initial chains were created
  - why they were created
  - when they were created
  - whether they were seeded automatically or formed by dialogue
- first-run no longer feels opaque or self-directed
- no forward roadmap continues until this contract is repaired

### FX-001 — Legacy chain upgrade path breaks Rust append

Priority: P0
Status: open

Observed behavior:
- fresh clean install works
- old local runtime state can fail on:
  - `memphis embed store --id ... --value ...`
- failure observed:
  - `rust chain append failed`
  - `invalid_chain_json: missing field 'type'`

What this means:
- legacy chain files still exist in an old block shape
- Rust `chain_append` expects the newer canonical block shape
- `repair runtime` currently repairs derived state like `patterns`, but does not fully normalize legacy canonical chains such as:
  - `journal`
  - `decisions`
  - `system`
  - other old chains if present

Why this matters:
- clean install is good, but upgrade-from-existing-state is not reliable
- that makes Memphis look broken to a user who already touched an older local runtime

Required fix:
- implement a real legacy chain migration or normalization path
- or explicitly detect unsupported legacy chain state and fail with a clear guided migration error
- do not leave the user discovering it via `embed store`

Suggested implementation areas:
- `src/infra/storage/rust-chain-adapter.ts`
- `src/infra/storage/chain-adapter.ts`
- `src/infra/runtime/runtime-repair.ts`
- chain integrity / migration tooling

Acceptance target:
- an old `~/.memphis` runtime with legacy chain blocks can be upgraded or clearly rejected with guidance
- post-upgrade `embed store` works with `RUST_CHAIN_ENABLED=true`

### FX-002 — Install/onboarding surface is fragmented and internally inconsistent

Priority: P0
Status: open

Observed behavior:
- there are multiple overlapping first-run/setup surfaces:
  - `npm run bootstrap`
  - `memphis init`
  - `memphis setup`
  - `memphis onboarding wizard`
  - `memphis onboarding bootstrap`
  - `memphis configure`

Current reality:
- `npm run bootstrap` is the actual canonical full source-first install path
- `memphis init` is only an alias for `setup`
- `memphis setup` is an interactive `.env` and profile wizard
- `memphis onboarding wizard` is a second overlapping onboarding flow
- `memphis onboarding bootstrap` is an ops/bootstrap planner/apply flow
- `memphis configure` still exists but is deprecated and writes `config.yaml`, which is no longer canonical runtime truth

Why this matters:
- a new user cannot tell which command is the real entrypoint
- docs and expectations drift toward "there should be one Memphis init"
- the product currently exposes too many setup stories

Required fix:
- define one canonical user-facing first-run command
- demote or remove overlapping paths
- make the command surface match the install story in docs

Suggested implementation areas:
- `scripts/bootstrap.sh`
- `src/infra/cli/commands/setup.ts`
- `src/infra/cli/onboarding-wizard.ts`
- `src/infra/cli/commands/configure.ts`
- `src/infra/cli/handlers/storage.handler.ts`
- docs for install/onboarding

Acceptance target:
- a new user can answer "which command do I run first?" with one clear answer
- deprecated or secondary setup paths are visibly marked and non-confusing

### FX-003 — Missing conversational soul bootstrap

Priority: P1
Status: open

Expected by operator:
- first chains should be built through conversation
- that conversation should establish Memphis agent soul/identity/boundaries

Current behavior:
- bootstrap performs static baseline seeding
- `seedSoulIdentity()` creates fixed initial identity/memory entries
- there is no active conversational onboarding that builds the first soul-defining chains interactively

Why this matters:
- product expectation and actual onboarding diverge
- user experiences "seeded baseline memory" instead of "first dialogue establishes the agent"

Required fix:
- either implement a real conversational soul bootstrap
- or remove any narrative suggesting that this already exists

Suggested implementation areas:
- `src/soul/seed.ts`
- `src/infra/cli/onboarding-wizard.ts`
- `src/infra/cli/commands/setup.ts`
- soul docs / quickstart docs

Acceptance target:
- either:
  - first-run includes a real soul-forming dialogue that writes initial chains
- or:
  - docs clearly say soul is baseline-seeded and conversational soul boot is future work

### FX-004 — `memphis init` does not match what users expect from `init`

Priority: P1
Status: open

Observed behavior:
- user expectation: `memphis init` should feel like the single product entrypoint
- actual behavior: `memphis init` is just the `setup` wizard alias

Gap:
- it does not perform the whole supported end-to-end first-run flow
- it does not replace `bootstrap`
- it does not finish with an operator-ready runtime on its own
- it does not own the "first chains / first soul / first chat" experience

Why this matters:
- the name `init` implies canonical first-run ownership
- current implementation is narrower than the name suggests

Required fix:
- either promote `memphis init` into the one true first-run orchestrator
- or demote/remove the alias and keep `bootstrap` as the clearly documented top-level entrypoint

Suggested implementation areas:
- `src/infra/cli/commands/setup.ts`
- `scripts/bootstrap.sh`
- install and quickstart docs

Acceptance target:
- `memphis init` either becomes the real first-run path or stops pretending to be one

### FX-005 — Bootstrap ends before operator-ready setup is complete

Priority: P1
Status: open

Observed behavior:
- `npm run bootstrap` completes technical install successfully
- but vault setup still needs a separate manual `memphis vault init`

Why this matters:
- for a new user, bootstrap feels like install is "done"
- in practice, operator configuration is still incomplete

Notes:
- this may be acceptable by design for security reasons
- but the UX contract is still rough

Required fix:
- decide whether bootstrap should:
  - remain technical-only and say so very clearly
  - or become guided enough to complete operator-ready first-run

Suggested implementation areas:
- `scripts/bootstrap.sh`
- `src/infra/cli/handlers/vault.handler.ts`
- install docs / quickstart docs

Acceptance target:
- first-run flow feels intentionally complete, not half-complete

### FX-006 — Source-first install is canonical, package install is secondary, but UX still blurs that

Priority: P2
Status: open

Observed behavior:
- shipped package/tarball exists and works as bounded distribution surface
- canonical full runtime is still source checkout plus bootstrap
- user expectation can still drift toward "download package and everything just works"

Why this matters:
- install expectations differ between CLI package and full Memphis runtime
- this creates avoidable friction during first real test

Required fix:
- tighten the distinction between:
  - package distribution path
  - full source-first runtime path
- make that difference impossible to miss in install UX and docs

Suggested implementation areas:
- `README.md`
- install docs
- package publish docs
- first-run command messaging

Acceptance target:
- new user understands immediately whether they are doing:
  - bounded CLI/package install
  - or full Memphis local runtime install

## Already Confirmed Working

These should not be re-opened without evidence:

- `v1.0.1` release/tag/CI path
- fresh isolated `ops:offline-acceptance`
- fresh source checkout plus `npm run bootstrap`
- Rust TUI launch surface
- health/doctor/repair runtime on a clean runtime

## Notes For Future Appends

When adding a new issue:
- put it under `Open Fixes`
- give it the next `FX-00N` id
- include:
  - priority
  - observed behavior
  - why it matters
  - required fix
  - likely code areas
