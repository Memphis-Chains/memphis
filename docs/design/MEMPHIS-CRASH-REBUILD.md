# Memphis — why it kept dying, and the rebuild that stops it

**Status:** shipped, 2026-11-22.
**Predecessors:** `docs/design/MEMPHIS-HOLES-AND-REFACTOR.md` (the holes
H1–H9 and stages S0–S6), `docs/design/DREAMING-GAPS-AND-REFACTOR.md`.

---

## 0. What this document is

The brief was: *the runtime keeps crashing; rebuild it so it does not;
look at `rust-n-api-typescript-json`.*

The previous refactor (`MEMPHIS-HOLES-AND-REFACTOR.md`) closed the
**structural** holes it could see — one registry, one block vocabulary, a
truthful status surface, a freshness gate. The audit it left behind was
green on almost every check when this work started:

```
$ npm run -s ops:audit
chain-registry        SUCCESS
block-vocabulary      SUCCESS       0 of 27118 live blocks cannot be parsed by the core
slo-reporting         SUCCESS
health-reporting      SUCCESS
deployment-freshness  SUCCESS
branch-boundary       SUCCESS
gate-coverage         FAILURE       4 gate(s) measure a scope that cannot fail on this host
postmortem-status     SUCCESS
overall: FAILURE (1 open, 0 inconclusive, 0 unknown)
```

That document was right about its own subject. What it did not do is
follow the failures all the way down to *how the process actually dies*,
and it did not touch the arm of the runtime the operator actually uses —
the native operator console, which is 38 000 lines of Rust that the
audit barely sees.

This document is the other half: the four measured ways the runtime
dies, and the structural change that removes them.

---

## 1. The reference architecture

The brief names `rust-n-api-typescript-json`. Memphis already states the
rule it implies, in its own words, in
`docs/roadmap/archive/Y1-v1-2026-04-21.md:45`:

> **Rust core authoritative.** `crates/memphis-core|memphis-operator|memphis-embed`
> own the data plane; TS orchestrates via NAPI. When Rust and TS both
> implement a surface, Rust is canonical; TS fallback only when Rust
> bridge status reports unavailable.

And its own documented reference study,
`docs/roadmap/phase-0-findings-2026-04-21.md:12`:

> **`memvid/claude-brain`** (MIT, v1.0.7, Jan 2026, 458 stars) is a
> reference integration for Claude Code — Rust core + TS/JS wrapper, same
> architecture as Memphis.

So the target was never in question: **Rust owns the data plane, N-API is
the only bridge, TypeScript is the shell, JSON is the one wire format.**
What was in question was how far the runtime had drifted from it.

Measured, before any change:

| what                                     | size    | status                                     |
| ---------------------------------------- | ------- | ------------------------------------------ |
| Rust crates                              | 51 315 LOC across 9 crates | the data plane                    |
| `crates/memphis-operator`                | 23 789 LOC | **a second agent runtime**, reachable only from the Rust TUI |
| `crates/memphis-tui`                     | 14 514 LOC | the operator console — a Rust binary    |
| TypeScript                               | 134 571 LOC | the HTTP/MCP/CLI shell — **a second agent runtime** |
| N-API exports                            | 37      | **0 of 37 had panic protection**           |
| TypeScript envelope parsers              | 6       | 2 of them did not catch a `JSON.parse` failure |
| Independent block-hash implementations   | 4 live  | with 5 different formulas                 |

Two agent runtimes, one repository: the Rust `memphis-operator` and the
TypeScript `src/gateway` + `src/providers`. They implement the same
tools independently, kept in sync by *prose comments and one fixture*.
That is the shape the previous refactor named in §2 of its own document:

> The failure mode that repeats in this repo is a new writer that does
> not go through an existing boundary.

---

## 2. Four measured ways the runtime dies

### 2.1 · The daemon exits on a background rejection

`src/infra/runtime/scheduler.ts` ran its tick every 30 seconds:

```ts
this.timer = setInterval(() => void this.tick(), this.intervalMs);
```

and `tick()` had a `try { … } finally { … }` with **no `catch`**. `void`
discards the promise, so a rejection reached the process-level handler —
which called `process.exit(1)`:

```ts
process.on('unhandledRejection', (reason: unknown) => {
  …
  process.exit(1);
});
```

