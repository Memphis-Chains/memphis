# Dreaming — Memphis as a self-improving memory system

**Status:** design, measured 2026-11-02 against this host
**Origin:** AI Native DevCon LDN talk by Lamis (Anthropic, Applied AI),
"context engineering & dreaming" + Mazur's cybernetic theory of
self-regulating systems.

This document is a design, not a report. Every number in it was measured
on this host; every claim about what Memphis does today was read out of
the code, not out of memory.

---

## 1. The problem, measured

Memphis has a reflection loop (`src/infra/runtime/reflection-loop.ts`) and
a meta-cognitive model (`src/cognitive/model-e.ts`). That is the closest
thing we have to what the talk calls "dreaming".

It is blind to most of the evidence.

**What the reflection loop reads** (`loadCognitiveBlocks`,
`src/cognitive/runtime-support.ts:31`): the `journal`, `decisions`,
`reflections` and `cases` chains.

**What it never reads:** the conversations themselves.

|                                                    |                                                                  |
| -------------------------------------------------- | ---------------------------------------------------------------- |
| messages in `operator_chat_messages`               | **17 132**                                                       |
| sessions                                           | **45**                                                           |
| span                                               | 2026-09-29 → 2026-11-02                                          |
| user turns                                         | 593                                                              |
| assistant turns                                    | 8 102 (median content 81 chars)                                  |
| tool results                                       | 8 437                                                            |
| tool calls with full arguments (`tool_calls_json`) | **8 437** — a perfect 1:1 join to the results via `tool_call_id` |

Re-measured 2026-11-02 20:45 CET against the live database. The corpus
keeps growing, so these are a dated snapshot, not a live total:
`npm run -s ops:dream-falsifier` prints the current numbers next to the
invariants that hold regardless of growth (the 1:1 join, the wrapper
split, the parse rate).

So the richest signal we own — _what the agent actually tried, with which
arguments, and what came back_ — is completely outside the loop that is
supposed to learn from experience.

**And the insights it does produce are heuristic, not semantic.**
`extractInsights` (`src/cognitive/model-e.ts:259`) counts peak hours, tag
frequencies and decision types. There is no LLM anywhere in the reflection
path (`grep -rn "provider|llm|complete" src/cognitive/insight-generator.ts
src/cognitive/model-e.ts` → 0 hits). It can tell you that you work most
at 19:00. It cannot tell you that every tool call in the last three weeks
used the wrong flag, because that requires reading what the tool returned.

**Two further gaps, both measured:**

- **No gate.** The loop calls `updateSoulMemory` directly
  (`src/infra/runtime/reflection-loop.ts:174`). A heuristic insight lands
  in the agent's own identity narrative with no human in the loop. The
  talk is explicit that this is the thing production memory systems need
  guardrails around: _"you have to have a lot of guardrails in place to
  make sure that these nice autonomous memory systems actually work in
  production."_
- **No provenance.** Decisions carry `source: "operator-tui"`
  (`src/core/decision-history-store.ts:34`) — a string naming the surface.
  They do not carry _which session_, _which transcript_, _which block
  hash_ the decision was based on. The talk names this as the first
  production principle: _"what context was this update based on? So which
  agent session, which transcript, resulted in me wanting to make this
  update."_ We have the hash chain — we just don't use it for this.

**And permissioning is theatre.** The two write guards that exist
(`src/infra/storage/chain-write-guard.ts`,
`src/infra/logging/audit-write-guard.ts`) both return "allow" outside
VITEST. In production any agent may write to any chain. Agent _tools_
happen to target fixed chains today (`journal`, `decisions`, `cases`,
`soul`), so there is no live exploit — but the policy that the talk calls
principle #3 does not exist.

---

## 2. What the talk actually prescribes

Four production principles, plus the mechanism itself.

| principle         | meaning                                                                       | Memphis today                                                                                                          |
| ----------------- | ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| **versioning**    | keep versions; roll back a bad update; record what it was based on            | partial — 8-deep backup ring on `soul-memory.json`, chain rotation + snapshots; **no provenance**                      |
| **concurrency**   | hash → draft → hash; refuse the write if the world moved                      | **stronger than the talk** — hash chain _plus_ write serialization (`withChainWriteLock`, `ChainWriteLock` via SQLite) |
| **permissioning** | org-wide context read-only; agent scratchpad writable; many levels in between | **missing** — guards are VITEST-only                                                                                   |
| **portability**   | curation lives in a clean API, reachable from many systems                    | present — plain files, MCP-readable, hash-chain format is standard                                                     |

