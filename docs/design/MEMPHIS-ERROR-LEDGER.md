# The error ledger — Memphis runtime, measured 2026-11-23

> **What this document is.** A list of the defects that are OPEN on this host,
> each one with a measurement taken today, grouped by the family it belongs to,
> and then the connections between them: which error causes which, and which
> one to fix first.
>
> **How it was made.** Every entry below was measured on the operator's host on
> 2026-11-23, in the running repository. Two forensic passes over the tree
> (crash/hang paths, and the Rust↔TypeScript boundary) produced a list of
> hypotheses; **six of those hypotheses were false and are listed in §4 as
> rejected**, because a defect list that inherits other people's conclusions is
> a defect list with the same disease it is trying to cure.
>
> The house pattern for everything here: one function per arm, one artefact of
> cases, two runners. A gate is only as good as its corpus, so every gate below
> was proven to FAIL against a deliberately broken implementation.

---

## 1. The open errors

### Family A — one rule, two owners, no gate

The data plane is Rust's. TypeScript reaches it through one N-API binary. Every
defect in this family is a rule that exists on both sides of that bridge and is
compared by nobody.

#### E-01 · The bridge's export vocabulary is hand-written on the TypeScript side, and it has drifted

The Rust crate declares 37 exports. The TypeScript side names them in
`BRIDGE_EXPORT_ALIASES` (`src/infra/storage/rust-bridge-manifest.ts`) — a
hand-written map with 34 keys and 68 spellings.

> Measured 2026-11-23 on this host, against the built binary
> (`crates/memphis-napi/index.node`, 37 exports read from the module itself):
>
> - **0 phantoms** — every TypeScript key resolves to a real export.
> - **3 gaps** — the bridge exports `embed_clear_in_memory`,
>   `embed_discard_replacement` and `embed_index_metadata`, and the TypeScript
>   mirror **cannot name them**. Code on this side cannot call them.
> - **34 of the 68 alias spellings never match anything.** The bridge's naming
>   is mixed by accident: 20 exports set `js_name = "<snake_case>"` explicitly
>   and 11 do not, so napi-rs exports some as `chain_append` and others as
>   `pathsResolveDataDir`. The mirror guesses both spellings for everything.

**And the Rust side was wrong too.** The vocabulary was declared in THREE
places, not two: the crate's `bridge_manifest()` carried a hand-written list
of **34** names — it omitted the three exports above, and it named nine of
the rest with a spelling the bridge never exports (`paths_resolve_data_dir`
where the bridge exports `pathsResolveDataDir`, and the same for the other
`paths_*` and `mv2_*` exports). Twelve places wrong, in the file that was
supposed to be the owner.

**CLOSED 2026-11-23** — this was the first step (§3). The vocabulary now has
one owner:

| piece | what it is |
| --- | --- |
| `crates/memphis-napi/src/bridge_exports.rs` | **the owner** — one table: canonical name, JavaScript name, whether it is required |
| `crates/memphis-napi/src/lib.rs` | `bridge_manifest()` serves that table, and the manifest now carries the `canonical → jsName` bindings |
| `scripts/sync-bridge-export-contract.mts` | the projection: the Rust table → `tests/fixtures/bridge-export-contract.json` (the artefact) and `src/infra/storage/bridge-exports.generated.ts` (the mirror, no longer hand-written) |
| `crates/memphis-napi/tests/bridge_export_contract.rs` | the Rust arm: the table against the crate's own `#[napi]` declarations, plus the required floor |
| `tests/unit/bridge-export-contract.test.ts` | the TypeScript arm: the mirror against the artefact, and the artefact against the REAL binary |

The projection refuses to run when the manifest and the built module
disagree, so a manifest that lies about its own crate cannot be projected
into a mirror that would inherit the lie. Seven falsifiers, and the first
run of them found a HOLE in the gate itself: flipping one export's
`required` flag was caught by nothing, because the flag is a policy and the
projection only copies it. The gate now holds the required FLOOR in the
Rust arm, so relaxing it is a deliberate change to the gate rather than a
quiet edit in the table.

Measured after: the mirror names **37** exports (was 34), the three
unreachable ones are reachable, and every export of the binary can be named
from TypeScript.

#### E-03 · The chain-name rule has four owners

> Measured: TypeScript has ONE owner — `SAFE_CHAIN_NAME`
> (`src/memory/chain-catalog.ts:333`), used by 3 call sites. Rust has THREE:
> `is_plain_chain_name` (`crates/memphis-operator/src/chat_memory.rs:1041`),
> `is_active_chain_name` (`crates/memphis-operator/src/runtime.rs:863`) and
> `normalize_chain_name` (`crates/memphis-paths/src/lib.rs:149`). No fixture
> compares them.