One malformed entry in `~/.memphis/config/scheduler/tasks.json`, or a
`tasks.lock` left behind by a killed process, and the daemon exited
every thirty seconds, restarting every five.

The sibling loops were already correct — `reflection-loop.ts`,
`chain-rotation-loop.ts`, `scheduled-backup.ts` and `crons-bridge.ts`
all catch. `scheduler.ts` was the one that did not, and
`heartbeat-watchdog.ts` was the second: its `tick()` called the
operator's `onStateChange` and `onHeartbeat` observers with nothing
around them.

### 2.2 · A Rust panic aborted the process

Every export of `crates/memphis-napi` was declared `#[napi]` without
`catch_unwind`. napi-rs only emits the `std::panic::catch_unwind`
wrapper when the attribute asks for it, so a panic inside the core
unwound across the FFI boundary into an `extern "C"` symbol — where
Rust aborts the process. **A JavaScript `try`/`catch` cannot intercept
it.**

Thirty-six of the thirty-seven exports had no protection. The one that
did (`case_rebuild`) had a hand-written `catch_unwind` — because
somebody had already been bitten by exactly this.

The TypeScript side believed it was safe:

```ts
try {
  …
  embedShutdown();   // if this Rust fn panics, the process ABORTS
} catch {
  // Swallowed — the guard runs at exit
}
```

The catch cannot run. The abort happens first.

### 2.3 · The operator's console wedged itself, permanently

This is the one the operator actually notices. The native console keeps
a turn checkpoint:

```rust
// chat.rs
save_turn_checkpoint(&conn, &checkpoint_id, &session_id, "running", &pending)?;
```

and refuses to start a turn while one is marked `running`:

```rust
let running: bool = conn.query_row(
    "SELECT EXISTS(SELECT 1 FROM operator_turn_checkpoints WHERE session_id=? AND status='running')",
    …
if running {
    return Err(OperatorError::Message(
        "a turn is active or was interrupted unexpectedly; …".into(),
    ));
}
```

Two defects, measured on the operator's host:

**(a) A killed process left the row `running` forever.** The
`RunningCheckpointGuard` marks it `interrupted` when the stack unwinds —
but `SIGKILL`, an OOM kill, a `kill -9` from the operator, and a reboot
never unwind a stack. There was no liveness check of any kind: no pid,
no lease, no heartbeat. One stale row refused **every** later turn in
that session, and the operator's own remedy — killing the process —
created the next stale row.

**(b) A failed turn blocked the session even when nothing had been
written.** The recovery guard was:

```rust
let unsettled = unsettled_operations_summary(&conn, session_id)?;      // operations with no outcome
let incomplete = incomplete_turn_summary(&conn, session_id, &checkpoint_id)?;  // ANY interrupted turn
let recovery_guard = !incomplete.is_empty() || !unsettled.is_empty();
```

`incomplete_turn_summary` selected `status IN ('running','interrupted')`
— **the existence of a failed turn** was treated as evidence that a side
effect might be outstanding. A turn that failed because the provider
timed out, or the prompt exceeded the context window, dispatched no tool
at all: there was nothing that could have been half-applied.

Measured on the operator's host:

| checkpoints        | count |
| ------------------ | ----- |
| `blocked`          | 23    |
| `interrupted`      | 23    |
| `completed`        | 50    |
| `acknowledged`     | 1     |
| **`running`**      | 0     |

and of the 46 blocked/interrupted turns, **25 had zero operations**.
They blocked the agent because they had *failed*, not because anything
had been written.

The console's session id is `tui-<timestamp>` — `/clear` mints a new one
— so the wedge followed the operator from session to session, and
`memphis recovery list` was the only way out: a local TTY and the
operator passphrase. The console itself had no recovery command.

### 2.4 · The runtime was killed by the kernel, not by the supervisor

The public chat asked for `Number.MAX_SAFE_INTEGER` blocks from three
chains on **every request**:

```ts
chains.map((chain) => getRecentBlocks(chain, Number.MAX_SAFE_INTEGER))
```

and `getRecentBlocks` read the whole chain and sliced afterwards:

```ts
const blocks = await readChainBlocks(chain, rawEnv);   // reads everything
return blocks.slice(-Math.max(1, limit));              // then throws most of it away
```