The mechanism — _dreaming_ — is defined precisely:

> Take a memory store + a batch of transcripts. Give them to an agent.
> It identifies patterns where the memory could be uplifted. It outputs a
> **new memory store**. Each proposal comes with **examples of the
> transcripts** where the pattern was noticed and **stats on how prevalent
> it is**. A human decides which changes to accept.

Three properties of that mechanism matter more than the rest:

1. **Out of band.** Its own allocated resources, running in batch. It
   competes with nothing.
2. **It sees the tool traffic, not just the dialogue.** _"We're not just
   looking at the passes between agent and system or the user, but also
   really scrutinizing those tools and all of the other metadata."_
3. **The output is a proposal, not a write.** The human is in the loop.

We have (2) as data and not as capability. We have (3) inverted: we write
straight through.

---

## 3. Design

### 3.1 The shape

```
                 transcripts + chain blocks
                            │
                    ┌───────▼────────┐
                    │  DREAMING CORPUS│  deterministic, no LLM, no tokens
                    └───────┬────────┘
                            │
              ┌─────────────┴─────────────┐
              │                           │
     ┌────────▼────────┐        ┌─────────▼─────────┐
     │ DETERMINISTIC   │        │  LLM ANALYZER     │  sampled, budgeted,
     │ SIGNALS         │        │  (steered)        │  out of band
     │ always on, free │        └─────────┬─────────┘
     └────────┬────────┘                  │
              └─────────────┬──────────────┘
                            │
                   ┌────────▼─────────┐
                   │    PROPOSALS     │  chain = hash-linked, auditable
                   │ evidence + stats │  status: pending → accepted/rejected
                   └────────┬─────────┘
                            │  operator gate (tier 2)
                   ┌────────▼─────────┐
                   │      APPLY       │  provenance + rollback
                   └──────────────────┘
```

### 3.2 Corpus — what dreaming sees

New module `src/cognitive/dreaming/corpus.ts`, fed by a repository over
`operator_chat_messages`.

```ts
type DreamingTurn = {
  sessionId: string;
  sequence: number;
  at: string;
  role: 'user' | 'assistant' | 'tool';
  text: string; // wrapper-stripped
  toolName?: string;
  toolCallId?: string;
  provider?: string;
  model?: string;
  calls?: Array<{ id: string; name: string; args: unknown }>;
};
```

Two requirements that only measurement would have produced:

- **Strip the wrappers.** Every user turn is `<user_input>…</user_input>`;
  every tool result is `<tool_output tool="…">…</tool_output>`. A text
  detector that does not strip them is matching the wrapper, not the
  speech. (Measured: 593/593 user turns wrapped, 8 437/8 437 tool results
  wrapped, 0/8 102 assistant turns wrapped.)
- **Join calls to results by `tool_call_id`.** The call's name and
  arguments live on the _assistant_ row (`tool_calls_json`); the outcome
  lives on the _tool_ row. There is exactly one of each id — 8 437 to
  8 437.

The corpus builder is a pure function over a repository. It is
deterministic and costs no tokens; it can run on every reflection tick.

### 3.3 Signals — the deterministic tier

Always on, no LLM, no tokens. Each detector emits the same shape, so
they compose:

```ts
type DreamingSignal = {
  id: string;
  kind: 'tool-failure-cluster' | 'repeat-loop' | 'correction' | 'no-progress' | 'stale-memory';
  severity: 'low' | 'medium' | 'high';
  summary: string;
  evidence: Array<{ sessionId: string; sequence: number; quote: string }>;
  prevalence: { occurrences: number; sessions: number; spanDays: number; denominator: number };
};
```

Detectors worth building first, in order:

