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

**`chain-archive-restore` — a gate that tested a writer that does not
exist.** This one was not in the runtime audit's list; it was found on
2026-11-23 by measuring the rotation archive on the operator's own disk.

The restore test built its fixtures with `JSON.stringify(block)` — compact
JSON, one block per line. The production writer copied the raw bytes of
each block file, and block files are pretty-printed
(`JSON.stringify(block, null, 2)`). The reader split the archive on
newlines and parsed each line, which is what "JSON Lines" means. So the
gate exercised a reader against a fixture in a format that no writer in
this repository ever produced — and it was green while every archive the
runtime produced was unreadable.

> Measured 2026-11-23 on this host, on a real rotation of the `insights`
> chain (404 blocks, 31.92 MB, 297 blocks archived): the archive held
> **172 151 lines for 297 blocks**, and the restore died on line 1 —
> `parse error in archive: Expected property name or '}' in JSON at
> position 1 (line 1 column 2)` — because the first line was `{`.

The lesson is the one this section is about, in its sharpest form: the
gate was not weak, it was **about a different system**. It asked "can the
reader parse a JSONL archive?" and answered honestly, about a JSONL
archive that does not exist. What it never asked was "can the reader parse
an archive the writer produces?" — and that is the question an operator
asks when the rotation has just eaten 297 blocks of history.

The gate now goes through the real writer (`rotateChain`) and the real
reader (`restoreChainFromArchive`), and pins each side separately, because
the two failures were independent: a writer that emits something the
reader cannot parse, and a reader that cannot parse what the writer
emitted. Reverting either side alone now fails the gate. See
`tests/unit/chain-archive-roundtrip.test.ts`.

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
   **Partly closed 2026-11-22.** Inside the TypeScript arm the tool
   CONTRACT is now one copy instead of three. The registry holds it;
   the MCP server and the gateway executor derive their schemas from
   it. 48 inline MCP schemas and 52 inline executor schemas are gone,
   and the schema audit went from 40 divergences — a missing argument,
   a wrong type, 38 differing constraints — to 0 across registry,
   executor and MCP for all 64 tools. The divergence that bit was
   `memphis_journal`: the gateway silently dropped the `chain`
   argument, so the same call wrote to two different chains depending
   on the surface. What remains is the SPLIT itself — the Rust operator
   implements the same tools natively — and that still needs the
   operator's decision about which arm survives.
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
   **Closed 2026-11-22.** The file was the last copy of a superseded
   contract, and nothing used it: measured on this host, the only import
   of `src/security/integrity.ts` in the whole repository was its own
   test. The block format carries no signature at all — 0 of 12 393 chain
   files on disk contain a `signature` or a `publicKey` field, and the
   block shape is `{chain, data, hash, index, prev_hash, timestamp}`.
   The dead module hashed `{index, timestamp, data, previousHash}` — a
   field the real blocks do not have, and no `chain` — so its verifier
   would have declared EVERY block on disk corrupt. Measured on
   `chains/collective/000001.json`: stored hash `65040d65…`, dead module
   `659247eb…` (MISMATCH), canonical `canonicalHash` `65040d65…`
   (MATCH). The module and the test that protected the fiction are gone;
   `docs/dev/SECURITY-GUIDE.md` now points at the canonical hash instead.
   Blocks are not signed — they are LINKED, and the link is what the
   chain verify checks.
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
   **A third bug was found on 2026-11-23, after this item was closed**:
   the archives the rotation wrote could not be read back, so the history
   it moved aside was a write-only dead end. The chain was bounded, but
   the bound was not reversible. See item 9.