Measured on the operator's host:

| chain      | blocks | on disk | public notes |
| ---------- | ------ | ------- | ------------ |
| `journal`  | 1056   | 1.8 MB  | **1**        |
| `decisions`| 549    | 2.7 MB  | 0            |
| `insights` | 402    | **31.9 MB** | 0         |

Thirty-six megabytes of JSON, parsed into JavaScript objects, per
request — to find one usable note, which lives in the journal's tail.
The parsed form is several times larger than the bytes on disk, and the
request path allows four at a time.

There was no memory ceiling anywhere above it. Measured on the host:

```
app.slice:          9.6 GB memory peak, 1.4 GB swap peak
memphis.service:    3.4 GB peak
memphis-basal-td:   2.2 GB peak, 357 MB swap
```

The kernel OOM killer was the supervisor. The unit had no `MemoryMax`,
no `MemoryHigh`, no `OOMPolicy`, no `TimeoutStopSec`.

### 2.5 · And the diagnostics that would have shown it were being destroyed

`crates/memphis-tui/src/error_log.rs` appended each error record with
`writeln!(file, "{record}")`. `writeln!` on a `File` issues **one
`write` syscall per format fragment**, not one per line. Two writers
interleaved *inside* a record:

```
{{""presentedpresented""::"fatal","raw":"unexpected renderer invariant violation"",…
```

Measured on the operator's host: **80 of 252 lines** in
`~/.memphis/logs/tui-errors.jsonl` were unparseable. The file that
exists to diagnose failures was destroying them.

---

## 3. What changed

### 3.1 · One boundary decides what an error does to the process

`src/infra/runtime/fatal-guard.ts` — new, and imported **first** by the
CLI entry point. ES module imports are evaluated before the importing
module's body, so this is the only way the handlers exist while the
rest of the graph (the Rust bridge, the gateway, the MCP server) is
being evaluated. Previously a `throw` during that evaluation killed the
daemon through Node's default handler: no pino line, no drain.

One rule, two cases:

- `unhandledRejection` — exactly one task failed and nobody was waiting
  on it. **Log it, count it, keep serving.** In daemon mode this must
  not exit the process.
- `uncaughtException` — the process state is undefined. Log it and exit
  non-zero, so the supervisor restarts a *clean* process.

The CLI and the daemon want different things from a rejection, so the
mode is stated twice: read from argv at install time (to close the
import window) and set explicitly by the bootstrap (so it does not
depend on how the command was spelled).

The background loops no longer reach it: `scheduler.tick()`,
`heartbeat-watchdog.tick()`, the scheduled-backup tick and the Telegram
turn each own their own failure.

### 3.2 · The Rust core cannot abort the process

Every one of the 37 exports is now `#[napi(catch_unwind)]`. A panic
inside the core arrives in JavaScript as a thrown error, and the one
module that understands the bridge's contract turns it into an ordinary
bridge error with the function name attached.

That module is new: `src/infra/storage/bridge-envelope.ts`. Six
TypeScript modules used to parse the `{ok, data, error}` envelope
independently; two of them did not catch a `JSON.parse` failure, so a
stale binary produced a raw `SyntaxError`. There is now one parser and
one `callBridge`, and the TypeScript side validates the envelope instead
of blind-casting it.

### 3.3 · The recovery guard asks for evidence, not for a failure

`crates/memphis-operator/src/chat_session.rs`:

- `incomplete_turn_summary` now selects only turns that have an
  operation with **no settled outcome**. A turn that failed before
  dispatching a tool is not evidence of anything and no longer arms the
  guard.
- `reclaim_abandoned_turns` reclaims a `running` checkpoint whose owner
  is gone.

`crates/memphis-operator/src/chat_lease.rs` — new — is the liveness
proof. The owner is recorded as a *process identity*, not a pid:

| field        | catches                                    |
| ------------ | ------------------------------------------ |
| `pid`        | the obvious case                           |
| `boot_id`    | pid reuse across a reboot                  |
| `start_time` | pid reuse within one boot                  |

It mirrors `src/infra/runtime/process-lock.ts` exactly, so both runtimes
answer "is that still the same process?" the same way.

