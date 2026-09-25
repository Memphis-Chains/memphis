# ADR-008 — Offline-Invariant CI Gate on the Chain Surface

Date: 2026-09-21
Status: Proposed
Deciders: operator (Marcin Kukla), `feat/can-self-modify-computed` lineage,
decisions #98, #146–#150, #626 monitoring chain
Supersedes: —
Related: issue #628 monitoring chain (PR #631 fix-path), decision #190
(monitoring/sweeper locator), commit `d4dacc6` (`writeBlockAtomic` read-after-
write verification — partial fix in main for issue #626), `scripts/chain-
integrity-sweep.mjs` (hourly sweep script shipped with v1.13.2), `~/.config/
systemd/user/memphis-chain-integrity-sweep.{timer,service}` (operator-local
install, not in repo), `docs/adr/006-atomic-embed-index-write.md` (sibling
ADR for the embed-index re-encryption race)

## Context

Memphis's chain storage is the runtime's primary source of truth for
journal, soul, decisions, trust, and cases. Three layered defenses already
exist on the operator's box:

1. **`writeBlockAtomic` read-after-write verification** (commit `d4dacc6`,
   v1.13.2 backport) — catches atomic-write-boundary corruption. Test
   surface was empty until PR #635 (8 cases in `tests/unit/chain-file-io.test.ts`).
2. **`scripts/chain-integrity-sweep.mjs`** (hourly systemd timer, installed
   to `~/.config/systemd/user/` locally) — independently re-reads the tail
   of every chain with `JSON.parse`, exits non-zero on any failure with the
   offending block on stderr. Detects class-of-bug cases #382 and #385 within
   one hour rather than at next TUI session.
3. **`tests/integration/offline-invariant.test.ts`** (existing, single file,
   light) — PR-time gate that asserts core runtime paths work without
   remote-provider credentials. Runs as part of CI today.

What is **missing**:

- **No CI enforcement of the offline invariant at the *chain* surface.**
  `tests/integration/offline-invariant.test.ts` exercises the runtime, but
  does not write a synthetic chain directory and verify that
  `chain-integrity-sweep.mjs` accepts it. A regression where the sweep
  script silently starts treating a corrupt block as valid would slip past
  PR-time gates.
- **Systemd units live outside the repo.** The operator's hourly cron
  (`memphis-chain-integrity-sweep.timer`) and corresponding
  `memphis-chain-integrity-sweep.service` exist only in `~/.config/systemd/
  user/`. Reproducing the install on a clean operator machine requires
  manual steps. Other operator-local install drift (whisper / piper / camera)
  is tracked in `scripts/systemd/*`; the chain sweep is not.
- **CI quality-gate window for offline invariant** is currently 0 ms
  (no test). Failures become visible only after release + first operator
  / artefact migration.

## Decision

Adopt **offline-only** invariant enforcement for the chain surface via:

1. **Golden fixture `tests/integration/chain-invariant.test.ts`** — synthesises
   a fresh chains directory with three chains × ten blocks each, runs
   `scripts/chain-integrity-sweep.mjs --tail 50` against it via `execFileSync`,
   asserts exit code 0 and summary JSON's `ok: true` plus per-chain
   `blocks_failed: 0`. Then corrupts one block (rewrite `hash` field),
   re-runs sweep, asserts exit code 1 with details on stderr. Restores
   before tear-down. Stays under 5 seconds — fast enough for PR gate.

2. **New workflow `.github/workflows/chain-invariant.yml`** — runs on every
   `pull_request` event targeting `main`. Symmetric with `tests/integration/
   signed-block-gate.test.ts` and `tests/integration/offline-invariant.test.ts`
   already wired into `.github/workflows/ci.yml`. Block-merge protection
   prevents a regression that breaks the chain invariant from reaching `main`
   silently. No credentials, no remote runners, no caches — the test is
   self-contained.

3. **Codify the systemd units in `scripts/systemd/`** — move the existing
   operator-local `memphis-chain-integrity-sweep.{timer,service}` and
   `memphis-wal-checkpoint.{timer,service}` from `~/.config/systemd/user/`
   to `scripts/systemd/`, adding `scripts/systemd/README.md` with install
   instructions. Install is one `cp` + `daemon-reload` + `enable --now`,
   no manual editing needed. README has a "verify" section that confirms
   the timer is firing.

4. **No new permissions granted.** The CI gate does NOT use
   `actions/github-script` or other write APIs; it is a pure read-only
   smoke test against a tmpdir. The systemd unit is intentionally
   `Type=oneshot` with no RWX paths beyond its working dir. WAL checkpoint
   uses the existing `node /home/memphis/memphis/scripts/wal-checkpoint.mjs`
   invocation, same as today's `~/.config/systemd/user/memphis-wal-checkpoint.service`.

## Why offline-only

Three alternatives were considered and rejected:

A. **Spin up a live 3-node libp2p cluster in CI.** Estimated 4+ minutes per
   run, requires Rust toolchain pinning, fragile under flaky networking,
   and doesn't actually catch chain-corruption (clusters see coherent
   views). Better suited to a separate coverage acceptance flow, not PR
   gate.

B. **Use a dockerised Memphis build.** Adds ~1 GB of `docker/memphis` image
   maintenance, requires Docker-in-Docker runners (paid GH orgs only), and
   reproduces the same offline-invariant black-box surface that the
   golden fixture covers in <5 seconds.

C. **Spawn a node process running the full memphis runtime.** Requires
   `npm run build`, fixture setup, teardown — multi-minute, redundant with
   `tests/integration/offline-invariant.test.ts` already in CI.

The chosen golden-fixture approach is the **fastest** (under 5 seconds),
the **most deterministic** (synthetic chains have known exact contents),
and the **most portable** (only needs Node 22, no Rust, no Docker, no
network).

## Operational notes

- **CI gate timing.** Currently under 5 seconds; CI target is "fail fast
  on PR". A regression that turns the sweep into a slow operation will
  show up as "CI taking too long" before it shows as a semantic fail.
- **Systemd unit is opt-in.** Operators who do not want a `user@.service`
  timer do not need to run the install command. CI gate is unaffected.
- **WAL checkpoint is at the same 6h cadence as today.** No change to
  operator UX.
- **README has 5-second verify.** After `enable --now`, run
  `systemctl --user list-timers --all | grep memphis-chain-int` and
  expect the timer to be `next` within `5min` + jitter.

## Out of scope (deferred)

- The ADR does NOT introduce a `scripts/chain-invariant-fuzz` (random-write
  fuzzer against the sweep). Existing `tests/integration/offline-invariant.test.ts`
  runtime fuzzers cover most paths. Fuzz is Q1 2027 backlog per roadmap.
- Embed-index side of chain corruption is its own ADR (already ADR-006).
  This ADR is chain-blocks-file surface only.

## Decision log

Pending operator review. Branch: `feat/phase-L-offline-invariant`.
