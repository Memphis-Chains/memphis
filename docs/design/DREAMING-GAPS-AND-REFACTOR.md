# Dreaming — the gaps that remain, and the refactor that makes it work

**Status:** design, measured 2026-11-03 on this host.
**Predecessors:** `docs/design/DREAMING.md` (the mechanism), #730 (D1, corpus),
#731 (the measurement refresh), #732 (D2, the deterministic signals).

---

## 0. Why this document exists

D1, the measurement refresh and D2 are shipped. The mechanism still cannot do
the thing it exists for. A signal is computed and then goes nowhere: there is
no chain to hold it, no gate to accept it, no way to roll it back, and no
provenance to say what it was based on. On top of that, the runtime has two
different opinions about what an error is, and the one that is wired into the
telemetry is the weaker of the two.

This document names each gap with the measurement that proves it, designs the
fix, and orders the work so that no stage is dead code and no stage lands
before the thing it depends on.

---

## 1. The gaps, measured

### G1 · Two opinions about what an error is

`classifyToolOutput` (`src/infra/observability/instrument.ts:36`) reads
`error` / `ok:false` / `blocked:true`. The corpus classifier
(`src/cognitive/dreaming/corpus.ts`) reads those **plus** `exitCode != 0`
**plus** `status:'error'`. On the live corpus, over 8 437 tool results:

| rule                      | failures | rate   | over the SLO threshold (5 %)? |
| ------------------------- | -------- | ------ | ----------------------------- |
| `instrument` (today)      | 167      | 1.98 % | no                            |
| `exitCode` (what D2 uses) | 434      | 5.14 % | **yes**                       |
| `noisy` (proposed)        | 301      | 3.57 % | no                            |
| the rule as implemented   | 308      | 3.65 % | no                            |

The two classifiers disagree on **267** results. The `exitCode` rule is not
merely stricter — it is **wrong**, and the corpus says why. Of those 267:

- **134** carry a real diagnostic on stderr — a node crash
  (`Error: ENOTDIR`), a shell syntax error (`sh: 1: Syntax error`), a Python
  traceback. These are failures, and today nobody sees them.
- **133** are silent non-zero exits, and the exit codes say what they are:
  `exit 1` × 106, `exit 2` × 16, `exit 127` × 6 (command not found),
  `exit 124` × 1 (timeout), `exit 60` × 1, `exit 255` × 1, `exit 7` × 1,
  `exit 3` × 1.

  `exit 1` is what the shell returns for _nothing matched_: `grep` with no
  hit, `diff` with no difference, `test -f` on a missing file. `exit 2` is
  `ls` on a path that does not exist. Those are **not** agent errors, and a
  classifier that counts them as such is measuring the wrong thing.

So the corpus contains two genuine mistakes inside the 133: `exit 127`
(command not found) and `exit 124` (timeout) are failures even with an empty
stderr. The rest of the silent non-zero exits are a third category: the shell
said no, and said nothing about why.

**The last row of the table is the one R1 implements.** The `noisy` row was
the rule measured on its own — envelope OR (non-zero exit AND stderr) — and
it does not catch the `exit 127` and `exit 124` cases. The rule in §2.1 does,
so it produces **308**, and `126` of the silent non-zero exits stay
`inconclusive` rather than being counted as failures.

**Closed by R1.** The classifier now lives in
`src/core/failure-classification.ts`, and both consumers read it.

### G2 · The runtime does not tell the agent about its own failed commands

`src/gateway/agent-runtime.ts:288` builds the "these tool calls failed, do not
claim success" summary that is pushed into the model's context before the
next turn. It counts errors with `classifyToolOutput`. Before R1 that summary
omitted every `exitCode != 0` failure — so **134 real failures never reached
the agent**, and the agent was told nothing about a command that crashed with
a traceback.

The same classifier is the confabulation detector's eye
(`src/infra/observability/confabulation-detector.ts:131`): an agent that
claims success after a tool error is only flagged if the tool result is an
error by `classifyToolOutput`. Measured over the 45 sessions: **1** success
claim follows a failure the detector cannot see, against 0 that it can. The
blind spot is real and demonstrable; it is also rare in this corpus, and
reporting it as rare is the honest way round.