A checkpoint with no recorded owner predates the lease. It cannot be
proven live and it cannot be proven dead — and leaving it would
reproduce the wedge, so it is reclaimed.

Six new Rust tests, including the two that are the whole point:

- `a_failed_turn_without_operations_does_not_arm_the_guard`
- `a_running_checkpoint_whose_owner_is_gone_is_reclaimed`

The old test asserted the *buggy* contract — that an interrupted turn
appears in the summary — and was rewritten.

### 3.4 · The console tells the operator what to do

`crates/memphis-tui/src/app.rs` — the recovery-pause error matched none
of the `Recoverable` patterns, so it fell through to `Fatal`. The
operator saw "fatal" and had no next step. It now presents as:

> **Status:** write tools paused pending review
> **Detail:** An earlier turn in this session left an operation without a
> settled outcome, so the runtime is not repeating write operations until
> it is reviewed.
> **Action:** run `/recovery` to see the pending work, acknowledge it, and
> continue.

### 3.5 · The error log survives concurrent writers

`crates/memphis-tui/src/error_log.rs` — the record is built into one
string and written with **one** `write_all`, under a process-local
mutex. Two defences for two races: the mutex for threads, the single
write for other processes.

The test reproduces the corruption exactly — it fails against the old
implementation with the same "key must be a string at line 1 column 2"
that the live log showed.

### 3.6 · The public chat reads what it needs

`src/infra/http/public-chain-context.ts` — the catalog is built by
streaming: one block is parsed at a time, and a block that is neither a
note nor an annotation is dropped **before** its payload is retained.

The journal is still scanned in full, because the consent annotations
live there and they are the downgrade gate: missing one would publish a
note the operator had revoked. The other two chains are windowed.

`src/infra/storage/rust-chain-adapter.ts` — `getRecentBlocks` now
pushes the limit *into* the reader instead of slicing afterwards. A
"give me the last 20 blocks" call no longer reads fifteen thousand.

### 3.7 · The supervisor is bounded

`scripts/systemd/memphis.service` — new, and now the canonical unit:

```ini
MemoryHigh=2G
MemoryMax=4G
OOMPolicy=kill
TimeoutStopSec=45
```

A leak becomes a restart the operator can see, instead of the kernel
acting with no visible cause. `scripts/check-systemd-units.mts` now
reads `ops/memphis.service` as well — it was outside the gate, which is
how a unit without resource limits survived review — and requires
`MemoryMax=` on the long-running units.

### 3.8 · One native binary, and a gate that says so

Two different Rust binaries were reachable on one host: the service
installed the release `.so`, while every CLI invocation outside systemd
resolved the in-tree `index.node` — which was a **debug** build, 58 MB
against the release build's 7 MB. `memphis vault list` and the runtime
could therefore disagree about what the vault contained.

`scripts/run-rust.sh` now copies to the shipped artifact only for the
release profile, and `npm run build` produces the release build.

`scripts/check-native-bridge.mts` — new — fails when the shipped bridge
is older than the Rust source, or when the shipped bridge and the
release build are different files. The comparison is by **content**, not
by timestamp: the shipped file is a copy, so it is always newer than
the file it came from.

---

## 4. Dead code

The permission to cut was exercised, but measured first: a function that
looks dead may be a specification, and cutting it removes the rule
rather than the duplication.

| what                                                                  | what was done                                                                 |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `MINIMAX_M3_RECOMMENDED_COMPLETION_TOKENS`                              | cut — no reference anywhere                                                   |
| `ssrf_guard::{allow_private_network, assert_url_shape_safe, assert_host_safe, assert_url_safe}` | cut — the variants that read the policy from the **process environment**, which the module's own comment says is why its rules had **no coverage on the operator's machine** |
| seven `pub(crate)` functions used only by their own `#[cfg(test)]` module | marked `#[cfg(test)]` — they are test helpers, not shipping code                |
| `JOURNAL_TARGET_CHAINS` + `is_journal_target_chain` (Rust)              | **kept, and given a gate** — see below                                         |

`JOURNAL_TARGET_CHAINS` was dead in the Rust arm, and both copies of the
list claimed to be "checked against
`tests/fixtures/journal-target-chains-contract.json`, so the two arms
cannot drift apart silently".