- **S1 · tool-failure-cluster** — group tool results by tool where the
  outcome is a _structured_ failure. The detector must parse the JSON
  envelope, never grep the text.

  Measured on the real corpus (7 370 `memphis_exec` results, re-measured
  2026-11-02 20:45 CET):

  | detector                                                        | flagged | true failures | false positives |
  | --------------------------------------------------------------- | ------- | ------------- | --------------- |
  | naive substring scan, `error` anywhere in the result            | 1 286   | 67            | 1 219 (95 %)    |
  | naive substring scan (`"error"`, `"ok":false`, `error:`)        | 299     | 44            | 255 (85 %)      |
  | structural (`exitCode != 0` / `error` / `ok:false` / `blocked`) | —       | **257**       | 0               |

  The structural row is the truth: 257 of the 7 370 exec results are
  real failures. The naive scans are wrong in **both** directions —
  they flag 1 219 results that are perfectly fine, and they miss 190
  real failures.

  The word "error" is usually in the **command** (`grep -i error …`),
  not in the outcome. Every exec envelope carries the command it ran,
  so a text scan reads the command back as an error.

  The earlier draft of this table said 670 naive hits, 255 structural
  and 415 false positives (62 %). The naive count and the share could
  not be reproduced from the population as documented, so they are
  replaced by the measurement above rather than left as a claim nobody
  can rebuild.

  And the envelopes parse cleanly: **8 437 of 8 437** tool results are
  valid JSON, so the structural detector applies to every single one —
  there is no fallback path to get wrong.

  The correct implementation already exists:
  `classifyToolOutput` in `src/infra/observability/instrument.ts` reads
  the envelope's `error` / `ok:false` / `blocked:true` fields. Reuse it
  rather than writing a third opinion about what an error is.

- **S2 · repeat-loop** — the same tool with the same normalized arguments
  not succeeding repeatedly. Cheap, precise, and it is exactly the shape of
  the failures we have actually had. "Not succeeding" counts a loud failure
  and a silent non-zero exit alike: the agent repeated itself and learned
  nothing either way. Measured over the live corpus, counting only loud
  failures reported 4 loops and missed 3 that were real waste — an agent
  that polled a PR queue 55 times per call, four times over. The two kinds
  stay apart in the count, so the signal can still say which is which.
- **S3 · correction** — the operator expressing dissatisfaction. Measured
  honestly, and the measurement is worse than the earlier draft claimed:
  the documented keyword set (`nie rozumiem`, `co wisi`, `nietrzeba`,
  `co to`) matches **7 of 593** user turns, and most of those are
  questions, not corrections (`Co to jest?`). A wider set reaches
  10/593. The operator writes short Polish with no marker — the median
  user turn is 14 characters. **This signal is too sparse for keyword
  detection and is the strongest argument for the LLM tier.**
- **S4 · no-progress** — sessions where tool calls vastly outnumber
  assistant answers: the agent is working and not concluding.

#### What S1 already finds on the real corpus

Running the structural detector over all 8 437 tool results today:

| tool                                              | real failures |
| ------------------------------------------------- | ------------- |
| `memphis_exec`                                    | 257           |
| **`mephis_exec`** (sic)                           | **42**        |
| `memphis_code_read`                               | 34            |
| `memphis_self_modify`                             | 24            |
| **`mephis_code_read`** (sic)                      | **6**         |
| `memphis_web_fetch`                               | 14            |
| `memphis_chain_verify`                            | 13            |
| `memphis_soul_write`                              | 10            |
| `memphis_git`                                     | 10            |
| **`memphis_web_fetch`**, **`memphis_grep`** (sic) | 5, 3          |
| …                                                 |               |

The misspellings are not noise. **56 calls went to tool names that do
not exist**, and the runtime answered every one of them with
`{"error":"unsupported native rust chat tool: mephis_exec"}`. They are
concentrated — 51 of the 56 in a single session (`tui-6ac20760`).

This is a real agent bug: 56 wasted tool calls, and not one of them
visible to the reflection loop, because the loop reads chains and this
happened in transcripts. It is exactly the class of pattern the talk
describes — _"something in the tool halls keeps failing"_ — and it takes
one SQL query and one JSON parse to find.

### 3.4 Analyzer — the LLM tier

Where the talk's best patterns are found ("every geography student
answers in radians when it means degrees" — no keyword detects that).

- **Out of band**: batch, on a schedule, never in the hot path.
- **Budgeted**: `MEMPHIS_DREAMING_TOKEN_BUDGET` per run. The analyzer
  samples transcripts — stratified by session, by tool-failure cluster,
  by length — until the budget is spent.
- **Steered**: the operator writes
  `~/.memphis/config/dreaming-priorities.md` — what matters for _this_
  operator, what does not. The talk calls this steering the curator's
  lever: _"you're able to tell them, in your specific case, these are
  the kinds of things I think are important."_ This is the "curriculum"
  of the school analogy, and it is what makes the mechanism ours rather
  than a generic one.