The SLO rides on the same attribute. `tool_error_rate`
(`src/observability/slo-evaluator.ts:366`) counts `tool.call` spans with
`status=error` or `attrs['tool.output.shape'] === 'error'`, both of which come
from `classifyToolOutput`. Measured live over the last 24 h: **0.85 %**
against a 5 % threshold — `pass`, but only because the classifier is blind.
Adopting the `exitCode` rule as-is would put the rate at **5.14 %** and flip
the SLO to `fail` on the strength of 133 non-errors.

**Closed by R1.** The summary now names the exit code when the envelope
carries no error of its own, so `exit 127 (command not found)` and
`exit 124 (timeout)` reach the model. The confabulation detector is unchanged
on purpose: an `inconclusive` result is not a failure and not a
confabulation.

### G3 · A signal has nowhere to live

There is no `proposals` chain, no proposal lifecycle, no `memphis dream`
command. The D2 signals (`src/cognitive/dreaming/signals.ts`) produce 26
signals over the live corpus — 15 tool-failure clusters, 7 repeat loops, 1
correction, 3 no-progress — and every one of them ends at the process
boundary. (The repeat loops read 4 for one round: R1 changed what counts as
a failure, and the detector counted only loud failures until the operator
closed that blind spot — see §2.4.)

### G4 · The reflection loop cannot consume signals without an ungated write

`src/infra/runtime/reflection-loop.ts:174` writes to the soul memory and
nothing else. Wiring the deterministic tier into that loop would put every
signal into the agent's own identity narrative with no human in the loop —
the exact failure the design refuses in `DREAMING.md` §1. The detectors are
therefore not wired in, on purpose, and D3 is what gives them a home.

### G5 · No permissioning in production

The two write guards that exist are test-isolation tools, and say so:
`chain-write-guard.ts:18` — "Outside VITEST: never interferes. This is a
test-isolation tool"; `audit-write-guard.ts:37` — "Outside vitest, audit-write
is always allowed". Measured: in production any agent-initiated write may
target any chain, including `system`. There is no `org` / `shared` /
`personal` / `session` distinction.

### G6 · Memory writes carry no provenance

Measured on the newest decision block (`decisions/000480.json`): the data
carries `source` ('mcp'), `correlationId` ('mcp:mcp-mvzozzts'), `context`,
`title`, `choice`, `confidence`, `status` — and **no session id, no base
block hash, no reference to the evidence the decision was based on**. The
mechanism to fix it already exists (`extraData` on
`recordDecisionHistoryEntry`), so this is an additive change, not a schema
break.

### G7 · The merge fallback fires — hours late, not every 5 minutes

> **Correction, 2026-11-03.** The first version of this gap said the schedule
> never fires. It does. The correction is stated here rather than made quietly,
> because the original measurement and its error are both part of the record.

`automerge.yml` declares `cron: '7 * * * *'` — that is **hourly at minute 7**,
not "every 5 minutes", which is what a comment next to it claims. The schedule
does fire. Measured over the last 60 runs of the workflow (2026-10-30 14:08 →
2026-11-03 08:09 UTC):

| measurement                                | value           |
| ------------------------------------------ | --------------- |
| runs with `event=schedule`                 | **15**          |
| gaps between consecutive schedule runs     | 3.58 h – 9.76 h |
| mean / median gap                          | 5.95 h / 6.05 h |
| schedule runs that started at minute `:07` | **0 of 15**     |

The cron minute is never honoured — those runs started at minutes 14, 39, 24,
12, 39, 25, 00, 25, 58, 32, 30, 51, 36, 26, 35. GitHub queues scheduled
workflows and starts them when a runner is free, so a cron expression is a
request, not a promise. The cadence also degrades with the repository's own
load: the ten earliest gaps average 5.23 h, the four most recent average
7.77 h, and they follow the two heaviest run days in the window (24 runs on
2026-11-01, 20 on 2026-11-02).

**What actually merges a pull request** is the `workflow_run` trigger on `ci`
and `chain-invariant`: PR #733's merge commit landed at 08:09:22Z, **13
seconds** after the `workflow_run` event that woke the job at 08:09:09Z. The
schedule is the fallback that re-checks a green PR, and it now runs about
every six hours. `pull_request_target` fires on open and on every push, but
usually refuses because the required checks are still running.

**The operational consequence** is narrow and real: a pull request that goes
green without a `workflow_run` wake-up waits up to about ten hours for the
next scheduled attempt, and the manual trigger
(`gh workflow run automerge.yml --ref main`) stays as the on-demand fence.
Operational, not architectural — no stage of R1–R5 depends on it, and none is
delayed by it.

