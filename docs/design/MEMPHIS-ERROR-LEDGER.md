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

**Measured consequence.** The three Rust rules were not three copies of one
rule — they were THREE RULES, and the third answered a different question.
`is_active_chain_name` asked "does the name end in `.backup-<digits>`?" and
nothing else:

| directory under `chains/` | TypeScript registry | Rust `is_active_chain_name` |
|---|---|---|
| `journal` | chain | chain |
| `journal.backup-1784913076785` (epoch stamp) | archive | not a chain |
| `cases.backup-2026-07-07T15-07-23-108Z` (dated stamp) | archive | **a live chain** |
| `.archives` (the rotation's dot-directory) | not a chain | **a live chain** |
| `_quarantine` | a plain name — the taxonomy decides | a plain name — the taxonomy decides |

So the treatment of an archive depended on the SHAPE OF ITS TIMESTAMP, and a
dot-directory was a chain. Three numbers for one host, measured on the same
disk state (2026-11-23):

| figure | owner | value |
|---|---|---|
| the runtime's status `blocks:` | Rust `count_chain_blocks` | **11 510** blocks in 14 directories |
| the live chains' own blocks | the chains | **11 234** blocks in 12 directories |
| the audit's `totalBlocks` | TypeScript `collectBlockVocabulary` | **11 981** blocks |

The 276-block gap between the first two numbers was one archive of `cases`
(`cases.backup-2026-07-07T15-07-23-108Z`, 276 blocks) counted as if it were
the chain itself. The same rule counted `.archives` — the dot-directory the
rotation writes its `.jsonl.gz` files into — as a chain, so the cockpit
listed it as one.

| file | role |
|---|---|
| `crates/memphis-paths/src/chain_names.rs` | **the owner** — one module: the plain-name pattern, the archive stamp forms, the alias table, and `classify_chain_directory()` |
| `crates/memphis-napi/src/lib.rs` | the owner speaks to the TypeScript arm: `bridge_chain_name_manifest()` (the vocabulary) and `bridge_chain_name_facts()` (one name's verdict) |
| `scripts/sync-chain-name-contract.mts` | the projection: the owner → `tests/fixtures/chain-name-contract.json` (the artefact, 36 cases) and `src/memory/chain-names.generated.ts` (the mirror, no longer hand-written) |
| `crates/memphis-paths/tests/chain_name_contract.rs` | the Rust arm: the owner against the artefact |
| `tests/unit/chain-name-contract.test.ts` | the TypeScript arm: the mirror against the artefact |

The projection reads the owner's answers through the BUILT BRIDGE rather
than re-implementing the rule, so the artefact carries the owner's verdicts
and not the projection's own arithmetic.

The falsifier is in `crates/memphis-operator/src/runtime.rs`: it seeds a dated
archive and a `.archives` directory and asks what the runtime counts. Before
the fix it answered `[".archives", "cases.backup-2026-07-07T15-07-23-108Z",
"journal"]` and 2 blocks; after, `["journal"]` and 1.

Measured after: the runtime's status counts **11 234** blocks in **12**
directories — the live chains and nothing else. The audit still counts
**11 981**, because verifying an archive IS part of its job, and the label
it puts on that number now says "scannable" instead of "live" (747 of those
blocks were copies of a chain, not new memory).

**Residual.** The NAME rule is shared now; the TAXONOMY is not. The
TypeScript registry knows which chains Memphis has (`CHAIN_CATALOG`), the
native runtime does not, so the native side lists `_quarantine` as a chain
and the TypeScript side does not — 12 directories against 11. `_quarantine`
holds 0 blocks, so no number moves today; a directory with blocks in it
would. Publishing the taxonomy to the native arm is a decision, not a
repair, and it belongs to the ADR the ownership question opens.

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

#### E-10 · The published tarball is not the thing the gates look at

`package.json`'s `files` list decides what npm publishes. It is a list of
omissions, and nothing read it back.

> Measured 2026-11-23 on this host, on the tagged commit `34cb179074`
> (v1.14.0): the tarball published
> `dist/infra/cli/commands/backup-manifest.js` and did **not** publish
> `scripts/backup-manifest.mjs`, which that module imports at LOAD time. The
> `release` workflow's first step failed on it:
>
> ```
> [ERROR] Failed to load Memphis CLI: Cannot find module
>   '.../node_modules/@memphis-chains/memphis/scripts/backup-manifest.mjs'
> ```
>
> The import is at module scope, so the omission broke **every** CLI command,
> not one — `memphis completion bash` was simply the first probe. Introduced
> by `f4b9bc2875`; `git log -S"scripts/backup-manifest.mjs" -- package.json`
> was empty, so the path had never been published.

The second half of the defect was the gate list. The local preflight
(`ops:release-preflight`) ran nine gates and **none of them touched the
tarball**, so it reported `ok: true` for an artefact that could not start. The
proof lived in the `release` workflow only — the one place the operator does
not run by hand.

**CLOSED 2026-11-23.** The rule is inverted: the omissions are DISCOVERED
instead of the list being trusted.

| piece | what it is |
| --- | --- |
| `scripts/check-package-runtime-closure.mts` | **the owner** — finds every file the shipped code imports from outside its own tree |
| `tests/fixtures/package-runtime-closure.json` | the artefact of cases (2 edges on this host) |
| `scripts/check-package-runtime-closure.mts --check` | one runner: the gate |
| `tests/ops/package-runtime-closure.test.ts` | the other runner: the test, importing the owner |

And the suite is the same on both sides: `ops:release-preflight` now runs
**both** packaging gates — the fast closure check (seconds) and
`ops:validate-package-artifact` (packs, installs and executes the real
binary). Measured: the artefact validation fails with the exact CI message
when the path is removed from `files`, and passes with it.

#### E-11 · A gate that was green where it was measured, and red where it was not

The public chat's `/ready` answers 200 only when the provider is configured
**and** the basal layer is healthy. The basal layer is an HTTP service on
127.0.0.1:8000. The relay's test asked the **real** service.

> Measured 2026-11-23 on this host: `http://127.0.0.1:8000/health` answers
> `{"ok":true,"ready":true,…}` — so `publicBasalReady()` is true and the test
> passed. On a CI runner nothing listens on that port, the fetch is refused,
> `publicBasalReady()` is false, and the test failed with
> `expected 503 to be 200` — the required `cross-arch (ubuntu-24.04-arm)`
> check was red, and the failure was already present on `34cb179074`.
>
> The test could not even be steered from the shell: the vitest setup
> deletes every `MEMPHIS_*` key (`tests/helpers/isolated-runtime.ts`), so
> `MEMPHIS_PUBLIC_BASAL_URL` is `undefined` inside the worker — measured.

**CLOSED 2026-11-23.** The readiness check is injected into the relay next
to the classifier that was already injectable, and the test pins the three
real cases — configured **and** basal ready (200), provider unconfigured
(503), basal not ready (503). The third was indistinguishable from the
second before. The test points the ambient basal URL at a closed port for
its duration, so it is its own falsifier: if the injection is ever dropped,
it fails with the CI message instead of quietly depending on the room.

E-10 and E-11 are the same shape from opposite ends: one gate did not look
at the thing that ships, and one gate looked at the world instead of the
contract. **A gate measures what it says it measures, on every machine it
runs on.**

### Family B — the system degrades quietly instead of failing

Every defect here answers with something plausible. The operator cannot tell
"worked" from "worked badly", and that is what turns a bug into a wedge (§2).

#### E-02 · The embed profile is two knobs that contradict each other

The dimension and the index path are configured separately, and their DEFAULTS
belong to two different eras.

> Measured 2026-11-23 on this host, at the recall surface
> (`runMemphisRecall` — the path the operator and the agent actually use):
>
> | process | index it reads | dim | result |
> | --- | --- | --- | --- |
> | the service (full `.env`, systemd `EnvironmentFile`) | `embed/bge-m3-20261106/index-v1.json` | 1024 | `mode: semantic`, `degraded: false`, 3 hits |
> | dim and path only, no provider model | the same index | 1024 | `provider returned invalid response: ollama returned embedding dimension 768, expected 1024` |
> | without it (any script, any spawned process, the CLI) | `embed/index-v1.json` (stale, 82 KB) | 768 on disk vs **32** configured | `embed_search: index_dimension_mismatch: disk_dim=768 config_dim=32` |
>
> **CORRECTION (2026-11-23, later the same day).** This entry used to end
> with "the recall swallows that error and falls back to exact search. The
> operator gets plausible answers and never learns the semantic half is
> off." The first half was measured and true; the second half was not. The
> recall result carries `degraded: true` and the error message itself
> (`warning: "embed_search: embed_search_failed: … index_dimension_mismatch:
> disk_dim=768 config_dim=32"`), and the mode tells the caller which half
> answered. So the operator is not left in the dark at the tool level.
>
> What the operator genuinely does NOT learn:
>
> 1. **Which profile is right.** The message names the numbers (768 on
>    disk, 32 configured) and says nothing about the working profile on
>    the same host (1024 + the bge-m3 index), so there is nothing to act
>    on.
> 2. **That the failure is decided by the environment.** The process that
>    fails is the process that did not get `.env` — a shell, the CLI, the
>    TUI started by hand, any spawned script.
> 3. **That the defaults are wrong.** The dim default `32` is written in
>    FOUR places (`src/infra/http/health.ts:405`,
>    `src/infra/tensors/status.ts:68`, and it is what
>    `src/infra/cli/commands/setup.ts:293` and
>    `src/infra/cli/onboarding-wizard.ts:68` write into a fresh install),
>    and the index-path default in TWO
>    (`src/infra/runtime/embedding-metadata.ts:25`,
>    `src/infra/http/health.ts:402`). So a fresh install reproduces the
>    broken profile by construction.
> 4. **That the two surfaces disagree.** `/health` runs in the service,
>    which HAS the env, and reports "dim=1024 matches index" — green. The
>    surfaces that fail are the ones without it. The green light is
>    measured in a different process than the one that breaks.
>
> The fix is the shape E-03 just took: ONE owner for the embed profile
> (dimension and path together), published to the TypeScript side the way
> the chain-name vocabulary now is, with the default derived from the index
> on disk instead of hard-coded in four places.

**CLOSED 2026-11-24.** The profile has ONE owner
(`crates/memphis-embed/src/profile.rs`), ONE artefact of cases, and TWO
runners — the same shape as E-03 and E-01.

| piece | what it is |
| --- | --- |
| `crates/memphis-embed/src/profile.rs` | **the owner** — the index path, the dimension, the model, the source of each, and the verdict |
| `tests/fixtures/embed-profile-contract.json` | the artefact of cases (14 cases, every one naming a committed fixture index) |
| `scripts/sync-embed-profile-contract.mts` | the projection: the rule and every verdict, asked of the owner THROUGH THE BUILT BRIDGE |
| `src/infra/storage/embed-profile.generated.ts` | the TypeScript mirror — the names, the sources, the verdicts, the local width |
| `crates/memphis-operator/tests/embed_profile_contract.rs` | the native runner (7 tests) |
| `tests/unit/embed-profile-contract.test.ts` | the TypeScript runner (10 tests) |

The dimension follows the INDEX on disk — the vectors a query has to match
— and only falls back to the local deterministic width when there is no
index to contradict it. The model is never guessed from a name.

The MODE vocabulary had one owner on the Rust side after this change and
THREE on the TypeScript side (the config schema's enum, the doctor's
`KNOWN_REMOTE_EMBED_MODES`, the wizard's validity check). All three now
take it from the projection, and the TypeScript arm checks that they do —
a provider the owner accepts and the wizard rejects is a setup that cannot
be finished; a provider the doctor does not know is a backend mislabelled
as local.

> Measured 2026-11-24 on this host, the owner asked for the two processes
> this machine actually has:
>
> | process | index | dimension | verdict |
> | --- | --- | --- | --- |
> | the service (systemd `EnvironmentFile`) | `embed/bge-m3-20261106/index-v1.json` | **1024** (from `env`) | `ok` |
> | a bare shell (the CLI, a hand-started TUI, any spawned script) | `embed/index-v1.json` | **768** (from `index`) | `no-provider` |
>
> Before the fix the second row answered **32** against an index that holds
> 768 — `index_dimension_mismatch: disk_dim=768 config_dim=32` — a
> mismatch that was not the cause. Now the dimension follows the index, so
> there is no mismatch to report, and the verdict names the cause that IS
> there: the shell has no provider configured.
>
> The two ways a wrong width costs are not the same, and the code now says
> which one is which. With a PROVIDER configured, the provider's own width
> is the truth and the provider path is STRICT (`parse_embedding_vector`,
> since PR #749): a 1024-wide answer to a 32-wide configuration is a loud
> error. With the LOCAL embedder the vector is always exactly `dim` wide,
> so nothing fails — a 32-wide query against a 768-wide stored vector
> scores 0.0 and recall matches nothing, SILENTLY.
>
> **A claim the code no longer supported.** The comment in
> `src/infra/http/health.ts` said the provider's vector was "truncated to
> the configured dim without warning". That was true on 2026-10-25 and
> stopped being true on 2026-11-06, when the provider path became strict
> (PR #749). The comment survived 18 days and was quoted here; it is now
> replaced by the measured behaviour.
>
> **The gate found a hole in its own artefact.** The first CI run of
> `ops:sync-embed-profile-contract -- --check` failed with `fixture
> tests/fixtures/embed-profile-contract.json is stale` — on the runner,
> with a fixture that was fine here. The cause: the owner's remedy is
> prose for a live host and names the index by its ABSOLUTE path, and the
> artefact carried that string as it came out of the owner. The cases'
> `indexPath` was already root-relative; the remedy was the same path
> spelled a second way, and it carried this machine's directory layout
> into every other checkout. The projection now normalises it the same way
> it normalises the path — a PRESENTATION rule, not a second copy of the
> profile rule — and both runners check that the remedy names the two
> dimensions, says how to rebuild, and carries no absolute path.
>
> That is the third time a gate in this ledger found a hole in itself
> (the bridge gate on its first run, the chain-name gate before its fix,
> this one on its first CI run), and the reason the pattern insists that
> a gate must be able to FAIL: a gate that has never failed is a gate
> nobody has tested.


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
says so. (E-03 was closed in the round after, with the same shape; E-09 and
Family B remain.)

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

State today, measured 2026-11-24: (1) **fails** — E-01, E-02, E-03 and E-04 are
closed, E-09 remains; (2) **fails** — the bridge's vocabulary, the chain-name
vocabulary and the embed profile have their artefacts and their two runners,
E-09 remains; (3) **holds** — every gate added in the last four rounds ships
with proven falsifiers; the bridge gate found a hole in itself on its first
run, the chain-name gate was run BEFORE its fix and failed with
`[".archives", "cases.backup-2026-07-07T15-07-23-108Z", "journal"]`, and the
embed-profile gate was run before the fix and failed with
`left: 32, right: 768` — and then failed AGAIN on its first CI run, on a
hole in its own artefact; (4) **fails** — E-05, E-07, E-08; (5) **holds** — the
two dead files are gone; (6) **holds** — the block-format, tool-contract,
bridge-vocabulary, chain-name and embed-profile artefacts are generated;
(7) **holds**.

The first step closed (1) and (2) for the bridge's vocabulary, and (5) on the
way through; the second closed (1) for the bridge path; the third closed (1),
(2) and (3) for the chain-name vocabulary; the fourth closed (1), (2) and (3)
for the embed profile. **Next, in this order:** E-09 (the payload types),
which the projection just built can now carry, and only then Family B's wedge
(E-05), which needs the operator's fifteen acknowledgements before any code
can help.