- **Output**: proposals in the shape below. The model does not write
  memory; it writes proposals.

### 3.5 Proposals — first-class, auditable, gated

A proposal is a durable object. It goes in a **new chain, `proposals`**,
because the hash chain gives us versioning, auditability and
rollback-by-supersede for free — the exact properties the talk's
principle #1 asks for.

```ts
type ProposalKind = 'memory.add' | 'memory.update' | 'memory.retire' | 'org.directive';
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
  kind: ProposalKind;
  status: ProposalStatus;
  target: { scope: string; id?: string; field?: string };
  patch: unknown;
  /** Examples of the transcripts where the pattern was noticed. */
  evidence: Array<{ sessionId: string; sequence: number; quote: string; toolName?: string }>;
  /** How prevalent the issue is, and why it warrants a change. */
  prevalence: { occurrences: number; sessions: number; spanDays: number; denominator: number };
  confidence: number;
  rationale: string;
  proposer: 'dreaming' | 'agent' | 'operator';
  /** What this update was based on — the versioning principle. */
  basedOn: { sessionIds: string[]; chainBlockHashes: string[] };
  createdAt: string;
  decidedAt?: string;
  appliedAt?: string;
};
```

**A proposal without evidence is invalid.** That is the rule that keeps
the mechanism from becoming a machine that rewrites memory on a hunch.

**The gate.** The agent may _propose_ and may _apply_ an accepted
proposal. It may **not accept** one. Accept/reject is an operator action
on a tier-2 surface (CLI `memphis dream accept <id>`, TUI). This is the
one place where we are currently _less_ safe than the talk's
recommendation, and it is the cheapest thing in this design to fix.

The state machine follows the pattern already in
`src/core/decision-lifecycle.ts` (an `ALLOWED` map of legal
transitions) — no new idea needed.

### 3.6 Apply — provenance and rollback

- **`memory.add`** → append to the target chain, carrying `proposalId`,
  `basedOn` and evidence references in the block data.
- **`memory.update`** → _not_ a rewrite. Chains are append-only, so an
  update is a new block that references and supersedes the old one. The
  hash chain stays intact and the history stays readable.
- **`memory.retire`** → a block marking the entry retired, with the
  reason. Memory is never silently deleted.
- **`org.directive`** → written to a scope agents can read but not
  write (§3.7).

Rollback: `memphis dream rollback <proposalId>` writes a compensating
block for chain targets; for `soul-memory.json` it restores from the
existing 8-deep backup ring.

### 3.7 Permissioning — the missing production principle

| scope                              | read             | write                                   |
| ---------------------------------- | ---------------- | --------------------------------------- |
| `org` — organizational directives  | every agent      | operator only, via an accepted proposal |
| `shared` — project / cross-section | every agent      | accepted proposals                      |
| `personal` — soul, journal         | operator + agent | agent allowed                           |
| `session` — scratchpad             | the session      | agent freely                            |

Implemented as a **runtime** write policy (`src/infra/storage/
memory-write-policy.ts`) enforced on agent-initiated writes, with an
explicit `writer` scope so runtime-internal writes (bootstrap, heartbeat,
scheduler) are not affected. The existing VITEST-only guards stay as they
are — they are a different problem (test isolation) and are not the
production policy.

### 3.8 Staleness

Nothing expires today. `src/cognitive/model-a-types.ts:153` has a
`'stale'` status that no code path sets.

Staleness is handled _as proposals_, not by mutating the soul-memory
schema: the analyzer proposes `memory.retire` when an entry is
contradicted by recent evidence, or when its topic has gone dormant while
the surrounding memory churns. The operator accepts or rejects. The
`soul-memory.json` schema stays stable, which matters because it is
read by every surface.

### 3.9 Resources — where this meets Mazur

Dreaming is out-of-band with dedicated resources. Under Mazur's energy
accounting (`src/infra/runtime/` homeostat, Faza 2) dreaming is **not**
wasted power: it spends tokens to produce better memory, which shows up
as fewer failed turns and cheaper one-shot completions. The energy
homeostat must therefore count dreaming as productive spend with a
budget, not as idle overhead to be throttled.

---

## 4. What we reuse (no reinvention)