#### E-04 · One bridge path bypasses the central resolver

> Measured: `src/infra/storage/case-chain-adapter.ts:48` resolved the bridge as
> `rawEnv.RUST_CHAIN_BRIDGE_PATH ?? './crates/memphis-napi'` — a **relative**
> path, resolved against the process's working directory.
> `src/infra/runtime/install-root.ts:169-174` documents that this exact footgun
> was centralised away from five sibling files ("`Rust vault bridge not found at
> ./crates/memphis-napi` because `loadBridgeModule` resolved the relative path
> against `process.cwd()`"). **This one survived it** — and it was the last
> one: the vault, the embed and the chain adapters all delegate to
> `resolveRustBridgePath`, verified by reading each of them.

The consequence was not an error: in a shell whose working directory is not
the checkout, the bridge simply failed to load, `rustAvailable` flipped to
`false`, and the adapter fell back to the TypeScript implementation of the
same rule. A silent switch between two implementations, decided by the
working directory.

**CLOSED 2026-11-23.** The adapter now uses the central resolver, and its
three-entry alias map now takes its spellings from the GENERATED vocabulary
instead of writing them out by hand. The gate
(`tests/unit/case-chain-bridge-path.test.ts`, 5 tests) pins the anchoring;
reverting the fix fails 4 of the 5, including the exact symptom
(`expected './crates/memphis-napi' to be '/home/memphis/memphis/crates/memphis-napi'`).

#### E-09 · The bridge's payload types do not exist on the TypeScript side

> Measured: there is **no `index.d.ts`** for the N-API module. Six places parse
> the bridge's JSON with a blind cast. `rust-vault-adapter.ts:100-101`
> declares both `entries_json?` and `entriesJson?` and reads
> `result.entries_json ?? result.entriesJson` — the contract is GUESSED, and
> the guess is written down twice.

This is the same family as E-01, one layer in: E-01 is the vocabulary of the
bridge, E-09 is the shape of what it carries. Closing E-01 properly is what
makes E-09 closable (the projection that produces the vocabulary can produce
the types from the same source).

### Family B — the system degrades quietly instead of failing

Every defect here answers with something plausible. The operator cannot tell
"worked" from "worked badly", and that is what turns a bug into a wedge (§2).

#### E-02 · The embed profile is two knobs that contradict each other

The dimension and the index path are configured separately, and their DEFAULTS
belong to two different eras.

> Measured 2026-11-23 on this host:
>
> | process | index it reads | dim | result |
> | --- | --- | --- | --- |
> | with the service env | `embed/bge-m3-20261106/index-v1.json` | 1024 | search works, 3 hits |
> | without it (any script, any spawned process) | `embed/index-v1.json` (stale, 82 KB) | 768 on disk vs **32** configured | `embed_search: index_dimension_mismatch: disk_dim=768 config_dim=32` |
>
> The recall swallows that error and falls back to exact search. The operator
> gets plausible answers and never learns the semantic half is off.

#### E-05 · Fifteen recovery turns wait for an operator who cannot clear them from where he is

> Measured: `memphis recovery list` reports **46 turns, 15 of them
> `needsAcknowledgement`** (session `tui-6b016ba6`, all `interrupted`, with
> unsettled tool operations). The acknowledgement path demands a local
> interactive terminal and the operator's passphrase
> (`src/infra/cli/handlers/recovery.handler.ts:12`), and the TUI has no
> recovery command — only two hint strings that point at the CLI.

The mechanism is a loop, and §2 is about it: a stale `running` checkpoint
blocks every turn in the session (`crates/memphis-operator/src/chat.rs:290`),
and `RunningCheckpointGuard`'s own doc comment admits that "a hard process kill
still leaves `running`". **The operator's cure — killing the process — creates
the next wedge.**

#### E-07 · A clean drain exits 0, so systemd does not restart the runtime

> Measured: `src/infra/runtime/graceful-shutdown.ts:368` — `const exitCode =
> drained ? 0 : 75;` — and the unit sets `Restart=on-failure`. An exit 0 leaves
> the runtime down, with no restart and nothing in the log to say why.

#### E-08 · The backup retention stops when the restore drill fails

> Measured: `~/.memphis/backups` holds **3.3 GB in 27 archives**.
> `src/infra/runtime/scheduled-backup.ts:301-303` skips pruning whenever
> `state.lastDrillOk === false` — so one failed drill stops the retention
> permanently, and the disk grows until something else has to make room.

### Family C — dead code, committed

#### E-06 · Two backup files are in the repository

> Measured: `src/infra/cli/dispatcher.ts.backup` (2 889 B) and
> `src/providers/anthropic/oauth-flow.ts.bak` (12 753 B) — **15 642 B** in
> total, imported by nothing (grep over `src/`, `tests/` and `scripts/` finds
> no reference to either). The first one is an OLD dispatcher with the OLD
> handler list: a second copy of the CLI's routing, waiting for the next
> reader to edit the wrong file.

**CLOSED 2026-11-23.** Both files are gone, after a HALT pre-flight and
through the recoverable-delete path.

---

## 2. How one error connects to the next

The list above is not a list. It is one loop with three families feeding it.

```text
   ┌──────────────── Family A: a rule with two owners ────────────────┐
   │                                                                    │
   │  E-01 bridge vocabulary ─┐                                        │
   │  E-03 chain-name rule ───┼──► the answer depends on WHICH side    │
   │  E-04 path bypass ───────┘    of the bridge you happened to reach  │
   │                                                                    │
   └───────────────────────────────┬───────────────────────────────────┘
                                   │  the two sides disagree, and the
                                   │  disagreement is invisible
   ┌──────────────── Family B: quiet degradation ──────────────────────┐
   │                                                                    │
   │  E-02 semantic search off, exact search on ─┐                    │
   │  E-07 runtime exited 0, no restart ─────────┼──► the operator    │
   │  E-08 disk filling up ──────────────────────┘    cannot tell      │
   └───────────────────────────────────────────────────┬────────────────┘
                                                       │
                                                       ▼
                             ┌──────────────────────────────────────┐
                             │  E-05 the wedge: every turn refused,   │
                             │  the cure (kill -9) re-creates it, the  │
                             │  escape needs a local TTY + a         │
                             │  passphrase, and the TUI has no       │
                             │  command to clear it                 │
                             └──────────────────────────────────────┘
```

**The loop, in the operator's own terms.** A degradation in Family B produces
an answer that LOOKS like an answer. The operator cannot tell "worked" from
"worked badly", so he does the only thing available: he kills the runtime. The
kill leaves a `running` checkpoint (E-05), the next process is refused every
turn, and the only escape is a local terminal with the operator's passphrase —
which the cockpit he actually uses cannot ask for. So he kills it again. The
wedge is self-sustaining, and **the loop is fed by quiet degradation, not by
the wedge itself.**

That is why E-02 and E-07 are not "two small bugs" in this list. They are the
two links that keep E-05 alive. Fixing E-05 alone (acknowledging the 15 turns)
would clear today's symptom and leave the loop intact.

**And the connections inside Family A are the same shape one layer down.** E-01,
E-03 and E-04 are not three unrelated bugs: they are three instances of the
defect this repository's own ledger keeps finding — *one rule, two owners, no
gate that compares them*. E-01 is the bridge's vocabulary, E-03 is the rule
that decides whether a chain name is safe, E-04 is the rule that decides
where the bridge lives. The block hash (closed 2026-11-23) and the tool
contract (closed by ADR-012) were the same shape.

**So there are two ways to spend the next rounds**, and the ledger is explicit
about the difference:

| | what it fixes | what it costs |
| --- | --- | --- |
| **Break the loop (Family B first)** | the operator gets loud failures; the wedge stops feeding itself | does not make the runtime *developed* — it makes it honest |
| **Close the owners (Family A first)** | the boundary stops being a guess | does not stop the loop today |

The house has already decided which of these it does first: the ledger's own
rule is "one owner per rule, one artefact, two runners", and every gate in
this repository is of that shape. A runtime is called *developed* when its
rules have owners and its owners are compared. Honesty without owners is a
runtime that fails well.

---

## 3. The first step

**Give the bridge's export vocabulary one owner, and a gate that compares it.**

Chosen because:

1. **It is the keystone of the reference architecture.** "Rust owns the data
   plane, N-API is the only bridge" is only true if the bridge's own
   vocabulary has ONE owner. Today it has two, and they have already drifted
   (3 exports unreachable from TypeScript).
2. **It is measured, with a visible drift** — not a hypothesis: 37 real
   exports against a 34-key hand-written map.
3. **The house pattern for it already exists.** ADR-012 did exactly this for
   the tool contract: the projection is JSON, both arms read it, neither can
   change it alone. This is that pattern one layer down.
4. **It generalises.** The same projection can produce the chain-name rule's
   cases (E-03) and the payload types (E-09) — which is why it is a STEP and
   not a one-off.

**The shape of the work** (one function per arm, one artefact, two runners):

- the Rust source is the owner; a projection reads the `#[napi]` declarations
  and writes `tests/fixtures/bridge-export-contract.json`;
- the projection also writes the TypeScript mirror, so the mirror is no longer
  hand-written — the 34 dead spellings cannot survive a regeneration;
- runner 1 (TypeScript) checks the mirror against the artefact, and the
  artefact against the REAL binary when it is present;
- runner 2 (Rust) checks the artefact against the crate's own declarations.

**The falsifier:** a Rust export added without re-projecting, an export
removed, a `js_name` changed, or a mirror entry deleted each fail the gate.
A gate that cannot fail is a convention.

**What it does NOT close:** the payload types (E-09), the chain-name rule
(E-03), and everything in Family B. Those are the next steps, and the ledger
says so.

---

## 4. Rejected: hypotheses that measurement killed

Listed so that nobody spends a round on them again.

| Hypothesis | What the measurement said |
| --- | --- |
| The `src/` tree still reverts the #767 stale-WAL-lock fix, so the next build restores a busy-wait | **False.** `src/infra/storage/task-queue-wal.ts`, `src/infra/runtime/process-lock.ts` and `tests/unit/task-queue-wal.test.ts` all match commit `807350e85e` byte for byte. The fix is present. |
| Two different native binaries are reachable in production (the service's release `.so` and the CLI's debug `index.node`) | **False today.** `crates/memphis-napi/index.node` and `target/release/libmemphis_napi.so` are the same file — sha256 `0f47b84c81c8e3ea…`, 7 377 664 B. It was true on 2026-11-21 (a 58.7 MB debug build) and was closed by `scripts/check-native-bridge.mts`, which now gates artifact freshness, the split brain, and `catch_unwind` on every export (added 2026-11-22, commits `722653bb05`, `370014cf90`). |
| `scheduler.tick()` can reject and kill the daemon every 30 s | **False.** `tick()` has its own `try`/`catch`/`finally` (`src/infra/runtime/scheduler.ts:1012`+), and the daemon policy does not exit on an unhandled rejection either. |
| The block hash is computed by several different formulas | **False since 2026-11-23.** `src/core/chain-hash.ts` is the only TypeScript owner; the native owner is `crates/memphis-core/src/hash.rs`, and the two are compared by `tests/fixtures/block-format-parity.json`. |
| The public chat loads every block of three chains per request | **False since 2026-11-23.** `PUBLIC_CHAIN_TAIL_LIMIT = 1000` windows the non-journal chains and the reader is streaming (`readPublicCandidates`). |
| The consent gate and the relay have no tests | **False since 2026-11-23.** 22 tests, 12 falsifiers. |
| The fatal guard decides "daemon" by scanning argv for `serve`, and the parser lets a boolean flag eat the command | **False since 2026-11-23.** Both closed, with 18 tests and 11 falsifiers. |

---

## 5. What "developed" means here, measurably

A runtime is developed when every rule has one owner, every owner is compared
by a gate that can fail, and no failure is quiet. Written as checks, so it can
be run rather than admired:

1. **Every rule has one owner.** No rule about blocks, hashes, chain names,
   paths, the bridge vocabulary or the tool contract is decided in two places
   in the same arm, or in one place in each arm without a fixture.
2. **Every cross-boundary rule has an artefact and two runners.** One JSON
   file, read by the TypeScript arm and by the Rust arm; neither arm produces
   it alone.
3. **Every gate can fail.** Each new gate ships with its falsifiers, proven
   by mutating the implementation and watching the gate go red.
4. **No quiet degradation.** A failure says so. No fallback answers a
   question with a worse answer without saying which one it used.
5. **No dead code in the tree.** No `.bak`, no `.backup`, no second copy of a
   rule that only looks like work.
6. **The artefacts are generated, never hand-written.** A hand-written
   expected value is a second copy the moment it is written.
7. **The measurement is on this host.** Every claim in this ledger is a number
   taken here, and the numbers have dates.

State today, measured 2026-11-23: (1) **fails** — E-01 and E-04 are closed,
E-03 and E-09 remain; (2) **fails** — E-03 and E-09 remain, the bridge's
vocabulary now has its artefact and its two runners; (3) **holds** — every
gate added in the last three rounds ships with proven falsifiers, and the
bridge gate found a hole in itself on its first run; (4) **fails** — E-02,
E-05, E-07, E-08; (5) **holds** — the two dead files are gone; (6) **holds**
— the block-format, tool-contract and bridge-vocabulary artefacts are
generated; (7) **holds**.

The first step closed (1) and (2) for the bridge's vocabulary, and (5) on the
way through; the second closed (1) for the bridge path. **Next, in this
order:** E-03 (the chain-name rule — four owners today, with the ADR-012
pattern ready: one fixture, two arms), then E-02 (the embed profile — two
knobs that contradict each other, the cheapest of the quiet-degradation
family), then E-09 (the payload types), which the projection just built can
now carry, and only then Family B's wedge (E-05), which needs the operator's
fifteen acknowledgements before any code can help.
