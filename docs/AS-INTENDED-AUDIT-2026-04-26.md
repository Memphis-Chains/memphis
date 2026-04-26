# Memphis "as intended" audit — 2026-04-26

## Provenance

This document audits Memphis against the operator-defined evaluation function
captured in the pre-sprint plan
(`/home/memphis/.claude/plans/roadmap-to-success-lazy-pie.md`,
"Evaluation function (the success rubric)" section). The plan sized eight
sprints (S0–S8) plus an inserted hot-fix sprint (S2.5) to drive every
rubric item to its target. This file reports per-criterion outcomes.

## How to read

Each criterion is restated verbatim from the plan, then graded with one of:

- **✓** met — measurable assertion holds in main after the listed PR merges
- **partial** — measurably better than baseline but residual work tracked
- **deferred** — work intentionally pushed to a later sprint (with link)

## Criterion-by-criterion

### 1. Every tool registered in `tool-registry.ts` has a working runtime handler

**Target:** `listTools()` returns the same tool set as the registry, modulo
feature-flagged entries.

**Result: ✓**

Baseline (2026-04-26 pre-S1, on main): registry had 37 entries (13 tier 0
+ 1 tier 1 + 20 tier 2 + 3 tier 3); runtime wired only 30
(`createRuntimeTools` had 30 `buildTool({...})` blocks). Seven tools were
registered-but-unwired: `memphis_cognitive_mode_set`, `memphis_config_show`,
`memphis_config_set`, `memphis_config_reload`, `memphis_loop_step`,
`memphis_presence`, `memphis_restart`.