| existing                                                       | used for                                                                                         |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `classifyToolOutput` (`src/infra/observability/instrument.ts`) | structured failure detection in S1 — the third opinion on "what is an error" that we do not need |
| `decision-lifecycle.ts` state-machine pattern                  | proposal status transitions                                                                      |
| hash chain (`prev_hash`/`hash`)                                | proposal auditability, provenance references, rollback by supersede                              |
| `soul-memory.json` 8-deep backup ring                          | rollback for file targets                                                                        |
| `SeenProposalRepository` pattern                               | replay protection for applied proposals                                                          |
| `memphis_case_append` case types                               | not applicable — the case chain is a different structure (no free-form patch/evidence)           |

**What we deliberately do NOT reuse:** `ModelD_CollectiveCoordination`
(`src/cognitive/model-d.ts`) — it is a voting protocol for multi-agent
coordination, its proposals live in an in-memory `Map` (lost on restart),
and no production code path constructs it. Memory curation is a different
problem with a different gate.

---

## 5. Delivery sequence

Six stages. Each is independently valuable, independently mergeable, and
none of them is dead code — nothing is built that a later stage removes.

| stage  | PR            | delivers                                                                      | falsifier                                                                                                                                                                                        |
| ------ | ------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **D1** | corpus        | `dreaming/corpus.ts` + repository; wrappers stripped; calls joined to results | corpus over the real DB reproduces the 1:1 join, the wrapper split and the parse rate, and the counts it prints match the live database (`npm run -s ops:dream-falsifier`) — **shipped in #730** |
| **D2** | signals       | S1–S4 detectors, always on                                                    | finds the 56 calls to non-existent tools (`mephis_exec` &c., 51 of them in one session) — a real agent bug that is invisible to a chain-only reflection                                          |
| **D3** | proposals     | `proposals` chain, lifecycle, `memphis dream list/show/propose`               | running it on the real corpus yields proposals that each carry evidence and prevalence — **shipped: 26 signals → 21 proposals, 0 without evidence** (`npm run -s ops:dream-proposals`)           |
| **D4** | gate + apply  | operator accept/reject, apply with provenance, rollback                       | end-to-end on this runtime: an applied proposal lands in the target with provenance; rollback restores the prior state                                                                           |
| **D5** | analyzer      | budgeted, steered LLM review producing the same proposal shape                | on the real corpus it produces at least one proposal a human would accept — and the human says so                                                                                                |
| **D6** | permissioning | runtime write policy by scope                                                 | mutation: an agent-initiated write to an operator-only scope is refused, and the refusal is in the audit chain                                                                                   |

D5 depends on D3 and D4. D6 is independent and can ship any time after
D3.

---

## 6. Risks, and what would kill this design

| risk                                                   | mitigation                                                                                  |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| LLM cost                                               | budgeted + sampled; the deterministic tier is free and always on                            |
| proposal noise                                         | evidence is mandatory; prevalence has a threshold; the human gate is the final filter       |
| the agent games its own proposals                      | it cannot accept; accept is tier 2 and operator-only                                        |
| applying to soul-memory in production breaks something | apply is additive, carries provenance, is rollback-able, and the backup ring already exists |
| the corpus grows unbounded                             | windowed reads; the corpus is a view, not a copy                                            |

**The falsification test for the whole design.** Run the corpus and the
signals over the real 45 sessions and see whether they produce a pattern
that a human recognises as a real, previously unseen, operator-relevant
pattern. If they produce only noise, the design is wrong — and that is
knowable in one run, not six PRs from now.

**The second falsification test.** Hand D5's output to the operator
without explaining it. If the operator says "yes, that is a real problem
I did not notice", the mechanism works. If the operator says "that is
obvious", the LLM tier is earning nothing over the deterministic tier and
should be dropped.

---

## 7. Relationship to the Mazur plan

Mazur's homeostat is the _runtime's_ self-repair loop: measure → detect →
act on the runtime's own health (F0.x, Faza 1: SLO → action).

Dreaming is the _memory's_ self-improvement loop: measure → detect →
propose → act on the memory's own quality.

Same shape, different substrate. Mazur's homeostat acts on the runtime
(a restart, a repair); dreaming acts on the memory (a learning, a retired
entry). They share the discipline that matters: **an out-of-band process
with dedicated resources, seeing what the inner loop cannot see.**

Faza 1 (homeostat informacyjny) and D5 (analyzer) should be built with
that shared shape in mind, so the two do not grow two different
vocabularies for "detected a problem and want to change something".