**How the original measurement went wrong.** It was
`gh run list --workflow automerge.yml --limit 6`, whose six rows covered
2026-11-02 19:46 → 20:28 — a window that fell entirely inside the 7 h 50 m
gap between the 15:36 and the 23:26 schedule runs. Six rows, no schedule run,
and the absence was written down as a property of the workflow. The stale
"every 5 minutes" in `automerge.yml` is where the claim came from: it
described a cron with twelve minute values, which #674 replaced with a single
minute on 2026-10-11, and the comment was never updated.

---

## 2. The refactor: one opinion about failure

### 2.1 The rule

One module owns the question "did this tool result fail?", and every caller
imports it. It answers in four values, because the corpus shows all four
cases exist:

```ts
type FailureClassification = 'success' | 'failure' | 'inconclusive' | 'unknown';
```

| the result is  | when                                                                                                                                                                                                                                                                                                                             |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `failure`      | the envelope says so — `error` present, `ok:false`, `blocked:true`, `status:'error'` — **or** the process exited non-zero **and** wrote to stderr, **or** it exited with a code that cannot mean "nothing matched": `124` (timeout), `126` (not executable), `127` (command not found), `128+N` for a signal death (`129`–`192`) |
| `inconclusive` | the process exited non-zero and said nothing — the shell's "no match"                                                                                                                                                                                                                                                            |
| `success`      | exited zero, or the envelope says it worked                                                                                                                                                                                                                                                                                      |
| `unknown`      | the envelope did not parse — never counted as success                                                                                                                                                                                                                                                                            |

**Measured on the live corpus (2026-11-03, 8 437 results): 308 failures
(3.65 %), 126 inconclusive, 8 003 success, 0 unknown.** The 308 break down as
167 envelope failures + 134 non-zero exits with a diagnostic on stderr + six
`exit 127` + one `exit 124`. The 126 inconclusive are the silent non-zero
exits that CAN mean "nothing matched": 106 `exit 1`, 16 `exit 2`, and one each
of `exit 3`, `exit 7`, `exit 60` and `exit 255`.

Two corrections to this section, made by measurement rather than by argument:

- **The earlier text said 301 and 3.57 %.** That was the "noisy" rule
  measured on its own — envelope OR (non-zero exit AND stderr) — and it does
  not catch `exit 127` or `exit 124`. The rule in the table above catches
  them, so the number the rule produces is **308**, and the number the rule
  did not produce was 301. Both numbers were in this document, one sentence
  apart, describing the same thing.
- **`exit 255` is not a signal death.** The shell reports a signal as
  `128+N`, so the range is `129`–`192`; `128` is the shell's usage error and
  `255` is `ssh`'s own error code. One `exit 255` in this corpus IS a real
  failure (an `ssh` timeout whose diagnostic sits in stdout), and it stays
  `inconclusive`: the code alone cannot tell it apart from a generic
  non-zero exit. That is what the state is for — saying "the shell said no
  and gave no reason" instead of guessing.

One measured detail that changed the implementation: at `exit 127` the
shell's "command not found" lands in **stdout**, not stderr. A rule that
looked only at stderr would have called those six results inconclusive too.

### 2.2 Where it lives, and what moves

Not in `instrument.ts` and not in the corpus — a third copy is what the design
warned against. One module, imported by:

| call site                                                 | today                         | after                                                                                  |
| --------------------------------------------------------- | ----------------------------- | -------------------------------------------------------------------------------------- |
| `instrument.ts:50` `classifyToolOutput`                   | 2-valued                      | delegates to the shared module; gains `inconclusive`                                   |
| `agent-runtime.ts:492` span attribute `tool.output.shape` | `success`/`error`/`unknown`   | gains `inconclusive` — the span can now say "the shell said no and gave no reason"     |
| `agent-runtime.ts:497` span status                        | `error` when classified error | unchanged                                                                              |
| `agent-runtime.ts:288` the agent's error summary          | 167 failures today            | 308 — the agent finally hears about its 134 real diagnostics and the `127`/`124` cases |
| `confabulation-detector.ts:131`                           | `=== 'error'`                 | unchanged: `inconclusive` is not a failure and is not a confabulation                  |