**The fixture did not exist.** The claim was a comment, not a gate. Two
hand-maintained copies of the same rule with nothing comparing them is a
list that will drift — and the Rust copy was not used by anything at
all, which the compiler reported as dead code.

So the claim was made true instead of deleted:

- `tests/fixtures/journal-target-chains-contract.json` — the list,
- `tests/unit/journal-target-chains-contract.test.ts` — the TypeScript arm,
- `crates/memphis-operator/tests/journal_target_chains_contract.rs` — the
  native arm.

### 4.1 · A misplaced allowlist, caught by the suite

The operator's uncommitted named-chain feature (issue #645) put the
journal allowlist **inside `storeDurableMemory`**:

```ts
if (input.chain && !isJournalTargetChain(chain)) {
  throw new Error(`refusing to write to chain "${chain}"…`);
}
```

`storeDurableMemory` is the runtime's **own** durable-memory path. The
runtime writes to `decisions` and `system` through it. The check
therefore refused the runtime's own writes, and four tests failed:

```
Error: refusing to write to chain "decisions": a tool may append to
journal, soul, reflections, cases, patterns only
```

The check belongs at the **tool boundary** — `runMemphisJournal` — where
an operator-supplied name arrives. It was moved there, the security
property is unchanged, and the runtime's own writes work again. Eleven
new tests cover the boundary.

---

## 5. The falsifiers

Each of these is a command and an expected result on this host.

| claim                                                | falsifier                                                                     |
| ---------------------------------------------------- | ------------------------------------------------------------------------------ |
| A background rejection cannot kill the daemon        | `scheduler.tick()` and the watchdog tick own their failures; `fatal-guard.ts` never exits on a rejection in daemon mode |
| A Rust panic cannot abort the process                | all 37 exports are `#[napi(catch_unwind)]`; the bridge envelope turns a throw into a bridge error |
| A failed turn does not disable the agent             | `a_failed_turn_without_operations_does_not_arm_the_guard`                      |
| A killed turn cannot brick the session               | `a_running_checkpoint_whose_owner_is_gone_is_reclaimed`                         |
| A live turn is not stolen                            | `a_running_checkpoint_owned_by_a_live_process_is_kept`                          |
| The error log survives concurrent writers             | `concurrent_appends_produce_parseable_lines` — fails against the old code      |
| The public path does not materialise a chain         | one block in memory at a time; the journal is scanned in full, the rest windowed |
| A leak becomes a visible restart                     | `MemoryMax=4G` in the unit; the gate fails without it                          |
| The two arms cannot drift                            | both contract tests read the same fixture                                       |
| The shipped bridge is the running bridge             | `npm run -s ops:check-native-bridge`                                           |
| The bridge gate only fires on the bridge              | an edit in `memphis-operator` does not invalidate it; an edit in `memphis-core` does |
| The runtime audit measures what it claims to measure | `npm run -s ops:audit` — `overall: SUCCESS (0 open, 0 inconclusive, 0 unknown)` |

```
$ npm run -s ops:check-native-bridge
native bridge freshness gate OK — crates/memphis-napi/index.node is newer than every
source in the bridge closure (crates/memphis-case-index, crates/memphis-core,
crates/memphis-embed, crates/memphis-export, crates/memphis-napi, crates/memphis-paths,
crates/memphis-vault)

$ npm run -s ops:check-systemd-units
systemd unit gate OK — 19 unit files checked, every .service is runnable
```

---

## 5.1 · The gates that measured the wrong thing

The runtime audit ended this work still red, on one check:

```
gate-coverage         FAILURE       4 gate(s) measure a scope that cannot fail on this host
                      chain-invariant: scans the committed fixture, never the live chains
                      check-systemd-units: reads scripts/systemd/ only; never checks ops/memphis.service
                      backup-restore-drill: the workflow prints a notice instead of drilling
                      pii-scan: scans the working tree only, never the history
overall: FAILURE (1 open, 0 inconclusive, 0 unknown)
```

That check asks one question per gate: *can this gate fail on this host?* A
gate that cannot fail is not a gate. The four failures were not the same
kind of defect, so they did not have the same fix.