5. **The chain-name allowlist has two rules** — `SAFE_CHAIN_NAME` in
   TypeScript, ad-hoc predicates in Rust — with no parity fixture, the
   same defect §4 just fixed for the journal list.
   **Closed 2026-11-22.** The parity fixture DID exist
   (`tests/fixtures/chain-verify-contract.json`, read by
   `tests/unit/mcp-chain-verify-contract.test.ts` and
   `crates/memphis-operator/tests/chain_verify_contract.rs`) — which is
   why this item was worded wrong. The real defect was NARROWER and
   nastier: the corpus had twelve cases and none of them reached a shape
   where the two rules differ, so both runners were GREEN while the rules
   still disagreed.
   Measured on this host over the real chain directories plus the edges:
   the native arm accepted shapes the TypeScript registry refuses — a
   plain name of sixty-five characters (`SAFE_CHAIN_NAME` caps it at
   sixty-four) and a dated archive stamp that is not the
   `YYYY-MM-DDTHH-MM-SS-mmmZ` form (the native rule asked only for
   twenty-four characters ending in `Z` and containing a `T`). Two
   directories, two arms, two answers.
   The registry is the authority, so the native rule now matches it: the
   plain-name limit, the dated stamp checked POSITION BY POSITION, and
   the write-side validation (`validate_chain_name`) sharing the same
   limit — it had none. The corpus grew to seventeen cases and reaches
   both shapes; the Rust runner fails on them without the fix.
   The lesson is the same one §2 and §4 taught: a gate is only as good
   as the corpus it runs over, and a corpus nobody re-examines is a gate
   that has stopped measuring.
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
   **Second cause found 2026-11-23.** The first fix shrank the payload but
   left the SECOND copy of it in place: the adapter fills a missing
   `content` with `JSON.stringify(data)` — the whole payload, serialised —
   and four places agree on that rule (`chain-adapter.ts`,
   `core/chain-hash.ts`, `sync/sync-manager.ts`,
   `crates/memphis-core/src/hash.rs`), so it cannot change without
   invalidating the hash of every content-less block already on disk. The
   cost falls on whoever writes a payload with no content of its own, and
   measured on this host ALL 404 blocks of the `insights` chain carried
   that copy: 13.67 MB of the chain's 31.92 MB, 43 % of it, written again
   on every run. The `insights` payload is the one chain payload with no
   content of its own; the `journal`, `decisions`, `cases` and `patterns`
   chains write their own text and are untouched. The payload now carries
   its own content — a digest, one line per insight — so the block that
   reaches the chain went from 5 427 B to 3 289 B on the same fixture
   (2.56x the payload down to 1.44x), and the content from 2 116 B of copy
   to 147 B of digest. See `36c682e004`. The 32 MB already on disk is
   reclaimed by rotation, not by the writer — and rotation cannot reach
   it, which is the next entry.
7. **The chain-size threshold cannot fire for a chain with few blocks.**
   `rotateChain` requires BOTH `dirSize > threshold` AND
   `blocks.length > minKeep` before it rotates. The two knobs are separate
   bounds — the threshold says WHEN a chain is touched, the keep-count
   says how much recent context stays live — and the operator's own unit
   file says so: "the threshold is what actually triggers a rotation".
   Measured 2026-11-23 on this host: the `insights` chain is 31.92 MB
   across 404 blocks, so it is three times over the 10 MB threshold and
   still has fewer than the 500 blocks the keep-count asks for — and it
   has never rotated, although the service rotates hourly
   (`MEMPHIS_CHAIN_ROTATE_INTERVAL_MS=3600000`,
   `MEMPHIS_CHAIN_ROTATION_THRESHOLD_BYTES=10485760`). The same holds for
   `patterns` (9.90 MB, 5 510 blocks — over the count, under the size) and
   `cases` (1.14 MB, 2 182 blocks). The threshold is inert for every chain
   whose blocks are fat, which is exactly the case the threshold exists
   for.
   **Closed 2026-11-23.** The threshold alone now decides WHEN a chain is
   touched. The keep-count still decides how much stays — except where it
   cannot apply at all, because the chain holds fewer blocks than it asks
   for; there the size bound decides, and the chain is never emptied. The
   old formula `slice(0, length - minKeep)` was guarded by the very
   condition that hid the bug, and removing the guard without moving the
   formula would have selected a NEGATIVE range — on a three-block chain
   with a keep-count of seven, that range is empty, and a few blocks more
   would have selected the NEWEST blocks. The count the retention decided
   is now the count the archive uses.
   Measured on this host, on a copy of the real `insights` chain: the
   rotation fires, archives **297 blocks** and keeps **107** (9.93 MB of
   the 31.92 MB) — the blocks that fit under the threshold, counted from
   the newest backwards. The chain still verifies afterwards
   (`chain verify` → `ok: true`, 107 blocks), because the rotation head
   marker proves the live chain continues the archived prefix.
   The falsifier is the gate, and it fails without the fix: the new case
   in `tests/unit/chain-rotation-thresholds.test.ts` asserts
   `result.rotated === true` on a chain of three 400 KB blocks with a
   keep-count of seven, and against the old code it reports
   `expected false to be true`.
8. **The operator's account identifier is in the published history** —
   55 commits across 21 files. §5.1 measures it and the scan reports it
   on every run. It cannot be fixed by a commit: the history has to be
   rewritten (`git-filter-repo`) and the remote force-pushed, which is an
   operator decision. This is the one item here that a commit cannot
   close, and it is the reason the history arm is advisory rather than
   blocking.