**Nothing else changes**, and that is the point of listing it:

- **The SLO threshold stays at 5 %.** Measured over the live corpus: the new
  rule gives **308 failures in 8 437 tool results (3.65 %)**, against 434
  (5.14 %) for the naive `exitCode` rule — which would flip the SLO on the
  strength of results that are fine. Over the last 24 h of the same corpus
  (644 results) it gives **8 failures (1.24 %)**, against 10 (1.55 %) under
  the naive rule. The live SLO report reads 0.85 % today because the running
  runtime still has the old classifier and recorded its spans with it; the
  live number moves when the runtime picks up this build.
- **The halt budget does not move, because it never depended on this
  classifier.** Measured: `crates/memphis-operator/src/chat.rs:783` increments
  the error counter **only in the `Err` branch** — a tool execution that
  threw. `exitCode` does not appear in `chat.rs` at all (0 hits). The Rust
  core counts exceptions; the TypeScript classifier counts envelopes. They
  were never connected, and this refactor does not connect them.
- **The D2 clusters do not change: still 15.** Measured over the same corpus:
  all three rules produce the same **15** tool-failure clusters, because the
  difference is volume on `memphis_exec` (124 under `noisy`, 257 under
  `exitCode`, 167 under `instrument`) and 3 % and 2 % are both "low" severity.
  The D2 module reads the same shared classifier for one reason only: one
  answer, not two.
- **The D2 repeat-loops DO change: 7 → 4, and the reason is the point.**
  The three that disappear are the "no match" family — `pkill` with nothing
  to kill, a `grep -c pending` that finds no pending PR, `ls` on a path that
  does not exist. They are no longer failures, so they are no longer
  _failure_ loops. Two of them are real waste — an agent polling a queue 55
  times per call, four times over — so the detector now has a blind spot it
  did not have. **This is a D2 decision, not an R1 one:** the fix is to count
  "the same call, not succeeding again and again" instead of "failing again
  and again", which changes what a repeat-loop signal means and belongs to
  the operator. R1 changes the classifier, not the detectors.
  **The operator has made that decision** — §2.4 records it, the rule it
  chose, and the measurement that closed the blind spot.

### 2.3 Migration

1. Add the shared module with the rule above and its unit tests — including
   the corpus cases as fixtures: a node crash (failure), a `grep` that found
   nothing (`inconclusive`), a `command not found` (failure), an unparseable
   envelope (`unknown`).
2. Point `classifyToolOutput` at it and keep its old name and its old
   two-valued contract for callers that test `=== 'error'`.
3. Re-run the SLO report and the D2 runner; both must stay green, and the
   tool-error rate must land inside 5 %.

**Falsifier, as run:** over the live corpus, the shared classifier yields
**308 failures** (3.65 %, inside the 5 % threshold) and **126 inconclusive**;
the agent's error summary names the `exit 127` and `exit 124` cases — the two
the previous rules disagreed about; the D2 tool-failure-cluster count is
**unchanged at 15**; and the D1 invariants hold (every envelope parsed, the
wrapper split holds, the join is 1:1).

### 2.4 The blind spot R1 left, and what the operator decided about it

R1 changed what a failure is. The S2 detector counted failures, so the
three loops that are silent rather than loud stopped being loops — and two
of them were waste worth naming: an agent that polled a PR queue 55 times
per call, four times over, and an agent that killed a process that kept
coming back.

**The decision (operator, 2026-11-03): variant A.** A loop is a pattern of
waste, and waste does not need a diagnostic to be waste. The detector counts
everything that did NOT succeed — a loud failure and a silent non-zero exit
alike — while still counting the two kinds apart, so the summary can say
which one it was.

| variant         | rule                                   | loops on the live corpus |
| --------------- | -------------------------------------- | ------------------------ |
| C — leave it    | `failure >= 2`                         | 4                        |
| **A — chosen**  | `failure + inconclusive >= 2`          | **7**                    |
| B — two classes | `failure >= 2` and `inconclusive >= 2` | 4 + 3                    |

**Measured before the code was written** (live corpus, 8 437 tool results,
45 sessions, 17 132 turns; the grouping key is tool + normalized arguments,
the same key the detector uses):