**`check-systemd-units` — a detector that could not report a closed hole.**
The coverage check compared the *name* of a file in `ops/`
(`memphis.service`) against the *path* of the gate's unit directory
(`scripts/systemd`). A name and a path can never be equal, so the
comparison reported the same hole forever — including after the gate had
been extended to read `ops/` as well. A gate that cries wolf is a gate
nobody reads.

Both sides now come from one list, `src/infra/audit/systemd-unit-scope.ts`:
the inventory says what exists anywhere in the repository, the coverage
says what the gate reads, and the difference is the hole. Widening the
inventory from the declared roots to the whole repository is what makes
the comparison falsifiable — and it immediately found a unit outside
every declared root: `scripts/live/memphis-camera-publish-live.service`,
a real `WantedBy=default.target` unit that no gate had ever read.

**`chain-invariant` — a CI gate that could not reach the live chains.**
The workflow now sweeps the chains the runner can reach. `MEMPHIS_CHAINS`
is the runtime's own variable for where the chains live; a public CI
runner has none, so it sweeps the committed fixture with the native core
as its oracle and says so in the log. On the operator's host the same
command sweeps the live chains: measured 14 chains and 66 blocks, 0
failures, against the fixture's 3 chains and 4 blocks, 0 failures.

**`backup-restore-drill` — a notice that looked like a drill.** The
workflow printed how to run the drill and ran nothing. The refusal to
run it in CI was about the *shell* drill, which touched the operator's
live vault; the current drill is an integration test that builds its own
chains, vault state and install root in a temporary directory. There is
no secret in it, so there was nothing left to protect. It runs now, on
demand and nightly.

**`pii-scan` — the scan that read the tree and called the repository
clean.** This one found something.

> Measured 2026-11-22: the operator's Telegram chat id appears in **55
> commits across 21 files** of this repository's published history —
> `crons/spac.sh`, `crons/morning-report.sh`, `docs/MEMORY.md`,
> `docs/runbooks/RESTORE-FROM-BACKUP.md`, ten `tests/unit/mcp-send-*.test.ts`
> files among them. The working tree is clean of it today. Every one of
> those files was cleaned after the fact, and the scan reported OK on the
> result.

A value that was published and then removed is still published. Anyone who
clones the repository reads it with `git log`.

The history arm asks git which commits added or removed a matching line
(`git log --all -G`), so git does the search rather than a second
implementation of a scan. It costs about 11 s over a 234 MB `.git`,
which is why it is a scan and not a pre-commit step.

Two other findings came out of the same measurement, and both are
recorded rather than assumed:

- The Telegram bot token in `crons/spac.sh` is **not** the token the
  runtime uses today — compared by SHA-256, never printed. It was rotated.
  It is still in eight commits.
- The `ghp_`-shaped value in the history of
  `tests/ops/default-secret-scan-allowlist.test.ts` is 36 identical
  characters. It was a fixture, not a credential.

A history hit is **not** a block. A working-tree hit is fixed by the next
commit, so the gate can enforce it; a history hit needs the history
rewritten (`git-filter-repo`) and the remote force-pushed — an operator
decision with consequences no commit has. So the history arm reports
loudly, states the remediation, and blocks only under `--strict`. The
operator's identifier in the history is a known open item, and it is the
one thing in this document that a commit cannot fix.

---

## 6. What is still open

Stated plainly, because a plan that hides its remainder is the failure
mode this repository already has a postmortem about.

1. **The two agent runtimes are still two.** The Rust
   `memphis-operator` (23 789 LOC) and the TypeScript `src/gateway` +
   `src/providers` (23 249 LOC) still implement the same tools
   independently. This document removed the *crash* consequences of the
   duplication; it did not remove the duplication. Collapsing them is
   the next stage, and it is the stage that needs the operator's
   decision about which arm survives.