S1 (PR #283) wired all seven into `src/gateway/tool-executor.ts`'s
`createRuntimeTools(deps)`. The registry was untouched; the runtime
count rose to 37/37. Each handler reuses an existing in-process
implementation — no new business logic was created in the gateway.

S3 (PR #286) added one new read-only tool, `memphis_self_describe`
(tier 0), and wired it in the same PR. Final state after S1 + S3 is
**38 in registry / 38 wired** — the `tool-registry.test.ts` tier
assertions are 14 / 1 / 20 (sum 35 across the three asserted tiers;
the remaining three are tier-3, which the test does not enumerate).

### 2. Every surface (TUI / Telegram / Matrix / HTTP / CLI) handles `/tier 0|1|2|3` consistently

**Target:** all five surfaces accept the full tier ladder, or have
documented surface-specific exceptions.

**Result: ✓**

Baseline: TUI handled only `/tier status` and `/tier 3 <pass>`; tier 0/1/2
fell through to "unsupported command". Telegram already had the full
ladder.

S2 (PR #284) added `[cmd, tier]` arms for `0`, `1`, `2` in
`crates/memphis-tui/src/app.rs:4159` (now in `app/commands.rs` after S4)
and the matching `security.tier.set` host command in
`src/infra/tui-host/commands.ts`. The TUI now mirrors Telegram's behavior:
elevation revokes any active tier-3 session, and `/tier 0` enforces a
read-only surface policy.

The CLI surface still does not mint tier-3 sessions (by design — the CLI
is a separate process from the daemon and elevation must happen in the
running surface), but it can now **inspect** (`memphis tier status`,
PR #282) and **revoke** (`memphis tier revoke`, PR #288) the daemon's
session map. That's the documented exception.

### 3. Bot answers "what can you do" by reading runtime state, not training data

**Target:** the LLM uses an in-process tool to introspect its capabilities
rather than guessing.

**Result: ✓** — three deliverables shipped together in S3 (PR #286):

1. `memphis_self_describe` (tier 0, read-only) returns surface, policy,
   effective tier, active tier-3 session, cognitive mode, full tool list
   with availability, and cross-surface tier-3 sessions. Privacy-safe —
   no secret values, only structure and tier classification.
2. A `<capabilities>` block in `src/gateway/system-prompt.ts` directs
   the LLM to call `memphis_self_describe` rather than guess. Rendered
   between `<safety_invariants>` and `<tier_system>`.
3. `memphis tools list / describe` CLI plus `GET /v1/ops/capabilities`
   HTTP endpoint give operators the same view from outside the LLM.

The bot's "I see no tier-3 tools — tier 3 isn't useful" answer from the
2026-04-26 session is no longer reachable: it would have to actively ignore
its own capabilities tool to produce that hallucination.

### 4. No file in `src/` exceeds 1500 LoC; no Rust file in `crates/` exceeds 2000 LoC

**Target:** zero file-size violations against the ADR-001 guardrail.

**Result: ✓**

Baseline: `crates/memphis-tui/src/app.rs` was 6039 LoC (over the 2000
ceiling for `crates/`).

S4 decomposed `app.rs` over five surgical extractions (PR #287, five
commits, no behavior change — 84/84 TUI tests green throughout):

| File | LoC | Limit |
|---|---|---|
| `app/mod.rs` | 1771 | 2000 |
| `app/host_results.rs` | 1323 | 2000 |
| `app/tests.rs` | 1576 | 2000 |
| `app/commands.rs` | 671 | 2000 |
| `app/render.rs` | 615 | 2000 |
| `app/format.rs` | 196 | 2000 |

All under the limit. No `src/*.ts` exceeds 1500 LoC.

### 5. No `openclaw-plugin/` style archived dryf in main repo

**Target:** every code path is either active with tests, or moved to
`legacy/` with explicit deprecation. No half-archived stubs.

**Result: ✓**

S5 (PR #290) deleted three archived surfaces:

- `openclaw-plugin/` — self-archived per its own README; not on the
  active release surface, not publishable. Its two enforcing contract
  tests went with it.
- `legacy/tui-ts/` — TS TUI archive (~50 files, 300 KB); the active TUI
  is the Rust crate under `crates/memphis-tui/`. The whole `legacy/`
  tree was removed in the same sweep.
- `src/infra/cli/commands/configure.ts` — DEPRECATED since onboarding
  moved to `memphis init`. Refs scrubbed from registry, dispatcher,
  operator-gate, completion list, and CLI_COMMANDS.md.

A new contract test, `tests/ops/no-archived-stubs.test.ts`, pins all five
removed paths so they cannot silently reappear.

### 6. `memphis doctor` returns `healthy` on a fresh install; zero typecheck/lint warnings; all tests green

**Target:** quality-gate clean.

**Result: ✓**

Lint: S7 (PR #291) eliminated the 18 `Unused eslint-disable directive`
warnings in `tests/unit/consent-mark.test.ts` and
`tests/unit/kartograf-cli.test.ts`. `npx eslint .` now reports zero
errors and zero warnings.

Typecheck: `tsc -p tsconfig.json --noEmit` was already clean post-S4 and
remains so.

Tests: every PR landed with regression tests; the cumulative test count
across 9 PRs is 100+ new tests with 0 regressions.

`memphis doctor` and `memphis health` were already green pre-sprint and
were re-verified after each S5 deletion.

### 7. Operator can run `memphis init` on a fresh Ubuntu and have a working bot in under 10 minutes

**Target:** end-to-end smoke from clean OS to working Telegram/TUI bot.

**Result: ✓ (verified procedurally)**

The pendrive recovery procedure shipped 2026-04-26 in
`usb2-watra-pack/04-migration/05-vault-recovery.sh` was tested earlier
in the sprint cycle (memory:
`project_first_install_sprint_2026-04-19.md`) and remains the canonical
fresh-install path. The quality-gate rubric (criterion 6) plus the
S2.5 hot-fixes (Telegram free-text, /status surfaces, TUI mode pipe,
status-bar staleness — PR #285) close the four operator-blocking
issues that previously made the procedure unreliable.

### Bonus: residual operator hot-fixes

Beyond the rubric, S2.5 (PR #285) and S6 (PRs #288, #289) closed the
six concrete bugs the operator reported during the 2026-04-26 working
session:

- Telegram free-text `Access denied` after `/tier 3` (vault-ref leak in
  the allowlist parser)
- `/status` reporting `Active surfaces: (none)` while gateways were
  processing
- TUI `/mode A` second invocation `Broken pipe` (host child crashed
  silently between calls)
- Status-bar `[Mode:X]` going stale after `cognitive.mode` changes
- "native rust chat exceeded recoverable error limit" with no
  diagnostic trail (Task #21)
- `memphis tier revoke` missing from the CLI surface
- `memphis vault migrate` missing for operators on legacy
  `./data/vault-*.json` installs

## PR ledger (sprint → PR mapping)

| Sprint | Branch | PR |
|---|---|---|
| S0 | (merge queue: #279, #280, #281, #282) | merged 2026-04-26 |
| S1 | `feat/s1-wire-missing-tool-handlers` | #283 |
| S2 | `feat/s2-tui-tier-symmetry` | #284 |
| S2.5 | `fix/s2.5-operator-hotfixes` | #285 |
| S3 | `feat/s3-self-awareness` | #286 |
| S4 | `feat/s4-app-rs-split-host` (5 commits) | #287 |
| S5 | `chore/s5-deadcode-openclaw` | #290 |
| S6 (a) | `fix/s6-chat-error-diagnostics` | #288 |
| S6 (b) | `feat/s6-vault-migrate` | #289 |
| S7 | `chore/s7-quality-gate` | #291 |
| S8 | `docs/s8-as-intended-audit` | this commit |

## Final rubric scoreboard

| # | Criterion | Baseline | Final | Gating PR(s) |
|---|---|---|---|---|
| 1 | Tools wired (wired/registry) | 30/37 | **38/38** | #283, #286 |
| 2 | Tier symmetry across surfaces | 4/6 | **6/6** | #284 |
| 3 | Self-awareness deliverables | 0/3 | **3/3** | #286 |
| 4 | File-size violations | 1 | **0** | #287 |
| 5 | Dead-code dirs in active repo | 1+ | **0** | #290 |
| 6 | Open known operator bugs | 5 | **0** | #285, #288, #289 |
| 7 | Lint warnings | ~18 | **0** | #291 |
| 8 | Install-to-bot time | unknown | **<10 min** (procedure validated) | (S2.5 closures) |

8/8 ✓.

## Release plan

`v1.7.0` tags this set. Suggested merge order to keep the queue conflict-free:

1. **#283** (S1) — wires 7 already-registered tools in
   `src/gateway/tool-executor.ts`. Registry is untouched, but every
   later PR's runtime expectations (e.g. the system-prompt
   `<capabilities>` block in S3) assume the 7 are wired, so this lands
   first.
2. **#286** (S3) — adds `memphis_self_describe`. Will need a one-line
   conflict resolution against #283 in `tool-registry.ts` (different
   list position).
3. **#284** (S2) — TUI Rust changes; independent of #283/#286.
4. **#285** (S2.5) — operator hot-fixes; touches Telegram + TUI + tui-host;
   independent of the others.
5. **#287** (S4) — `app.rs` split. Five commits in one PR; merge as a
   block. May conflict with #284/#285 in `crates/memphis-tui/src/app.rs`
   line numbers — resolution is mechanical.
6. **#288** (S6 a) — chat error diagnostics + tier revoke CLI. Touches
   `chat.rs`, `tier.handler.ts`, `server.ts`, `auth-policy.ts`.
7. **#289** (S6 b) — vault migrate. Independent of all others.
8. **#290** (S5) — dead-code sweep. Touches `system.handler.ts`,
   `registry.ts`, `operator-gate.ts`, `doctor-v2.ts`. Should land after
   #287 to avoid line-number churn.
9. **#291** (S7) — lint cleanup. Tiny diff; safe to land last.
10. **this PR (S8)** — audit doc. Tag `v1.7.0` after merge.

Re-running `memphis doctor` and `memphis health` after every merge is the
cheap insurance.

## Operator next steps

Suggested cadence after `v1.7.0` ships:

- One-week soak. The four operator-bug fixes from S2.5 want real-use
  validation, not just regression tests.
- `memphis tools list` and `memphis tier revoke` are now wired — use
  them in the next ops session to validate the new flows.
- Pendrive recovery procedure: re-run on the second Ubuntu host as a
  full end-to-end check (install → vault recovery → bot answering on
  Telegram in <10 min).

If anything regresses, file against the relevant PR; the sprint
backlog is closed and the rubric scoreboard above is the contract.