9. **Every rotation archive was unreadable, and the readable part of it
   was wrong.** Item 4 closed the rotation on 2026-11-22, and the
   rotation then worked: the `system` chain went from 15 771 blocks /
   62 MB to 500 blocks / 0.4 MB. What nobody could do was GET THE HISTORY
   BACK. Three divergences, all in the same feature, all measured on this
   host on 2026-11-23:
   - **The writer and the reader disagreed about the format.** The writer
     copied the raw bytes of each block file — pretty-printed, because
     `chain-adapter.ts` writes `JSON.stringify(block, null, 2)` — while the
     reader split the archive on newlines and parsed each line, which is
     what "JSON Lines" means. A real rotation of the `insights` chain
     (297 blocks archived) produced an archive of **172 151 lines**, and
     the restore died on line 1: `parse error in archive: Expected
     property name or '}' in JSON at position 1`. The archive held the
     data; nothing could read it.
   - **The reader decoded a stream, not characters.** `chunk.toString
     ('utf8')` decodes each chunk on its own, so a multi-byte character
     that straddles a chunk boundary becomes U+FFFD. On that same
     archive, **20 of the 297 lines** came back corrupted — the first at
     block 190, where the restore failed with `hash mismatch at block
     190`. Every corrupted character sat exactly two bytes before a 16 KB
     chunk boundary: the two bytes of `ó` (0xC3 0xB3), split in half.
   - **The block file had two formats.** The append path, the repair path
     and the restore path all write block files; the first two wrote
     pretty-printed JSON and the third wrote compact JSON, so a restored
     chain was not byte-identical to a chain that had never been
     rotated.
   **Closed 2026-11-23.** One module now owns what an archive is
   (`src/infra/storage/chain-archive-format.ts`), and both sides import
   it. The writer emits true JSON Lines — one object per line, which is
   also 8.6 % smaller on disk (2 538 453 B against 2 777 704 B for the
   same 297 blocks). The reader splits the stream into JSON *values*, so
   it reads the new format AND the legacy one; the archive already on
   this disk (`system_000001-015271`, 15 271 blocks) was unreadable
   before and is recoverable now — measured: **15 271 blocks read, 15 271
   restored, and the restored chain verifies** (`ok: true`). The
   character decoder is `StringDecoder`, and the block file has one
   serializer (`serializeBlockForDisk`) in all five places that write one.
   The gate goes through the real writer and the real reader and pins
   each side separately: reverting the writer fails it (60 lines for 5
   blocks), reverting the reader fails it (the legacy archive stops
   restoring), reverting the decoder fails it (`hash mismatch at block
   1`). The round trip is now **byte-identical** — 297 of 297 restored
   blocks compare equal to the originals with `cmp`, which is a property
   that could not even be stated before, because the two sides wrote
   different bytes.
   The gate that missed all of this is in §5.1: it tested a writer that
   does not exist.

None of these is a crash. Most of them are the same shape: two copies of
one rule, with no gate that compares them.

Three of the eight were closed by the cleanup pass of 2026-11-22 —
items 2, 4 and 6 — and each of them turned out to have a second copy
hiding behind the first: the hash had a third formula that was
byte-identical to the second, the rotation had two env knobs that were
validated and ignored, and the insights chain stored its duplicated
evidence twice over because the chain adapter serialises the whole
payload into `content`. Finding the copies was the work; the gates that
now compare them are what keeps them from coming back. Item 6 kept a
copy of its own after that pass — the payload shrank, the copy of it
stayed — and it was closed on 2026-11-23 by the same rule applied at the
writer. Item 4 kept a copy of its own too: the rotation wrote archives
that could not be read back, and the gate that should have caught it was
testing a fixture instead of the writer. Item 7 was closed on the same
day by the same rule applied to the retention.


A later pass of the same day found the same shape in the skills. A
skill lived in the repository and again in the runtime, with no
manifest anywhere, so `memphis skills show halt-aware-destructive-ops`
answered "manifest not found" for the guard every destructive operation
passes through — and the runtime copy of `usb-grabber-feed` was the
stale one of the two. The repository is now the single source of truth
for every skill, the runtime holds a materialization of it, and the
runtime audit grew a `skill-catalog` check that fails when a repository
skill is invisible to the runtime or when the two copies differ. The
`memphis_commit_culture` stub went the other way: a tool that never
existed, described by an interface document with no implementation,
which is what "remove what only looks like work" looks like.

The same day's third pass made the rotation OPERABLE, which turned out
to be the same shape twice more.

**The loop was silent when it had nothing to do.** It logged only when a
chain actually rotated, so a tick that found nothing was invisible.
Measured 2026-11-23 on this host: the service log held six
`chain.rotation.loop.started` events and not one `chain.rotation
.scheduled` — which reads as "the loop never ticks". The loop HAD
ticked, hourly, and every tick had found nothing to rotate, because the
threshold could not fire. The silence was the symptom, not the cause,
and it cost an hour of looking for a dead timer that was running fine.
Every tick now logs `chain.rotation.scheduled.start`, which is the shape
the scheduled backup already had (`backup.scheduled.start`).

**The command the documentation promised did not exist.** The rotation
loop's own header said "Operator-driven `chain rotate` has shipped since
Sprint 4". The subcommand was never registered: `memphis chain rotate
--chain insights` answered "Unknown chain subcommand: rotate". It is
registered now, and it says which knobs it used — because the third
shape was hiding behind the second: the operator's threshold lives in
the service's systemd drop-in, a shell has no such variables, and a
command run from a shell would have compared against the code default
(50 MB) while the service compares against the operator's threshold
(10 MB). "Nothing to do" would have looked like a decision rather than
a different number. The command now resolves the knobs in the
operator's order of intent — the flag, then the shell, then the
service's configured environment, then the code default — and reports
which one answered.

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