2. **The block hash had four implementations** in TypeScript
   (`rust-chain-adapter.ts`, `chain-canonical.ts`, `chain-adapter.ts` ×
   3, `security/integrity.ts`) against one in Rust. The Rust core is
   canonical and already answers "is this block valid?" — the
   TypeScript copies should ask it rather than recompute it. The
   divergence between the two TypeScript copies is documented in
   `chain-canonical.ts:60-67` and still unfixed.
   **Closed 2026-11-22.** The copies are gone: one TypeScript
   implementation in `src/core/chain-hash.ts`, one Rust implementation in
   `crates/memphis-core/src/hash.rs`, and a fixture of core-produced
   hashes that both sides check themselves against
   (`tests/fixtures/chain-hash-parity.json`). The divergence was real —
   `chain-adapter.ts` fell back `type` → `journal` while the repair path
   fell back `type` → `block_type` → `journal`, exactly like the core.
   Measured: 0 of 27 159 blocks on disk carry `block_type` without `type`,
   so it never bit. A third formula inside `chain-adapter.ts` was
   byte-identical to the one above it and could never accept anything the
   first comparison had rejected. See `cfada12478`.
3. **The signature schemes still differ** — ed25519 in Rust,
   RSA/SHA-256 in `src/security/integrity.ts`.
4. **The `system` chain still grows without bound** (15 730 blocks,
   62 MB, ~100–280/day from scheduler events). Chain rotation exists
   and is not enabled. Every boot validates every block of it.
   **Closed 2026-11-22.** Rotation is enabled for the service and the
   chain is bounded: 10 MB threshold, 500 blocks kept live, four archives
   per chain. The `system` chain went from 15 771 blocks / 62 MB to 500
   blocks / 0.4 MB, with the prefix in a gzipped archive. Two bugs had
   to be fixed first, and both are the same shape as the rest of this
   document — a writer that did not go through an existing boundary:
   rotating produced a chain every validator rejected as "missing genesis
   block" (`f019fc0ff4`), and the publish step took no write lock at all,
   so a reader could observe the chain mid-rotation (`c9d95b8fe5`). The
   rotation's own env knobs were registered, validated and then ignored.
5. **The chain-name allowlist has two rules** — `SAFE_CHAIN_NAME` in
   TypeScript, ad-hoc predicates in Rust — with no parity fixture, the
   same defect §4 just fixed for the journal list.
6. **The `insights` chain is 32 MB across 402 blocks.** Whatever writes
   it is writing payloads three orders of magnitude larger than a
   journal block.
   **Cause found 2026-11-22.** `ModelEInsight.evidence` is `Block[]` —
   the complete source block — and the chain stored it verbatim, so every
   generated insight carried up to five full copies of blocks that
   already lived in their own chains. 13.2 MB of the 33.4 MB was
   `evidence[].data`, and another 14.1 MB was the block-level `content`
   string, which the chain adapter builds by serialising the whole
   payload — so the duplication was stored twice over. The chain now
   stores a reference (`chain`, `index`, `hash`, `prev_hash`, `timestamp`,
   `title`); the report the caller receives still carries the full
   evidence. See `ed030a9457`. The 32 MB already on disk is reclaimed by
   rotation, not by the writer.
7. **The operator's account identifier is in the published history** —
   55 commits across 21 files. §5.1 measures it and the scan reports it
   on every run. It cannot be fixed by a commit: the history has to be
   rewritten (`git-filter-repo`) and the remote force-pushed, which is an
   operator decision. This is the one item here that a commit cannot
   close, and it is the reason the history arm is advisory rather than
   blocking.

None of these is a crash. All of them are the same shape: two copies of
one rule, with no gate that compares them.

Three of the seven were closed by the cleanup pass of 2026-11-22 —
items 2, 4 and 6 — and each of them turned out to have a second copy
hiding behind the first: the hash had a third formula that was
byte-identical to the second, the rotation had two env knobs that were
validated and ignored, and the insights chain stored its duplicated
evidence twice over because the chain adapter serialises the whole
payload into `content`. Finding the copies was the work; the gates that
now compare them are what keeps them from coming back.

---

## 7. The rule this work ended on

The previous document said it first:

> **The failure mode that repeats in this repo is a new writer that does
> not go through an existing boundary.**

Every crash in §2 was that shape wearing a different hat:

| the writer                                    | the boundary it bypassed                   |
| --------------------------------------------- | ------------------------------------------ |
| the scheduler tick                            | the process-level error policy             |
| the Rust core                                 | the bridge's panic contract                |
| a killed turn                                 | the session's turn lease                   |
| the public chat                               | the chain reader's limit                   |
| the TUI error log                             | the log's append contract                  |

The fix in each case was the same: **make the boundary the only way in,
and make it say what it does.**