| measurement                                                  | value                    |
| ------------------------------------------------------------ | ------------------------ |
| loops before → after                                         | 4 → **7**                |
| groups holding both kinds (a loud failure and a silent exit) | **0 of 8 232**           |
| calls the new rule adds                                      | 11 (of 126 inconclusive) |
| added groups whose successes outnumber their non-successes   | 0                        |
| tool-failure clusters                                        | unchanged at 15          |

The zero in row two is what makes A and B the same measurement today: no
group on this corpus mixes a loud failure with a silent exit, so A and B
report the identical set of seven loops and differ only in what they call
them. A was chosen because it is one rule and one signal kind, where B
would add a second kind, a second severity scale, and a second variant of
the proposal payload that R2 has to carry.

**The three loops that came back** (all silent — a non-zero exit with
nothing on stderr):

| loop                                             | occurrences | severity | what it was                                                          |
| ------------------------------------------------ | ----------- | -------- | -------------------------------------------------------------------- |
| `pkill -f basal_cpu 2>/dev/null; true`           | 5           | high     | the agent killed a process that kept coming back                     |
| `gh pr checks 682` polled in a loop of 55 rounds | 4           | medium   | the agent polled a queue 55 times per call, four times over          |
| `python3 svg2png.py ... ; ls -l /tmp/w*.png`     | 2           | low      | a conversion script re-run after an error — the weakest of the three |

**What changed in the code**

- `src/cognitive/dreaming/signals.ts` — the threshold counts everything that
  did not succeed; `failures` and `inconclusive` are counted apart, and the
  summary names which one it was ("failed loudly" / "without saying why").
- `tests/unit/dreaming-signals.test.ts` — four cases: two silent exits are a
  loop, one is not, successes do not count toward the threshold, and a loud
  failure plus a silent exit is one loop that names both kinds.
- `scripts/dream-signals.mts` — a **second verdict**. The loops the corpus
  contains are recounted from the raw rows, without asking the detector
  anything, and the two must agree on every loop and every count. Under the
  old rule this verdict fails: 7 in the corpus, 4 reported.
- `docs/design/DREAMING.md` — S2 described as "the same call, not succeeding
  again".

**Falsifier, as run:** `npm run -s ops:dream-signals` prints 15
tool-failure clusters, **7** repeat loops, 1 correction, 3 no-progress; the
independent recount finds 7 loops in the corpus, the detector reports 7, and
none is missed, invented or miscounted. The unit suite is 21/21 for
`dreaming-signals`; the full pool is 4 626 passed / 4 skipped across 669
files, with `tsc`, `eslint`, `prettier`, `knip`, `pii-scan`, `secret-scan`
and `default-secret-scan` clean.

---

## 3. The build

Five stages. Each one is independently mergeable, none is dead code, and
each carries its own falsifier.

| stage  | delivers                                                                                                   | closes | falsifier                                                                                                                                                                                                                                     |
| ------ | ---------------------------------------------------------------------------------------------------------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **R1** | one shared failure classifier; `instrument.ts` delegates to it; the S2 loop rule the operator chose (§2.4) | G1, G2 | over the live corpus: 308 failures and 126 inconclusive, rate < 5 %, the agent summary names the `127`/`124` cases, the D2 cluster count is unchanged at 15, and the repeat-loop count is 7 with an independent recount of the corpus's loops |
| **R2** | `proposals` chain + proposal lifecycle + `memphis dream list/show` + `memphis dream propose`               | G3     | the real corpus yields proposals that each carry evidence and prevalence; `memphis dream list` shows them with their evidence                                                                                                                 |
| **R3** | the operator gate: accept / reject on tier 2, apply with provenance, rollback                              | G3, G6 | end-to-end on this runtime: an accepted proposal lands in its target carrying `basedOn`; rollback restores the prior state; the agent cannot accept one                                                                                       |
| **R4** | provenance on memory writes (`basedOn`: session ids + base block hashes)                                   | G6     | a memory write made from a session records the session id and the hash of the block it was based on; a write made outside any session says so                                                                                                 |
| **R5** | runtime write policy by scope: `org` / `shared` / `personal` / `session`                                   | G5     | mutation: an agent-initiated write to an operator-only scope is refused, and the refusal lands in the audit chain                                                                                                                             |

**Order and why.** R1 comes first because it is the only stage that changes
what the runtime already measures, and every later stage inherits its answer
— a proposal that counts a silent `grep` as a failure is a proposal built on
the same mistake. R2 before R3 because a gate needs something to gate; R3
before R5 because a scope policy without a proposal object has nothing to
scope. R4 runs alongside R3: it is the same write path, and a gate that does
not record what it was based on reproduces the very gap the talk names as
principle #1.

### 3.1 R2 in detail: what a proposal is

The chain, its blocks and its lifecycle, per `DREAMING.md` §3.5:

```ts
type ProposalStatus =
  | 'pending'
  | 'accepted'
  | 'rejected'
  | 'applied'
  | 'failed'
  | 'expired'
  | 'superseded';

type Proposal = {
  id: string;
  kind: 'memory.add' | 'memory.update' | 'memory.retire' | 'org.directive';
  status: ProposalStatus;
  target: { scope: string; id?: string; field?: string };
  patch: unknown;
  evidence: Array<{ sessionId: string; sequence: number; quote: string; toolName?: string }>;
  prevalence: { occurrences: number; sessions: number; spanDays: number; denominator: number };
  confidence: number;
  rationale: string;
  proposer: 'dreaming' | 'agent' | 'operator';
  basedOn: { sessionIds: string[]; chainBlockHashes: string[] };
  createdAt: string;
  decidedAt?: string;
  appliedAt?: string;
};
```

**A proposal without evidence is invalid.** That is the rule that keeps the
mechanism from becoming a machine that rewrites memory on a hunch, and R2's
falsifier is exactly that: every proposal the real corpus yields carries
evidence and prevalence.

Four rules that the chain mechanics force, measured rather than assumed:

- **The chain needs two registrations.** `CHAIN_CATALOG`
  (`src/memory/chain-catalog.ts:63`) for the taxonomy, and
  `DEFAULT_CHAIN_ALLOWLIST` (`src/infra/storage/chain-adapter.ts:118`) —
  a chain outside that list is skipped by the integrity scanner, which is
  the guard that keeps a sidecar writer from crashing memphis at boot with
  `invalid block shape`. Chain directories are created on demand
  (`chain-adapter.ts:302`).
- **The Rust core adds a third constraint, and it is the hard one.**
  `crates/memphis-core/src/block.rs:5` defines `BlockType` as a **closed**
  serde enum: a block whose `data.type` is not one of its variants does not
  deserialize at all. Measured on this host, where `RUST_CHAIN_ENABLED=true`
  makes every append go through the Rust core:

  ```
  chain_validate(<block with type autonom_publication>)
    → invalid_block_json: unknown variant `autonom_publication`
  chain_validate(<block with type proposal>)
    → invalid_block_json: unknown variant `proposal`
  chain_validate(<block with type system_event>)
    → parses (only the hash differs — the type was changed after signing)
  ```

  This is not hypothetical: `autonom_archive` on this disk holds exactly one
  block, of type `autonom_publication`, and the native `chain_query` over it
  fails with `invalid_chain_json` — while `memphis chain verify` reports
  `ok: true, chainsChecked: 10, blockCount: 22477`, because
  `verifyChainIntegrity` (`chain-adapter.ts:906`) reads the blocks itself and
  never asks the Rust core. The two verifiers disagree about what a valid
  block is, and only one of them is the one that writes.

  The consequence for R2 is concrete: `chain_append` parses the **whole
  chain** before appending, so a chain holding one block with an unknown type
  refuses the next append. A `proposals` block therefore has to carry a type
  the Rust core knows, and the repo's own convention is already written down
  (`block.rs:19`): _"New writes use `system_event` with the original semantic
  name in the `kind` field of the data payload."_ So a proposal block is
  `data.type = "system_event"` with `data.kind = "dreaming.proposal"` — not a
  new `"proposal"` variant. Extending the enum instead is a `crates/**`
  change: Tier 2, and out of R2's scope.

- **The payload has to live in `content`, not in sibling fields.** The block
  hash covers `type`, `content` and `tags` only — on the Rust side
  (`compute_hash`, `crates/memphis-core/src/hash.rs:5`) and on the TypeScript
  side (`toCanonicalHashData`,
  `src/infra/storage/rust-chain-adapter.ts:181`). Extra `data` fields are
  persisted — the adapter merges the TypeScript payload back over the
  Rust-serialized block (`rust-chain-adapter.ts:340`) — but they sit **outside
  the hash**: change them and the chain still verifies. A proposal's evidence,
  prevalence and `basedOn` would be mutable without detection if they lived
  in sibling fields. `normalizeData` (`rust-chain-adapter.ts:160`) already
  does the right thing: with no `content` string passed, it sets
  `content = JSON.stringify(data)`, so the whole payload is hash-covered. R2
  writes proposals that way.
- **The catalog test asserts the count.** `tests/unit/chain-catalog.test.ts:19`
  expects 12 chain names. Adding `proposals` makes it 13, and the test has
  to say so — the count is the contract, not an accident.

The lifecycle follows the pattern already in the repo
(`src/core/decision-lifecycle.ts:23`): an `ALLOWED` map of legal
transitions, and a transition that is not in the map throws. No new idea
needed, and the same shape as `DecisionStatus` means the operator learns one
state machine, not two.

### 3.2 R3 in detail: the gate

| action          | who             | tier | writes                            |
| --------------- | --------------- | ---- | --------------------------------- |
| propose         | agent, operator | 0    | a `pending` proposal              |
| list / show     | anyone          | 0    | nothing                           |
| accept / reject | operator only   | 2    | a status transition + `decidedAt` |
| apply           | agent, operator | 0    | the change, carrying `basedOn`    |
| rollback        | operator        | 2    | a compensating block              |

**The agent may propose and may apply. It may not accept.** That separation
is the gate; everything else in R3 is mechanics around it. An accept on tier
2 is the one action in the whole mechanism that needs the operator's
passphrase, because it is the one that changes what the agent will believe
about itself.

`memory.update` is not a rewrite: the chains are append-only, so an update is
a new block that references and supersedes the old one. `memory.retire` writes
a block that marks the entry retired, with a reason. Memory is never silently
deleted — the same rule the chain itself already follows.

### 3.3 R5 in detail: the scopes

| scope                              | read             | write                                       |
| ---------------------------------- | ---------------- | ------------------------------------------- |
| `org` — organizational directives  | every agent      | operator only, through an accepted proposal |
| `shared` — project / cross-section | every agent      | accepted proposals                          |
| `personal` — soul, journal         | operator + agent | agent allowed                               |
| `session` — scratchpad             | that session     | agent freely                                |

Implemented as a runtime write policy with an explicit `writer` scope, so
runtime-internal writes (bootstrap, heartbeat, scheduler) are unaffected. The
existing VITEST-only guards stay as they are: they are test isolation, not a
production policy, and the design says so.

---

## 4. Risks, and what would kill this

| risk                                                                 | mitigation                                                                                                                                                                                                  |
| -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| the shared classifier changes what the SLO reports                   | the rate is measured, not assumed: 0.85 % live today, 3.65 % over the whole corpus and 1.24 % over its last 24 h under the new rule — all inside the 5 % threshold, and the threshold itself is not touched |
| an agent writes to a scope it should not                             | R5's falsifier is a mutation test: the refusal is observable in the audit chain                                                                                                                             |
| proposals pile up unaccepted                                         | `expired` exists in the lifecycle for exactly this; the count is visible in `memphis dream list`                                                                                                            |
| the mechanism becomes a machine that rewrites memory on a hunch      | a proposal without evidence is invalid, and the accept action is tier 2                                                                                                                                     |
| the whole thing is over-built for one host                           | each stage is independently mergeable and independently falsifiable; D1 and D2 already ship value with no operator action at all                                                                            |
| the analyzer tier is funded before the deterministic tier is trusted | D5 stays out of scope until R2 and R3 are on the runtime and have produced proposals a human accepted                                                                                                       |

**The falsification test for the whole design.** Run the deterministic tier
over the real corpus, turn the signals into proposals, and hand them to the
operator without explanation. If the operator says "yes, that is a real
problem I did not notice", the mechanism works. If the operator says "that is
obvious", the deterministic tier is earning nothing and the LLM tier (D5)
should not be built on top of it.

---

## 5. What this document does not decide

- **D5, the LLM analyzer.** It depends on R2 and R3 being on the runtime, and
  its budget, sampling and steering file are a separate design. The
  deterministic tier has to earn its keep first.
- **The cost model.** What a dreaming run costs against what it saves is
  unmeasured on this host, and the energy homeostat has no input for it yet.
- **Whether `org` directives should live in the `proposals` chain or in
  their own.** R5's scope table assumes the former; the audit chain is the
  other candidate, and the difference matters for search.
