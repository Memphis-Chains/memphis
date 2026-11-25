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

| piece                                                 | what it is                                                                                                                                                                            |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `crates/memphis-napi/src/bridge_exports.rs`           | **the owner** — one table: canonical name, JavaScript name, whether it is required                                                                                                    |
| `crates/memphis-napi/src/lib.rs`                      | `bridge_manifest()` serves that table, and the manifest now carries the `canonical → jsName` bindings                                                                                 |
| `scripts/sync-bridge-export-contract.mts`             | the projection: the Rust table → `tests/fixtures/bridge-export-contract.json` (the artefact) and `src/infra/storage/bridge-exports.generated.ts` (the mirror, no longer hand-written) |
| `crates/memphis-napi/tests/bridge_export_contract.rs` | the Rust arm: the table against the crate's own `#[napi]` declarations, plus the required floor                                                                                       |
| `tests/unit/bridge-export-contract.test.ts`           | the TypeScript arm: the mirror against the artefact, and the artefact against the REAL binary                                                                                         |

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

| directory under `chains/`                             | TypeScript registry                 | Rust `is_active_chain_name`         |
| ----------------------------------------------------- | ----------------------------------- | ----------------------------------- |
| `journal`                                             | chain                               | chain                               |
| `journal.backup-1784913076785` (epoch stamp)          | archive                             | not a chain                         |
| `cases.backup-2026-07-07T15-07-23-108Z` (dated stamp) | archive                             | **a live chain**                    |
| `.archives` (the rotation's dot-directory)            | not a chain                         | **a live chain**                    |
| `_quarantine`                                         | a plain name — the taxonomy decides | a plain name — the taxonomy decides |

So the treatment of an archive depended on the SHAPE OF ITS TIMESTAMP, and a
dot-directory was a chain. Three numbers for one host, measured on the same
disk state (2026-11-23):

| figure                         | owner                               | value                               |
| ------------------------------ | ----------------------------------- | ----------------------------------- |
| the runtime's status `blocks:` | Rust `count_chain_blocks`           | **11 510** blocks in 14 directories |
| the live chains' own blocks    | the chains                          | **11 234** blocks in 12 directories |
| the audit's `totalBlocks`      | TypeScript `collectBlockVocabulary` | **11 981** blocks                   |

The 276-block gap between the first two numbers was one archive of `cases`
(`cases.backup-2026-07-07T15-07-23-108Z`, 276 blocks) counted as if it were
the chain itself. The same rule counted `.archives` — the dot-directory the
rotation writes its `.jsonl.gz` files into — as a chain, so the cockpit
listed it as one.

| file                                                | role                                                                                                                                                                          |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `crates/memphis-paths/src/chain_names.rs`           | **the owner** — one module: the plain-name pattern, the archive stamp forms, the alias table, and `classify_chain_directory()`                                                |
| `crates/memphis-napi/src/lib.rs`                    | the owner speaks to the TypeScript arm: `bridge_chain_name_manifest()` (the vocabulary) and `bridge_chain_name_facts()` (one name's verdict)                                  |
| `scripts/sync-chain-name-contract.mts`              | the projection: the owner → `tests/fixtures/chain-name-contract.json` (the artefact, 36 cases) and `src/memory/chain-names.generated.ts` (the mirror, no longer hand-written) |
| `crates/memphis-paths/tests/chain_name_contract.rs` | the Rust arm: the owner against the artefact                                                                                                                                  |
| `tests/unit/chain-name-contract.test.ts`            | the TypeScript arm: the mirror against the artefact                                                                                                                           |

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
./crates/memphis-napi` because `loadBridgeModule` resolved the relative path
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

**MEASURED 2026-11-24, on the built module, not on the source.** The guess
was not carelessness — the owner speaks TWO conventions:

| export                | the field on the wire       | why                                                     |
| --------------------- | --------------------------- | ------------------------------------------------------- |
| `vault_load_state`    | `error_code`                | the struct sets `#[napi(js_name = "error_code")]`       |
| `vault_decode_entry`  | `errorCode`                 | that struct sets NO `js_name`, so napi-rs camelCases it |
| `vault_parse_entries` | `entriesJson`               | the same                                                |
| `vault_store`         | `created_at`                | explicit `js_name`                                      |
| `vault_init_full`     | `master_key`, `qa_question` | explicit `js_name`                                      |

One hand-written TypeScript interface (`EntryBridgeResult`) had to cover two
different payloads, so it hedged over both spellings — and the hedge was
written down twice. The Rust owner is the only place that has to know, and
now it says so.

Also measured: `Option` fields of a `#[napi(object)]` struct are **omitted**
when they are `None` (the error path of `vault_parse_entries` returns exactly
one key, `errorCode`), while a `serde` `Option` inside a JSON envelope is
present and `null`. The vocabulary distinguishes the two.

**PARTIALLY CLOSED 2026-11-24 — the mechanism is in, and by the end of
phase 5 EVERY family is migrated: the counter of surfaces that own a
payload type by hand is EMPTY.** One owner, one artefact, two runners:

| piece                                                  | what it is                                                                                                                 |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| `crates/memphis-napi/src/bridge_payloads.rs`           | **the owner** — one table: the export, the transport, the shape, the field names napi-rs really exports                    |
| `crates/memphis-napi/src/lib.rs`                       | `bridge_payload_manifest()` — the table, served through the built module (`required: false`, so an old binary still loads) |
| `scripts/sync-bridge-payload-contract.mts`             | the projection: reads the table from the BUILT module, writes the artefact and the TypeScript mirror                       |
| `tests/fixtures/bridge-payload-contract.json`          | the artefact (26 payloads, 35 shapes — measured 2026-11-24, after phase 5)                                                 |
| `src/infra/storage/bridge-payloads.generated.ts`       | the TypeScript mirror — a projection, not a second hand-written copy                                                       |
| `crates/memphis-napi/tests/bridge_payload_contract.rs` | runner 1: the table against the crate's own structs, and the artefact                                                      |
| `tests/unit/bridge-payload-contract.test.ts`           | runner 2: the mirror, the REAL binary (the third witness), and the ratchet                                                 |

The Rust runner applies napi-rs's own rule to every field of every shape —
an explicit `js_name` verbatim, a field without one in camelCase — so the
table cannot drift from the struct it claims to describe.

**Falsifiers, measured on this host:** changing one field name in the table
(`entriesJson` → `entries_json`) fails the Rust runner with _"the table says
entries_json, but napi-rs will export entriesJson"_; putting the hedge back
into the TypeScript adapter fails the ratchet; a stale artefact fails the
projection's check mode, which runs in CI.

**PHASE 2 CLOSED 2026-11-24 — the embed family** (PR #779, squash
`67e5db32c1`). The same mechanism, the
second family. Measured on the built module against an ISOLATED index
(`RUST_EMBED_PERSIST_PATH` pointed at a scratch directory, so the
operator's own index was not touched):

| export                                  | the payload on the wire                                                                    |
| --------------------------------------- | ------------------------------------------------------------------------------------------ |
| `embed_store`                           | id, count, dim, dtype, provider, normalized, persistence_enabled, persistence_load_state   |
| `embed_store_many`                      | inserted, count, dim, dtype, provider, normalized, persistence_enabled                     |
| `embed_flush`                           | flushed, dim, dtype                                                                        |
| `embed_search` / `embed_search_tuned`   | query, count, dim, dtype, provider, normalized, hits                                       |
| `embed_clear_in_memory` / `embed_reset` | cleared                                                                                    |
| `embed_discard_replacement`             | **TWO shapes**: 3 keys without an initialized pipeline, 7 with it                          |
| `embed_index_metadata`                  | schemaVersion, path, formatVersion, state, documents, invalidRecords, dimension, sizeBytes |

Three findings the source does not say out loud:

1. **`embed_discard_replacement` carries TWO shapes.** Without an
   initialized pipeline it answers `{ discarded, was_initialized,
replacement_state }`; with one it answers SEVEN keys. The TypeScript
   side declared `{ discarded: boolean }` and cast the other six away —
   it did not know they were there. The payload is now a struct
   (`EmbedDiscardOut`) whose `#[serde(skip_serializing_if)]` keeps the
   wire EXACTLY as measured: absent, not null, same keys, same order.
2. **The wire's `normalized` is a WORD, not a boolean** — `"true"` or
   `"provider-dependent"`, never `"false"`, never missing (the Rust side
   has answered exactly those two since the field appeared in
   `0263334de0`). The TypeScript side declared `boolean | string` and
   wrote a helper to guess which it had got — including a branch for a
   `"false"` that cannot arrive and a fallback for a missing value that
   cannot arrive either. All three are gone: the vocabulary is owned, and
   the mirror renders `normalized: 'true' | 'provider-dependent'`.
3. **A closed vocabulary needs an owner too.** The owner declares the
   words AND the function that writes them; the Rust gate parses that
   function out of the crate's source and compares, so the owner can
   neither invent a word the crate never writes nor forget one it does.
   The literal that is not a word of the field (the provider name
   `embed_normalized_to_str` compares against, the `"ndjson"` extension
   `inspect_index` looks for) is declared as an extra, so the comparison
   stays exact.

The Rust runner grew with the family: it now parses the `serde` structs
too, applies serde's OWN rule (copied from `serde_derive`'s
`internals/case.rs`, not approximated), checks the TYPE of every field
and its PRESENCE (a napi `Option` is omitted, a serde `Option` is
`null`, a `skip_serializing_if` field is absent), and checks every
vocabulary against the source that produces it.

**Dead code cut, measured:** the chain adapter's `embedStore` and
`embedSearch` had NO callers anywhere in the tree, and with them three
hand-written copies of the embed payloads (`EmbedStoreResult`,
`EmbedSearchHit`, `EmbedSearchResult`) — one of which silently dropped
the `tags` field of every hit. Gone.

**Falsifiers, measured on this host (phase 2):** a misspelled field in the
table fails the Rust runner with _"the table says normalised, but the wire
will carry normalized for EmbedStoreOut.normalized"_; a vocabulary word
the crate never writes fails it with _"the vocabulary of normalized is
{…'false'…}, but the source writes {…}"_; a hand edit in the generated
mirror fails the projection's check mode with exit 1; putting
`RawEmbedStoreResult` back fails the ratchet with _"the embed family has
no hand-written payload type left"_. The WIRE did not move in MEANING:
the probe before and after the struct conversion answers the same keys
with the same values. Its key ORDER did move, and the ledger used to
claim otherwise — see the note on key order below.

**A NOTE ON KEY ORDER (measured 2026-11-24, phase 3).** A payload built
from a `serde_json::json!` literal is a `serde_json::Value`, and its map
is a `BTreeMap` — so the literal's keys reach the wire ALPHABETICALLY.
A payload built from a struct serializes in DECLARATION order. MEASURED
on this host with the project's own `serde_json`:
`json!({ "appended": true, "length": 1, "chain": [] })` answers
`{"appended":true,"chain":[],"length":1}` — `appended`, `chain`,
`length` — while the struct answers `appended`, `length`, `chain`. So
converting a literal into a struct MOVES the key order, and the phase-2
line above ("the same keys, in the same order") was wrong about it. The
correction does not change anything a consumer can observe: a JSON
object is unordered by specification, every reader in this tree reads by
name, and the block hash is computed over the block's data through
`canonicalStringify`, which sorts its own keys. The key SET and the
VALUES are identical — that is the part the contract is about.

**What remains after phase 2 (the ratchet, in the TS runner):** FOUR surfaces still
declare a bridge payload type by hand — `rust-chain-adapter.ts` (the
chain family), `case-chain-adapter.ts`, `rust-bridge-manifest.ts` and
`rust-embed-profile-bridge.ts`. The counter may only go down, and the
gate fails if a surface outside the list starts declaring a payload type
of its own. The envelope families (chain, case, soul, mv2, manifest) are
the next phase; the vault and embed families are closed.

**PHASE 3 CLOSED 2026-11-24 — the chain, soul and case families** (PR #781,
squash `fe1d7c8e92`). The third family, and the one that had NO shape at
all: the `chain_*`,
`soul_*` and `case_*` answers were built from `serde_json::json!`
literals — a payload with no owner, which is exactly how the TypeScript
side ended up hand-writing its shape.

MEASURED on the built module (the case family's SQLite index pointed at
a scratch directory, so the operator's own index was never touched):

| export           | the payload on the wire                                                           |
| ---------------- | --------------------------------------------------------------------------------- |
| `chain_validate` | `valid` — and `errors` ONLY on the failure path (absent, not null)                |
| `chain_append`   | `appended`, `length`, `chain` — and `errors` only on the rejected path            |
| `chain_query`    | `count`, `blocks`                                                                 |
| `soul_loop_step` | `applied`, `state` — and `reason` only when the step did not apply                |
| `soul_replay`    | `accepted`, `rejected`, `errors`, `snapshot`                                      |
| `case_append`    | `appended`, `indexed`, `length`, `chain` — and `errors` only on the rejected path |
| `case_query`     | `count`, `entries`                                                                |
| `case_rebuild`   | `indexed`, `skipped`, `errors`                                                    |

Three findings, all of them wrong guesses on the TypeScript side:

1. **`CaseIndexRow` had TWENTY-FOUR fields; the wire sends SIX.** The
   hand-written row in `src/memory/case-types.ts` declared `entity`,
   `actor`, `target`, `instrument`, `location`, `origin`, `destination`,
   `owner`, `possessed`, `giver`, `recipient`, `object`, `subject`,
   `verb`, `invoker`, `invocation`, `entry_timestamp`, `indexed_at` and
   more — none of which the wire ever sends — and it was MISSING `entry`,
   the one key that carries the case itself. So the adapter's two query
   paths (Rust and TypeScript) answered with two different shapes, and
   `memphis explain --case-type` read `entry.entity` and
   `entry_timestamp`, which on the Rust path never arrive: it printed an
   empty entity and a `?` for every row.
2. **`CaseRebuildReport` knew TWO of the three keys** — it had never
   heard of `skipped`.
3. **The chain and soul families had no owner at all.** Their answers
   were `json!` literals, so nothing could be checked against them. They
   are structs now (`ChainValidateOut`, `ChainAppendOut`,
   `ChainQueryOut`, `SoulLoopStepOut`, `CaseAppendOut`, `CaseQueryOut`),
   with `#[serde(skip_serializing_if)]` keeping the wire exactly as it
   was measured: the keys a variant does not carry are ABSENT, not null.

The chain family's own vocabulary was measured on the operator's disk on
the same day: 12 645 blocks carry EIGHT distinct `data.type` words —
seven variants (`insight`, `case`, `system_event`, `journal`,
`decision`, `tool_call`, `system`) and ONE read-side alias
(`security_event`, 2 blocks). No block was missing its `type`, and no
block carried a word the Rust core cannot parse, so the append path
cannot trip over the corpus. The wire itself carries the FIFTEEN variant
names and never the fourteen aliases: the bridge parses a block into a
`BlockType` and serializes the VARIANT name back.

**The owner grew a rule it did not have: the ENUM shape.** A tagged
enum (`CaseEntry`, `#[serde(tag = "case_type")]`) has no struct and no
field list — the wire carries the tag plus the fields OF THAT VARIANT.
So the owner declares the tag and the UNION of the variants' fields, and
the gate checks three things the struct rule could not: the tag's name
comes from the enum's own `#[serde(tag = ...)]`; the union is the
variants' fields in order of first appearance; and a field only SOME
variants carry is ABSENT on the wire, not null. The gate also learned to
read a vocabulary from an ENUM (its variant names, renamed by the enum's
own `rename_all` — serde's variant rule, which splits `WalletTxRequested`
into `wallet_tx_requested`, unlike its field rule) and to REFUSE a
read-side alias in a vocabulary: an alias is a word the crate accepts on
read, never a word the wire writes.

**Falsifiers, measured on this host (phase 3), six of them:**
a misspelled word in the `BlockType` vocabulary fails the Rust runner
with _"the vocabulary of type is {…toolcall…}, but the source writes
{…tool_call…}"_; a misspelled word in the `CaseEntry` tag vocabulary
fails it the same way; dropping the `#[serde(skip_serializing_if)]` from
`ChainAppendOut.errors` fails it with _"the table says
optional=true nullable=false for errors, but the struct declares
Option<Vec<String>>"_; putting a read-side alias into the `BlockType`
vocabulary fails it with _"the vocabulary of type declares the read-side
alias security_event, which the wire never writes"_; putting the
hand-written `CaseIndexRow` back into `case-types.ts` fails the
TypeScript ratchet with _"src/memory/case-types.ts: interface CaseIndexRow
{"_; a hand edit in the generated mirror fails the projection's check
mode with exit 1 and _"mirror … is stale"_. The binary was probed after
every change, and the answers kept their key set and their values.

**The ratchet: FOUR surfaces → TWO.** `rust-chain-adapter.ts` and
`case-chain-adapter.ts` no longer declare a bridge payload type by
hand — they read the owner's shapes, and so does `src/memory/case-types.ts`
(it keeps only the DOMAIN model: the eight cases as a strict union, so a
genitive cannot carry a `verb`). What remains is
`rust-bridge-manifest.ts` and `rust-embed-profile-bridge.ts` — the
manifest and embed-profile families, which are the next phase.

**What phase 3 does NOT close, said out loud:** the per-variant shapes
of `CaseEntry` (the owner declares the loose union; the eight per-case
shapes are the explicit residue), the query INPUT shapes (`CaseQuery` and
the soul loop's `action`/`limits` — they are what the TypeScript side
SENDS, they match the Rust structs field for field, and the payload
contract owns what the bridge RETURNS), and the two napi naming
conventions in one crate, which is a WIRE change and needs a
compatibility window rather than a quiet edit.

**PHASE 4 CLOSED 2026-11-24 — the manifest family** (PR #782, squash
`6b2b737ad75`). The fourth family,
and the one the runtime reads FIRST: `bridge_manifest` is what the bridge
serves about itself, and it is what the runtime asks before it decides
whether the bridge is good enough to start.

MEASURED 2026-11-24 on the built module: SIX keys, in this order —
`exportBindings`, `exports`, `name`, `optionalExports`,
`requiredExports`, `schemaVersion`. The order is alphabetical because the
answer used to be a `serde_json::json!` literal, and a literal is a
`serde_json::Value` with a sorted map; the struct that replaced it
declares its fields in the same order, so the wire did not move.

Three findings:

1. **The shape was written down TWICE** — once in the runtime's
   `RustBridgeManifest` and once in the export projection's reader — and
   both copies were wrong in the same way: they marked `exportBindings`
   and `optionalExports` OPTIONAL, while the wire always sends both.
   The two copies now come from the owner, and the projection's reader
   reads the owner's shape instead of its own.
2. **`optionalExports` carried the WRONG ANSWER and nobody read it.**
   MEASURED: the wire carried a hand-written list of TWO names —
   `mv2_export`, `mv2_inspect` — a leftover from June 2026, from before
   the export table existed. The table already knew TEN optional exports
   (42 exports, 32 required), so the field under its own name was wrong
   about eight of them, and MEASURED: nothing in the tree read it at all.
   It is derived from the table now, so the answer cannot drift from the
   rule it reports.
3. **The answer had no owner**: it was a `json!` literal, like the chain
   and soul families in phase 3. It is a struct now (`BridgeManifestOut`),
   and the binding it carries is a typed struct too
   (`BridgeExportBinding`, three keys: `canonical`, `jsName`, `required`).

**THE WIRE MOVED, in exactly one value, and here it is.** The key set,
the types, the key ORDER and every other value are identical — MEASURED
before and after. `optionalExports` now carries the table's TEN optional
exports instead of the hand-written two. Nothing in the tree read that
field (measured), so nothing could break; and the new TypeScript gate
asserts that the list equals the table's optional set, so the hand-written
pair cannot come back.

**A compat fact the owner now carries, and it is measured, not guessed:**
`exportBindings` is ABSENT on a binary older than the vocabulary table
(before 2026-11-23) — the export projection already failed loudly on it
with _"the manifest carries no exportBindings — the Rust core predates the
vocabulary table"_. So the contract says the key MAY be absent, the Rust
struct carries it as an `Option` (so the gate's presence rule can check
it), and this binary always fills it.

**Falsifiers, measured on this host (phase 4):** a misspelled field in
the manifest shape fails the Rust runner with _"the table says … but the
wire will carry …"_; dropping the `#[serde(skip_serializing_if)]` from
`BridgeManifestOut.export_bindings` fails it with _"the table says
optional=true nullable=false for exportBindings"_; putting the hand-written
`RustBridgeManifest` interface back fails the TypeScript ratchet with
_"src/infra/storage/rust-bridge-manifest.ts: interface RustBridgeManifest
{"_; putting the hand-written binding type back into the export
projection fails the same ratchet with _"scripts/sync-bridge-export-contract.mts:
jsName: string;"_; and putting the hand-written two-name list back into
the Rust manifest fails the crate's own test with _"the manifest's
optional exports are not the optional exports of the table"_.

**The ratchet: TWO surfaces → ONE.** What remains is the embed-profile
family (`rust-embed-profile-bridge.ts`), which is the last one.

**One thing the owner still does wrong, and this entry does not hide it:**
the same crate spells the same idea two ways. `JsEntriesResult` has no
`js_name` on its fields and reaches JavaScript as `entriesJson`, while its
sibling `JsVaultStateResult` reaches it as `error_code`. Unifying that is a
WIRE change, so it needs a compatibility window (the alias map E-01 already
built), not a quiet edit. It is queued with the next phase of E-09.

**PHASE 5 CLOSED 2026-11-24 — the embed-profile family** (PR #783, squash
`70df8edacde`). The
LAST family of E-09, and the last surface that owned a payload type by
hand. The ratchet's counter is EMPTY.

MEASURED 2026-11-24 on the built module, the family's two answers:

- `bridge_embed_profile_manifest` — SIX keys, in the struct's own order:
  `schemaVersion`, `env`, `defaults`, `dimensionSources`, `verdicts`,
  `modes`; and inside `modes` THREE keys — `local`, `alias`,
  `providers`.
- `bridge_embed_profile_facts` — FOURTEEN keys, in the struct's own
  order, from `schemaVersion` to `dimensionRemedy`. The `Option` fields
  are PRESENT and null when they have no value — MEASURED, not assumed:
  an environment without an index answers `indexDimension: null`, and a
  process without a mismatch answers `dimensionRemedy: null`.

**THE FINDING: THE TYPE DID NOT DESCRIBE THE WIRE.** The hand-written
`EmbedProfileManifest` declared `modes` with TWO keys — `local` and
`providers` — while the wire has carried THREE since the manifest was
written. The third one is `alias`: the word that means "the
OpenAI-compatible provider" (`RUST_EMBED_MODE=provider`). The interface
had no room for it, so the type claimed to describe a payload that has
one key more than it declares. The shape comes from the owner now, and
the TypeScript side reads the owner's shape.

**THE GATE LEARNED A THIRD KIND OF SOURCE.** The embed profile's words
live in CONSTANTS — `SOURCE_ENV`, `SOURCE_INDEX`, `SOURCE_LOCAL`,
`SOURCE_UNKNOWN`, the four `VERDICT_*` and `PROVIDER_MODE_NAMES` — and
not in a function and not in an enum. So the gate reads a constant as the
source of a closed vocabulary: a `&str` constant speaks ONE word, a
`&[&str]` constant speaks a LIST of them. A name that resolves to more
than one thing (a function AND a constant, say) is ambiguous, and the
gate refuses it instead of picking one — a vocabulary that means two
things is a vocabulary nobody can check.

**A LIST OF WORDS IS AS CLOSED AS ONE WORD.** The type model learned
`Array(&Enum)`: the manifest's `dimensionSources`, `verdicts` and
`modes.providers` are lists of closed words, and the mirror renders them
as `('env' | 'index' | 'local-deterministic')[]` — WITH the brackets,
because `'a' | 'b'[]` is a union of a word and an array, which is a
different type and a wrong one.

**Falsifiers, measured on this host (phase 5), six of them:** a
misspelled word in a constant-sourced vocabulary fails the Rust runner
with _"the vocabulary of dimensionSources is {…localdeterministic…}, but
the source writes {…local-deterministic…}"_; a vocabulary pointing at a
constant the crate does not declare fails it with _"the vocabulary points
at the source SOURCE_MISSING, and the crate declares it 0 times — the
source must be exactly one of a function, an enum or a constant"_; the
owner losing `modes.alias` fails the Rust runner twice — _"EmbedProfileModesPayload:
the struct has 3 fields, the table has 2"_ and _"left: [local, providers]
right: [local, alias, providers]"_ — and the TypeScript runner with
_"expected [ 'alias', 'local', 'providers' ] to deeply equal [ 'local',
'providers' ]"_; putting the hand-written `EmbedProfileManifest` back
fails the TypeScript ratchet with _"src/infra/storage/rust-embed-profile-bridge.ts:
interface EmbedProfileManifest {"_; a surface that owns a payload type
again fails the counter with _"expected 1 to be +0"_; and a hand edit in
the generated mirror fails the projection's check mode with exit 1 and
_"mirror … is stale"_.

**The ratchet: ONE surface → ZERO.** No TypeScript surface declares a
bridge payload type by hand any more. Every shape the bridge carries is
the owner's, projected into one mirror, checked by two runners.

**What phase 5 does NOT close, said out loud:** the per-variant shapes of
`CaseEntry` (the owner declares the loose union; the eight per-case
shapes are the explicit residue) and the two napi naming conventions in
one crate (a WIRE change, so it needs a compatibility window — the alias
map E-01 already built — and not a quiet edit).

**WHERE E-09 STANDS after phase 5.** The payload types have ONE owner, and
the counter of surfaces that own a type by hand is EMPTY. What is left is
NOT a missing type: it is the residue that needs a decision of its own —
the eight per-case shapes of `CaseEntry` (the owner declares the loose
union, and the eight variants are the explicit remainder) and the two napi
naming conventions in one crate (a WIRE change, so it needs a
compatibility window, not a quiet edit). Both are queued as the next steps
of E-09, in that order.

**ONE THING THIS PHASE MEASURED AND DID NOT CUT, said out loud:**
`readEmbedProfileManifest()` — the runtime's door to the owner's rule —
has NO caller in the tree (MEASURED: the only readers of the manifest are
the export alias map and the projection script, which asks the owner at
BUILD time). It stays, for two reasons that are facts and not taste: it
is the only reader of the shape this phase just gave an owner, and the
package publishes `dist/`, so cutting an exported function is a BREAKING
change for whoever imports it — a decision of its own, not a side effect
of a shape migration. The words of the manifest (`provider` for the
OpenAI-compatible provider, the nine provider names, the four verdicts)
are consumed at runtime from the OTHER projection,
`src/infra/storage/embed-profile.generated.ts` — which is also generated,
from the same owner. So no value is written down twice by hand; the
redundancy is of PROJECTIONS, not of authorship.

**PHASE 6 CLOSED 2026-11-24 — the per-variant shapes of `CaseEntry`**
(PR #787, squash `a31194f8c965`).

Phase 5 left the per-variant shapes as "the explicit residue", and the
residue turned out to be a hole with a gate that could not see it.

> Measured 2026-11-24 on this host, over the four case types the corpus
> actually holds — the keys the wire carries, per case:
>
> | case           | the keys                                     |
> | -------------- | -------------------------------------------- |
> | `accusative`   | `case_type`, `subject`, `verb`, `object`     |
> | `genitive`     | `case_type`, `owner`, `possessed`            |
> | `instrumental` | `case_type`, `actor`, `instrument`, `target` |
> | `nominative`   | `case_type`, `entity`, `action`, `timestamp` |
>
> Eight cases, eight field sets. `entity` and `timestamp` belong to the
> NOMINATIVE alone.

**The finding.** The flat shape said `entity?` — and a flat shape CANNOT
say "not on this variant", because a flat list is the union by
construction. So the TypeScript side wrote the STRICT union down by hand
(`CaseEntry` in `src/memory/case-types.ts`, eight arms, one per case) —
and **nothing compared it with the owner**. The owner's flat table was
gated; the strict union was not.

**THE FALSIFIER, measured, and it is the quiet one.** The owner grew a
field on `CaseEntry::Dative`. The owner's table grew it, the generated
artefact grew it, the generated mirror grew it (`medium?: string`). And
then: the payload contract gate **12/12 green**, `tsc --noEmit` **clean**,
the TypeScript suite **41/41 green** — and the hand-written union still
had **ZERO** occurrences of the new field. Every gate was green and the
domain model was wrong. That is the shape of this defect: it does not
fail, it drifts.

**The fix, in the house pattern.** The owner's table gains a per-variant
split (`PayloadVariantShape`), the gate checks it against the enum
**variant by variant and field by field** (`every_variant_shape_is_the_variants_of_its_enum`),
the projection renders it as a **discriminated union** — one arm per case,
the tag as a literal, because the fields that follow depend on it — and
`src/memory/case-types.ts` re-exports that union under the name the
domain model uses. The hand-written copy is gone; there is nothing left
to drift.

**And the compiler finally said something.** With the union discriminated,
`tsc` refused the code that had been silently wrong: `explain.ts` read
`entry.entity`, `entry.timestamp`, `entry.actor` and `entry.target` off a
value whose type says those fields belong to OTHER cases. MEASURED
before the fix, on the host: `memphis explain` printed an **empty entity
and a `?`** for every row of every case but the nominative. The command
now prints the case's OWN fields — `owner` for a genitive, `giver` for a
dative, `invoker` for a vocative — and the block index when the case
carries no timestamp.

**A REAL BUG IN THE GATE, found by the new check.** The per-variant
check could not pass at first, and the reason was a defect in the gate's
own PARSER: `split_attributes` ran on the whole variant chunk, so the
field's `#[serde(skip_serializing_if = "Option::is_none")]` was removed
BEFORE `parse_variant_fields` ever saw it. MEASURED: the parser reported
`skip_serializing_if = false` for `CaseEntry::Ablative::destination`,
which declares it. The union rule had masked it — the field is in ONE
variant, so "optional" was right for a reason that had nothing to do with
the attribute. A gate that could not see the attribute could not check
the one field whose presence the attribute decides. Fixed: the fields are
parsed from the original chunk.

**And the path to it was closed too.** `memphis explain --case-type <typ>`
was **unreachable**: `CliArgs` had no `caseType` and no `entity` field, so
the parser dropped both flags and the command fell through to the journal
chain. MEASURED on the host: `memphis explain --case-type genitive`
printed twenty JOURNAL blocks — the operator's question answered with a
different one. The usage line had promised the flags all along
(`explain [--chain <name>] [--case-type <type>] [--entity <name>]`), so
the promise was in the help and the parser did not keep it.

MEASURED on this host AFTER the fix:

```text
$ memphis explain --case-type genitive
  Case entries: 20 results

  [#2180] genitive: soul
    possessed: self.learnings

$ memphis explain --case-type nominative
  Case entries: 1 results

  [2026-09-29T17:54:00Z] nominative: collective/000025
    action: instance-council-response

$ memphis explain --case-type instrumental
  Case entries: 2 results

  [#295] instrumental: crates/memphis-napi/src/lib.rs:704
    instrument: embed_shutdown()
    target: persistent index state on process exit
```

Each case prints ITS OWN fields — `owner` for a genitive, `giver` for a
dative, `invoker` for a vocative — and the block index identifies the
entry when the case carries no timestamp, which only the nominative does.

**What this phase does NOT close, said out loud:** the two napi naming
conventions in one crate — and that residue turned out NOT to be the WIRE
change it was assumed to be (decision #587: it is a corpus migration, and
the measured detail is below).

**WHERE E-09 STANDS after phase 6.** The payload types have one owner,
the counter of surfaces that own a type by hand is empty, and the
per-variant shapes are the owner's too. What is left is the residue that
needs a decision of its own: the two napi naming conventions in one crate.

**AND THAT RESIDUE WAS MEASURED ON 2026-11-24, RE-MEASURED ON 2026-11-25, and
the item was WRONG about what it would change** (decision #587). It is not a
bridge convention: the snake_case names are the shapes that speak the
WRITER's spelling, and one of them — `prev_hash` — is inside the **HASHED**
corpus.

Over the owner's own table — **36 shapes, 176 field names** — counted from the
shape consts in `crates/memphis-napi/src/bridge_payloads.rs` and reproduced by
the generated fixture `tests/fixtures/bridge-payload-contract.json`:

| the name                                                   | count   | what the name carries            |
| ---------------------------------------------------------- | ------- | -------------------------------- |
| single-word (`entity`, `owner`, `timestamp`)               | **126** | identical under both conventions |
| multi-word camelCase (`exportBindings`, `schemaVersion`)   | **26**  | a computed **VIEW**              |
| multi-word snake_case (`prev_hash`, `persistence_enabled`) | **24**  | a stored **RECORD**              |

**THE FIRST FIGURE THIS ENTRY GAVE WAS WRONG, and the correction is the
METHOD, not the number.** It said "136 camelCase and 23 snake_case". That pair
cannot be reproduced: the counting rule behind it was never written down, and
no rule over this table yields it. The rule that IS reproducible is the one
above — split the names by whether they are single-word, because a single-word
name is the same under both conventions and therefore says nothing about
which one the shape uses. Under that rule the case family is **5**, not 4: the
union's tag `case_type` is a name of its own.

**AND THE TWO CONVENTIONS ARE NOT MIXED — they partition the table, and the
partition is the answer.** Every one of the **26** multi-word camelCase names
lives in a **VIEW** family — the bridge manifest (`exportBindings`,
`optionalExports`, `requiredExports`, `schemaVersion`), the export binding
(`jsName`), the embed-profile manifest and facts (`indexPath`,
`dimensionSources`, `localDimension`, `dimensionMismatch`, `dimensionRemedy`,
`providerConfigured`, …), the embed index metadata (`formatVersion`,
`invalidRecords`, `sizeBytes`), the vault entries result (`entriesJson`,
`errorCode`) and the case-index status (`lastIndexedBlock`). Every one of the
**24** multi-word snake_case names lives in a **RECORD** family — the vault
four (`error_code`, `master_key`, `created_at`, `qa_question` — explicit napi
`js_name`), the embed store and search (`persistence_enabled`,
`persistence_load_state`, `text_preview`, `was_initialized`,
`previous_replacement_state`, `replacement_state`), the chain block
(`prev_hash`), the soul loop and replay (`tool_calls`, `wait_ms`,
`halt_reason`, `last_hash`, `state_hash`) and the case entry and index row
(`case_type`, `block_index`, `block_hash`, `full_json`).

**MEASURED: no shape carries both.** The two conventions are not a style
inconsistency inside a family — they are the family's own kind. A view is
COMPUTED, so it is named for the reader; a record is STORED, so it is named
for the writer, and the writer is `serde` with no `rename_all`.

The 24, by family: vault **4**, embed **9**, chain **1** (`prev_hash`), soul
**5**, case **5**.

**WHY MOST OF THEM CANNOT MOVE, and this is the part that matters.** The
serde shapes ARE the on-disk format: `memphis_core::block::Block` is the
struct the chain files are written from, its field is `prev_hash`, and the
files carry `prev_hash` (MEASURED 2026-11-25 on this host: `memphis chain
verify` reports **12 345** blocks over **14** chain directories — **11 598**
live and **747** in the three `.backup-*` copies). And the hash covers the
**KEY NAMES**: `canonicalHash` in
`src/core/chain-hash.ts` is `canonicalStringify({...block, data:
toCanonicalHashData(block.data)})` — the canonical string is the block
object with sorted keys, so the names are inside the digest.
`src/core/canonical-json.ts` says it plainly: _"the hash covers a block's
VALUES, not its bytes"_ — the BYTES may be reordered, but the key names
are fixed by the canonical projection.

So renaming `prev_hash` would change **every** block hash and break the
chain. This is not a WIRE change with a compatibility window; it is a
corpus migration that invalidates every live block hash — **11 598** of them.

**WHY THE VAULT FOUR ARE DIFFERENT, and why changing them buys almost
nothing.** All four are pinned by an explicit `#[napi(js_name = "...")]`, and
they were pinned DELIBERATELY: `master_key`, `created_at` and `qa_question`
in `52ef4e2a56` (_"refactor(bridge): stabilize napi contract naming"_,
2026-03-21) — the commit that also gave the EXPORT FUNCTIONS an explicit
`js_name`, so their names do not depend on napi-rs's camelCase default — and
`error_code` in `10fac3d8190` (_"refactor(vault): share persisted readers
across TypeScript and Rust"_, 2026-10-17). Two of them had a PREVIOUS
spelling of camelCase (`masterKey`, `createdAt`), which is why the table
carries a `legacyName` for those two and for no other field. So "unifying
to camelCase" would REVERT two deliberate stabilizations.

And the benefit is now near ZERO: E-09's phases 1–5 already put every
wire spelling in ONE table — the owner's — so the TypeScript side no
longer hedges: `result.entries_json ?? result.entriesJson` is gone, and
the `legacyName` alias is carried by the **2** fields that ever had an
older spelling (`master_key` → `masterKey`, `created_at` → `createdAt`;
MEASURED: 2 of the table's 176 field names carry one). The two spellings
are DOCUMENTED, not ambiguous.

**WHAT THE REAL RESIDUE IS.** The manifest and embed-profile families
declare `rename_all = "camelCase"` (`BridgeManifestOut` in
`crates/memphis-napi/src/lib.rs`, and the embed crate's `profile.rs` and
`metadata.rs`) because those payloads are COMPUTED views; the stored
families have no `rename_all` and speak snake_case for their multi-word
fields — the vault four excepted, because their `js_name` pins the name
inside a camelCase shape. That is not an inconsistency to fix — it is the
difference between a **view** and a **record**, and the difference is the
storage format.

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

| piece                                               | what it is                                                                          |
| --------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `scripts/check-package-runtime-closure.mts`         | **the owner** — finds every file the shipped code imports from outside its own tree |
| `tests/fixtures/package-runtime-closure.json`       | the artefact of cases (2 edges on this host)                                        |
| `scripts/check-package-runtime-closure.mts --check` | one runner: the gate                                                                |
| `tests/ops/package-runtime-closure.test.ts`         | the other runner: the test, importing the owner                                     |

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

#### E-12 · The published package installs, and the CLI cannot start

> Measured 2026-11-24 on this host, against the **published** v1.14.1 tarball
> (`memphis-chains-memphis-1.14.1.tgz`, 4 599 032 B, checksum verified
> against the workflow's own `SHA256SUMS`), installed into a clean prefix
> with npm 12.0.2:
>
> - the install **succeeds** (exit 0);
> - the CLI dies on every command with
>   `[ERROR] Failed to load Memphis CLI: Could not locate the bindings file.
Tried: → …/better-sqlite3/build/Release/better_sqlite3.node → …`
>   — thirteen candidate paths, no sentence saying what to do;
> - `node_modules/better-sqlite3/build/` does not exist: the native binding
>   was never built.
>
> The package was not broken. npm 12 **blocks dependency install scripts by
> default**, and it reads `allowScripts` from the **project root**: the
> installed `node_modules/@memphis-chains/memphis/package.json` carries
> `{"better-sqlite3": true, "esbuild": true, "onnxruntime-node": true}` and
> the script was blocked anyway. `better-sqlite3` ships no prebuilt binding
> — its install script is the thing that fetches one.
>
> With one line in the consumer's project —
> `{ "allowScripts": { "better-sqlite3": true } }` — the install builds the
> binding and the CLI starts (measured). Approving **more** breaks it:
> `onnxruntime-node`'s install script downloads
> `onnxruntime-linux-x64-gpu-1.21.0.tgz` and gets **404**, which aborts the
> whole install. The CPU runtime Memphis uses ships inside the package, and
> the repository's own `.npmrc` (`onnxruntime-node-install-cuda=skip`) is what
> keeps the repo's install alive — a dependency's `.npmrc` is not read by npm.

**And every gate said everything was fine.** `ops:release-preflight` passed
11/11 on this host, and the release workflow's `test` job passed, on an
artefact that cannot start:

- `scripts/validate-package-artifact.mts` installed with **`--ignore-scripts`** —
  which guarantees that no native binding is built;
- its two probes were `memphis --help` and `memphis completion bash` — neither
  opens the journal database, so neither can tell a working package from a dead
  one.

This is E-10's second half, still open: E-10 fixed the `files` list, not the
fact that nothing proved the tarball **runs**.

**CLOSED 2026-11-24 (v1.14.2).** Three pieces:

| piece                                        | what it is                                                                                                                                                                                                                                     |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `scripts/validate-package-artifact.mts`      | **the owner** — installs under a declared policy (`allowScripts: {better-sqlite3: true}`, `onnxruntime-node-install-cuda=skip`), asserts the native binding exists, and probes `memphis vault list --json` — a command that opens the database |
| `bin/install-remedy.mjs`                     | the sentence the CLI prints when the binding is missing: what npm 12 did, and the one line that fixes it                                                                                                                                       |
| `tests/ops/package-install-contract.test.ts` | the runner (6 assertions)                                                                                                                                                                                                                      |

**Falsifier, measured:** with the approval revoked in the prefix project, the
install produces no binding and the gate **fails** (exit 1) with
`the installed package has no better-sqlite3 native binding`. With it, the
binding is there and `memphis vault list --json` answers
`{"ok": true, "entries": []}`. The old gate passed on the same tarball —
that is the measurement of the hole, not an argument about it.

#### E-13 · The case index is a cache that lost a third of its entries, and the repair was dead code

> Measured 2026-11-24 on this host, through the adapter's own public API:
>
> |                                                         |                                                                                      |
> | ------------------------------------------------------- | ------------------------------------------------------------------------------------ |
> | the `cases` chain                                       | **2 190** case blocks (accusative 2 058, genitive 129, instrumental 2, nominative 1) |
> | `~/.memphis/case-index.sqlite`                          | **1 372** rows (accusative 1 313, genitive 59)                                       |
> | the index's `block_index` range                         | **818 … 2 189** — the chain's LAST block                                             |
> | the Rust path (the LIVE one, `RUST_CHAIN_ENABLED=true`) | **1 372** entries                                                                    |
> | the TypeScript path (the chain files)                   | **2 190** entries                                                                    |
>
> So the index had lost the **first 818** entries — 37% of the corpus — and
> the missing ones included the host's **only nominative entry** and **both**
> instrumental ones. The two paths of the SAME adapter answered different
> questions, and the one that answers at runtime answered with the subset.

**THE FINDING, and it is two findings.** First: nothing noticed. The
index's **highest** block index was the chain's last, so every signal that
looks at the tail said "fine" — a gap at the HEAD is invisible to the
highest index, and the gap was at the head. Second, and this is the one
that matters: **the mechanism that was written to repair exactly this
state had no caller in the tree.** `reconcileIfNeeded()` — whose own doc
says _"Startup reconciliation: rebuild the Rust index from chain block
files. Ensures the index matches the filesystem after a potential partial
write"_ — was never called, and neither was `rebuildIndex()` beside it.
The repair existed. It was idle.

**THE FIX — three pieces, in the house pattern.** The rule is: _the index
is a cache of the chain, and the chain is the truth; so the cache is
checked before it is read._

| piece                                     | what it is                                                                                                                                                                              |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `crates/memphis-case-index/src/lib.rs`    | `CaseIndex::status()` — the owner answers how many entries the index holds, and the highest block among them                                                                            |
| `crates/memphis-napi/src/lib.rs`          | `case_index_status` — the bridge export that serves it (OPTIONAL: a binary from before 2026-11-24 does not have it, and a runtime that cannot ask keeps using the index as it finds it) |
| `src/infra/storage/case-chain-adapter.ts` | the reconciliation: compare the index's COUNT with the chain's count of case blocks, and rebuild when they differ                                                                       |

The bridge exports **43** now, not 42 — the 43rd is `case_index_status`,
and it is OPTIONAL, so a binary from before 2026-11-24 still loads.

**The COUNT, and not the highest index** — that is the whole difference
between a check that sees this defect and one that does not. The count is
the chain's count of **case** blocks, not its count of files: a chain that
held a block of another type would make the cheap comparison wrong, and a
wrong comparison would rebuild on every query for ever. The exact count
costs a scan of the chain — MEASURED: **233 ms** for 2 190 blocks, against
3 ms for the file list alone. And it **cannot loop**: the rebuild makes
the index hold exactly the chain's case blocks, so the next comparison is
equal.

**Falsifiers, measured on this host (three of them):** with the
reconciliation removed from the query path, the TypeScript runner fails
with _"expected 3 to be 4"_; with the check written against the **highest
index** instead of the count, it fails with the same message — the count
is the only signal that sees a gap at the head; and with the bridge unable
to answer (`case_index_status` missing), it fails the same way again. The
Rust arm's own test pins the blindness: index the tail of a chain, and
`last_indexed_block` is the chain's last block while `indexed` is three
short of the truth.

**THE HOST IS REPAIRED, and it was repaired by the code's own path.** One
query through the adapter after the fix: the index holds **2 190** rows,
the two paths agree to the entry, and the types match the chain's exactly
(accusative 2 058, genitive 129, instrumental 2, nominative 1). The
rebuild costs **169 ms**. The second query rebuilds nothing — the counts
are equal, and equal counts are the whole check.

**The cost, stated plainly, because it is not free:** the Rust path now
answers in **323 ms** and the TypeScript fallback in **283 ms** — the
Rust path's speed advantage on this host is **gone**, because the check
costs what the fallback costs (it scans the chain too). The old speed was
bought with a wrong answer. The cheaper check — the chain's FILE count,
3 ms — rests on "every block in the `cases` chain is a case block", which
is true (MEASURED: 2 190 of 2 190) and is the writer's rule (only
`case_append` writes that chain), but it would rebuild on every query on a
chain that ever holds another block type. The exact check was chosen
because it is right without an assumption, and because it lands only on
the MCP tool and the CLI — human and LLM scale, not request scale.

**What this does NOT close, said out loud:** the index's PRIMARY KEY is
`block_index` ALONE, and this host has a second case chain —
`chains/cases.backup-2026-07-07T15-07-23-108Z` — whose **276** blocks
carry the **same** indices 0…275 as the live chain.

**MEASURED AGAIN on 2026-11-24 — and two of the numbers in this entry were
wrong, so they are corrected here rather than left standing.**

The **first** wrong number is the size. The `cases` chain is **1 203 988
bytes — 1.15 MiB**, not 8.8 MB. The 8.7 MB that `du` reports is the
**allocated** size (2 190 files, each occupying a 4 KiB block), and the
rotation reads `stat.size` — the **apparent** size. So the chain is at
**11.5%** of the threshold, and "a rotation is close" was wrong in the
direction that matters: at the measured **14.8 blocks/day** (2 190 blocks
over 147.8 days) it needs **16 884 more blocks**, which is **~1 140 days
— 3.1 years** — before it is touched. The threshold on this host is 10 MiB
(`MEMPHIS_CHAIN_ROTATION_THRESHOLD_BYTES=10485760`, read from the live
systemd unit).

The **second** wrong number is the severity of the collision. The
collision is real in the KEY, but the DATA it would overwrite is the same
data: all **276** overlapping indices carry the **same hash** in the
archive and in the live chain — because a chain is append-only, so a copy
of it shares its prefix for ever. `INSERT OR REPLACE` would rewrite a row
with its own twin.

**AND THE GENERAL CLAUSE IN THAT SENTENCE IS TRUE ONLY FOR A COPY MADE BY
COPY.** MEASURED 2026-11-25: `cases.backup-2026-07-07T15-07-23-108Z` shares
**276/276** hashes with the live chain, `journal.backup-1784913076785` shares
**210/210** — and `system.backup-1782897312539` shares **0/261**, because its
blocks carry the directory name in `chain` and were hashed over it. A copy
whose identity was rewritten from a directory name is not a copy of the same
chain any more. The sentence above stands for the archive it measured; it
does not stand for archives in general, and the difference is itself a
defect (filed on its own).

**And the fix this entry recorded was wrong too — which the measurement is
why.** The obvious repair, a composite key `(chain, block_index)`, would
**not** have separated the two, and the house says so out loud:
`src/memory/chain-catalog.ts` states that _"the archive suffix is a COPY
marker, not part of the chain's identity: the blocks inside it carry
`chain: "journal"`"_. MEASURED: all **276** archived blocks carry
`chain: "cases"` — the same value as the live chain's. The one column
that could have told them apart is the one column that does not. A key
has to carry the **source** the blocks were read from, not the logical
chain name.

Two more measured facts that shape the fix: the rotation never touches an
archive directory (`SAFE_CHAIN_NAME` has no dot in it, so
`cases.backup-…` is not a chain the loop rotates), and **no code path
indexes an archive today** — the adapter hardcodes `CHAIN_NAME = 'cases'`.
So this is a **latent schema defect**, not a live one.

**And the defect a composite key alone would NOT fix:** `rebuild()` opens
with `DELETE FROM case_entries` — a **global** wipe. Rebuilding from one
chain destroys every other chain's entries. A per-chain index needs a
per-chain rebuild, and that is a second change, not a detail.

None of this is urgent, and saying so is the point of measuring it: the
rotation is 3.1 years away, the collision would rewrite a row with its own
twin, and no code path can reach the archive. It still needs a **schema
migration** rather than a quiet edit — and it needs to be measured again
when it is done, because the numbers above are the numbers as of
2026-11-24.

**E-13 CLOSED 2026-11-24** (PR #784, squash `679ccdc7163`). The index is
checked before it is read: the owner answers how many entries it holds
(`CaseIndex::status()`), the bridge serves it (the new **optional** export
`case_index_status` — 43 exports now, not 42), and the adapter compares
that COUNT with the chain's count of case blocks before every query and
rebuilds the index when they differ.

The count, and not the highest index, is the whole difference between a
check that sees this defect and one that does not. **Three falsifiers,
measured on this host**: with the reconciliation removed from the query
path the TypeScript runner fails with _"expected 3 to be 4"_; with the
check written against the **highest index** instead of the count, it fails
with the same message; and with the bridge unable to answer, it fails the
same way again. The Rust arm pins the blindness itself — index the tail
of a chain and `last_indexed_block` is the chain's last block while
`indexed` is three short of the truth.

**This host is repaired, by the code's own path**: one query through the
adapter took the index from 1 372 rows to **2 190**, the two paths agree
to the entry, and the second query rebuilds nothing.

**The gates:** `cargo test -p memphis-case-index` 15/15,
`cargo test -p memphis-napi --lib` 25/25, the payload contract 12/12, the
export contract 5/5, `case-index-reconciliation` 4/4 (new file), the full
TypeScript suite 5 324 passed / 4 skipped, `tsc --noEmit` exit 0,
`npm run lint` 0 errors (5 pre-existing warnings), both contract syncs
green (27 payloads / 36 shapes, 43 exports), `npm run build` exit 0, and
the release preflight **11/11**. CI: four of four required checks green,
plus the cargo-audit.

**Zero changes on the wire** for the exports that already existed —
measured before and after — so no version bump, the same road as the
E-09 phases.

**And the correction that went in with it** (decision #583): two numbers
in this entry were wrong and the plan they justified was wrong too. The
chain is 1.15 MiB, not 8.8 MB — `du` reports the allocated size and the
rotation reads `stat.size` — so the rotation is 3.1 years away, not
close. And the composite key `(chain, block_index)` would **not** have
separated the live chain from its archive, because an archive's blocks
carry the same `chain` value as the chain they copy. The key has to carry
the SOURCE, and `rebuild()` has to stop wiping the whole table. That is
the next step, and it is queued with the correction above, not with the
plan this entry first recorded.

#### E-14 · The case index's key cannot tell two chains apart, and the fix is a WIRE change

**IMPLEMENTED 2026-11-25** (decision #590) — the key carries the SOURCE, the
source travels from the CALLER to the OWNER, and the compatibility window is
a HANDSHAKE rather than a parameter. What this entry designed is what the
code does now; what follows is the measurement of it.

**THE WINDOW, and why it is a handshake and not a parameter.** The obvious
repair is to add the source as a parameter to the three case exports — and
MEASURED on the bridge: napi-rs IGNORES an extra argument, so a newer caller
against an older binary would lose the source SILENTLY and go on believing
it had threaded it. So the source is OPTIONAL on every export (a caller that
names none keeps the legacy behaviour exactly), and the status payload says
out loud whether the binary understands the source at all (`sourceAware`). A
caller that does not find the flag knows, and keeps using the legacy calls.
The legacy bucket is real and it works: a caller that names no source writes
and reads THERE, exactly as it did before.

|                    | before                                           | after                                              |
| ------------------ | ------------------------------------------------ | -------------------------------------------------- |
| the key            | `block_index INTEGER PRIMARY KEY`                | `PRIMARY KEY (source, block_index)`                |
| the schema version | `PRAGMA user_version = 0` — no versioning at all | `PRAGMA user_version = 1`                          |
| `rebuild()`        | `DELETE FROM case_entries` — a **global** wipe   | `DELETE … WHERE source = ?` — per source           |
| the source         | nowhere                                          | the chain **DIRECTORY**, threaded from the adapter |
| the status         | the total count                                  | the count for ONE source, plus `sourceAware`       |

**THE MIGRATION DROPS THE ROWS IT CANNOT ATTRIBUTE.** The legacy schema
recorded no source, and the blocks cannot be asked for one (they disagree
among themselves — the archive table below), so the legacy rows cannot be
attributed to a source. The index is a rebuildable cache and the chain files
are the truth: the migration drops them, and the caller's count check
rebuilds them — attributed, this time. MEASURED on this host: the legacy
index was `user_version = 0` with **2 190** rows and **no** `source` column;
after the upgrade it holds **2 190** rows under `source = 'cases'` and the
legacy bucket holds **0**.

**THE GATES, and what they pin.** The owner's arm (`cargo test -p
memphis-case-index`, **22/22**): two sources can hold the SAME block index;
a query never answers with another source's rows; a rebuild leaves another
source's rows alone; the legacy bucket behaves as it did; the status says
which source it is about and that it is source-aware; the legacy schema is
migrated and its unattributable rows are dropped; an index already in the
new shape is NOT dropped again (a crash between the DDL and the version bump
must not drop an index twice). The bridge's arm (`cargo test -p memphis-napi
--lib`, **29/29**): the status says it is source-aware; two sources stay
apart; no source keeps the legacy behaviour; the rebuild is scoped to its
source. The TypeScript arm (`case-index-reconciliation`, **6/6**): the
adapter indexes under the chain DIRECTORY it reads — the proof is that the
LEGACY bucket stays empty, where a caller that had not threaded the source
would have written the same rows there.

**OPEN, designed 2026-11-24 (decision #586).** The harm
today is ZERO, and the plan this entry first recorded was WRONG. Both
facts are measured.

> Measured 2026-11-24 on this host:
>
> |                                                            |                                                                                           |
> | ---------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
> | the index's key                                            | `block_index INTEGER PRIMARY KEY` — the chain is NOT in it                                |
> | the `chain` column                                         | every row says `cases` — it carries no information                                        |
> | the index's rows                                           | **2 190**, `block_index` 0…2 189 — exactly the live chain                                 |
> | the archive `chains/cases.backup-2026-07-07T15-07-23-108Z` | **276** blocks at indices 0…275, and **all 276 hashes are IDENTICAL** to the live chain's |
> | code paths that index an archive                           | **none** — the adapter hardcodes `CHAIN_NAME = 'cases'`                                   |
> | `PRAGMA user_version`                                      | **0** — there is no schema versioning at all                                              |

**THE PLAN E-13 RECORDED WAS WRONG, and the measurement is why.** The
obvious repair — a composite key `(chain, block_index)` —
would **not** have separated the live chain from its archive. The house
says so out loud: `src/memory/chain-catalog.ts` states that _"the
archive suffix is a COPY marker, not part of the chain's identity: the
blocks inside it carry `chain: "journal"`"_. MEASURED: all 276 archived
blocks carry `chain: "cases"` — the same value as the live chain's. The
one column that could have told them apart is the one column that does
not.

**THE KEY MUST CARRY THE SOURCE** — the chain DIRECTORY the blocks were
read from, not the logical chain name. And the source **cannot come from
the blocks**: the house forbids reading the directory name as the chain
name, because that is how a repair would rewrite every archived block's
`chain` field and invalidate the archive's hashes. So the source has to
be threaded from the CALLER — the adapter, which knows the directory it
read — down to the owner.

**AND ON 2026-11-25 THAT WAS MEASURED, AND THE BLOCKS DO NOT AGREE WITH EACH
OTHER** — which is the strongest form the argument can take, because it stops
being a rule and becomes an observation. All three archives on this host, the
`chain` field they carry, and whether their hashes still match the live
chain's prefix:

| the archive directory                   | blocks  | the `chain` field it carries  | hashes identical to the live chain's prefix |
| --------------------------------------- | ------- | ----------------------------- | ------------------------------------------- |
| `cases.backup-2026-07-07T15-07-23-108Z` | **276** | `cases`                       | **276/276**                                 |
| `journal.backup-1784913076785`          | **210** | `journal`                     | **210/210**                                 |
| `system.backup-1782897312539`           | **261** | `system.backup-1782897312539` | **0/261**                                   |

**TWO OF THE THREE ARCHIVES SAY ONE THING AND THE THIRD SAYS ANOTHER.** A key
built from the blocks' own `chain` field would file the `cases` and `journal`
archives under their live chain's name and the `system` archive under a name
of its own — one logical chain, three keys, and the index could not tell the
fork from the copies. The source has to be the DIRECTORY, and the directory
is known only to the CALLER. That is not a preference; it is the only
reading that survives the corpus.

**AND THE THIRD ROW IS ALSO A DEFECT OF ITS OWN, so it is not filed as
E‑14's problem.** `system.backup-1782897312539` is a **forked** copy: its
261 blocks carry the DIRECTORY name in `chain`, and their hashes are
consistent with THAT value — recomputed on this host with the repo's own rule
(`canonicalStringify({...block, data: toCanonicalHashData(block.data)})`),
every one of the 261 matches. So it is not a corrupt archive: it is a
self-consistent copy of a **different chain identity**, sitting where a
rollback copy of `system` should be. The rule it broke is the owner's own
(`crates/memphis-paths/src/chain_names.rs`): _"the archive suffix is a COPY
marker, not part of the chain's identity"_. Filed on its own, with its own
measurement and its own falsifier.

**That is a WIRE change**, and the house says a WIRE change needs the
compatibility window E-01 built, not a quiet edit. So E-14 is queued as:
the compatibility window FIRST (the risky part, and it is independent),
then the schema, then the rebuild's scope.

**TWO MORE THINGS THE MIGRATION MUST FIX, measured:**

- `rebuild()` opens with `DELETE FROM case_entries` — a **global** wipe.
  Rebuilding from one chain destroys every other chain's entries, so a
  per-source index needs a per-source rebuild. A composite key alone
  would not fix that.
- There is **no schema versioning**: `PRAGMA user_version = 0` and
  `CREATE TABLE IF NOT EXISTS` means an existing index never receives a
  new schema. A migration has nowhere to live until that changes.

**WHY IT IS NOT URGENT, and saying so is the point of measuring it:** the
index is correct today, nothing can reach the archive, and the rotation —
the only thing that would ever put a second chain's blocks next to the live
chain's — is **3.1 years** away (the chain is at 11.5% of the threshold).

**AND THE CLAIM THAT AN ARCHIVE ALWAYS SHARES THE LIVE CHAIN'S PREFIX WAS
MEASURED FALSE ON 2026-11-25** — it holds for two of the three archives and
not for the third (see the table above). An archive is a COPY, but a copy
whose `chain` field was written from a directory name is a copy of a
DIFFERENT chain identity, and it carries its own hashes. The reason the
index is still correct today is not that the archives are safe by
construction — it is that **nothing can reach them**: the adapter
hardcodes `CHAIN_NAME = 'cases'` and only ever reads the live chain's
directory.

**AND THE SHORTCUTS WERE CONSIDERED AND REJECTED, so the next cycle does
not take them:** a per-source index FILE (no WIRE change, but the rule
moves OUT of the owner and into a filename convention, and it orphans the
operator's existing index); and conflict detection (refuse to replace a
row whose hash differs — the chain is the truth and the index must
FOLLOW it, so refusing would turn a legitimate re-index into a false
alarm).

#### E-15 · A rollback copy can carry a different chain and verify clean

**FOUND AND FIXED 2026-11-25** — the defect is closed on this host and the
gate that would have caught it is in the tree. The entry is worth keeping
because of what it shows: the RULE existed, its OWNER existed, and nothing
enforced either.

**THE HARM, MEASURED.** The archive `chains/system.backup-1782897312539` is
a ROLLBACK COPY of the `system` chain's prefix — blocks 1…261. Every one of
its 261 blocks carried `chain: "system.backup-1782897312539"`: the archive's
own DIRECTORY name, not the chain's name.

**AND NOTHING SAID SO.** The identity is inside the hash, so a block that
carries the wrong one hashes consistently OVER the wrong value: every hash
check passed, and `memphis chain verify` answered `ok: true` — for a copy
that could not be rolled back. MEASURED: the copy's last block did not seam
with the rotation archive that holds the blocks after it
(`.archives/system_000001-015271_*.jsonl.gz` holds blocks 1…15 271, and its
block 262 carries `prev_hash` = the rotation's block 261 hash — which the
copy's block 261 did NOT have). **0 of 261** of the copy's hashes were the
rotation's.

**THE RULE WAS ALREADY THERE, AND SO WAS ITS OWNER.**
`src/memory/chain-catalog.ts` says it out loud: _"the archive suffix is a
COPY marker, not part of the chain's identity: the blocks inside it carry
`chain: "journal"`, and that is what the hash chain was built over. Reading
the directory name as the chain name is how a repair would rewrite every
archived block's `chain` field and invalidate the archive's hashes."_ — and
the Rust core behind it owns the rule
(`crates/memphis-paths/src/chain_names.rs`, `logical_chain_name`). What was
missing was the GATE: `verifyChainIntegrity` checked hashes, indices and the
prev_hash chain, and never asked WHICH CHAIN the blocks said they were.

**THE FIX HAS TWO HALVES.**

1. **The gate, and it can fail.** `expectedChainIdentity()` — the
   directory's LOGICAL name, put through the alias table — is now compared
   with every block's `chain` field. The failure is structured (_chain field
   'X' ≠ expected 'Y'_) and the known-forks parser knows it as
   `identity_mismatch`, so it is a classified failure and not an unknown
   one.
   - **FALSIFIER, measured on this host before the repair:** `chain verify
--chain system.backup-1782897312539` exited **4** with _"chain field
     'system.backup-1782897312539' ≠ expected 'system'"_, and the
     whole-corpus verify exited **4** as well.
2. **The repair.** `memphis chain repair-archive-identity --chain <archive>`
   puts the identity back and recomputes the hash chain over it. It refuses
   anything that is not an archive directory — a live chain's identity is its
   own name — and it copies the archive aside under the data dir's
   `backups/` before the first byte is written.
   - **MEASURED after the repair:** **261/261** of the copy's hashes are the
     rotation archive's, the seam 261→262 holds again, and the copy is
     identical to the rotation's blocks 1…261 in **every** field — including
     `data`, once the key order is normalised (the canonical hash sorts keys,
     so the BYTES may differ and the content may not). `chain verify` on the
     whole corpus: `ok: true`, 14 chains.

**AND IT IS NOT REPRODUCIBLE ANY MORE, which is why this entry is filed as
history and not as a live hole.** MEASURED: `resolveChainDir` refuses a
dotted name (`SAFE_CHAIN_NAME` is `^[A-Za-z0-9_-]{1,64}$`), so no command can
open an archive directory by name; `rebuildChainHashes` has written the
NORMALIZED name since `40df35a373d` (2026-03-30); and the rotation's restore
path reads the rotation's `.archives/*.jsonl.gz`, never these directories.
The fork is a scar from an older code path, and the archive it left behind
is the one thing it left behind — unrepairable by the code that made it,
which is why it needed a tool.

### Family B — the system degrades quietly instead of failing

Every defect here answers with something plausible. The operator cannot tell
"worked" from "worked badly", and that is what turns a bug into a wedge (§2).

#### E-02 · The embed profile is two knobs that contradict each other

The dimension and the index path are configured separately, and their DEFAULTS
belong to two different eras.

> Measured 2026-11-23 on this host, at the recall surface
> (`runMemphisRecall` — the path the operator and the agent actually use):
>
> | process                                               | index it reads                        | dim                              | result                                                                                       |
> | ----------------------------------------------------- | ------------------------------------- | -------------------------------- | -------------------------------------------------------------------------------------------- |
> | the service (full `.env`, systemd `EnvironmentFile`)  | `embed/bge-m3-20261106/index-v1.json` | 1024                             | `mode: semantic`, `degraded: false`, 3 hits                                                  |
> | dim and path only, no provider model                  | the same index                        | 1024                             | `provider returned invalid response: ollama returned embedding dimension 768, expected 1024` |
> | without it (any script, any spawned process, the CLI) | `embed/index-v1.json` (stale, 82 KB)  | 768 on disk vs **32** configured | `embed_search: index_dimension_mismatch: disk_dim=768 config_dim=32`                         |
>
> **CORRECTION (2026-11-23, later the same day).** This entry used to end
> with "the recall swallows that error and falls back to exact search. The
> operator gets plausible answers and never learns the semantic half is
> off." The first half was measured and true; the second half was not. The
> recall result carries `degraded: true` and the error message itself
> (`warning: "embed_search: embed_search_failed: … index_dimension_mismatch:
disk_dim=768 config_dim=32"`), and the mode tells the caller which half
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

| piece                                                     | what it is                                                                                    |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `crates/memphis-embed/src/profile.rs`                     | **the owner** — the index path, the dimension, the model, the source of each, and the verdict |
| `tests/fixtures/embed-profile-contract.json`              | the artefact of cases (14 cases, every one naming a committed fixture index)                  |
| `scripts/sync-embed-profile-contract.mts`                 | the projection: the rule and every verdict, asked of the owner THROUGH THE BUILT BRIDGE       |
| `src/infra/storage/embed-profile.generated.ts`            | the TypeScript mirror — the names, the sources, the verdicts, the local width                 |
| `crates/memphis-operator/tests/embed_profile_contract.rs` | the native runner (7 tests)                                                                   |
| `tests/unit/embed-profile-contract.test.ts`               | the TypeScript runner (10 tests)                                                              |

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
> | process                                                        | index                                 | dimension              | verdict       |
> | -------------------------------------------------------------- | ------------------------------------- | ---------------------- | ------------- |
> | the service (systemd `EnvironmentFile`)                        | `embed/bge-m3-20261106/index-v1.json` | **1024** (from `env`)  | `ok`          |
> | a bare shell (the CLI, a hand-started TUI, any spawned script) | `embed/index-v1.json`                 | **768** (from `index`) | `no-provider` |
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
tests/fixtures/embed-profile-contract.json is stale` — on the runner,
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

#### E-16 · The cockpit tells the operator to run a command it does not have

**FOUND AND FIXED 2026-11-25** (decision #593) — the code half of E-05. The
fifteen turns still need the operator; what was missing was the ESCAPE, in
the place the wedge happens.

**THE LIE, MEASURED.** The cockpit's own error notice says:

> **Action:** run `/recovery` to see the pending work, acknowledge it, and
> continue.

MEASURED on this host: the TUI has **54** slash commands
(`HELP_ENTRIES` in `crates/memphis-tui/src/app.rs`) and **`/recovery` is not
one of them.** The operator who follows the instruction types `/recovery`
and gets "unsupported command" — from the very cockpit that sent him
there.

**AND THE OTHER HALF OF THE MISTAKE WAS MEASURED TOO.** Two more notices in
the same cockpit pointed at `memphis recovery list` — a CLI command that
demands a **local interactive TTY** and the operator's passphrase
(`promptOperatorPassphrase` throws without a TTY). So the cockpit offered
three ways out and none of them worked from the cockpit: one command that
did not exist, and two commands that needed a different machine.

**THE OWNER OF THE ACKNOWLEDGEMENT.** It is
`acknowledgeRecoveryTurn` in `src/infra/runtime/turn-recovery.ts` — and the
Rust arm has NO acknowledgement at all (MEASURED: `acknowledged` appears
nowhere in `crates/memphis-operator/`; the Rust arm owns the table, the
guard and the listing, and the TS arm owns the write). So the cockpit had
no owner to call.

**THE REPAIR, in four parts.**

1. **The cockpit asks the host.** `/recovery` and
   `/recovery acknowledge <turn-id>` are TUI slash commands that resolve to
   the host capabilities `recovery.list` and `recovery.acknowledge`
   (`src/infra/tui-host/protocol.ts` — the one owner of the capability
   vocabulary). The host reaches the SAME owner the CLI reaches; no second
   owner is created.
2. **The authority is the cockpit's own.** The owner now takes an
   AUTHORITY, and validates both kinds itself: the CLI's passphrase, and
   the cockpit's **tier-3 session** — which `/tier 3 <passphrase>` already
   mints, and which expires on its own. One function, one gate, two
   callers.
   - **FALSIFIER:** a tier-3 session that is not alive is refused exactly
     like a wrong passphrase — the owner's own check, not the caller's.
3. **The notices point at the cockpit.** All five recovery notices now say
   `/recovery` (with the CLI named as the alternative for a terminal), so
   the message the cockpit prints is a command the cockpit HAS.
4. **The help lists them.** `/recovery` and
   `/recovery acknowledge <turn-id>` are in the cockpit's help, with the
   route they take.

**THE GATES.** The Rust arm: `/recovery`, `/recovery list` and
`/recovery acknowledge <id>` resolve to the host capabilities — and the
help lists them. The TypeScript arm: the host answers `recovery.list` over
the stdio JSON protocol, and refuses an unauthorised acknowledgement with
the authority that is missing. The owner: the tier-3 session is accepted
when it is alive and refused when it is not.

**MEASURED ON THIS HOST, through the cockpit's own path.** The host
advertises `recovery.list` and `recovery.acknowledge`, and
`recovery.list` answers **49 turns, 15 needing acknowledgement** — the
SAME numbers the CLI reports for the same corpus, because it is the same
owner. The listing names the pending turns with their sessions and their
unsettled counts, and it ends with the command the operator should type.

**THE RESIDUAL, stated rather than hidden.** The acknowledgement is still
implemented in the TypeScript arm while the Rust arm owns the schema and
the guard — two arms, one write. Moving the write into the Rust core means
adding `memphis-operator` to the bridge's dependency set, which is a
DECISION (the bridge would carry the operator's database code) and not a
repair; it is filed here rather than done quietly. And the fifteen turns
still need the operator — this entry gives him a place to do it from.

#### E-07 · A clean drain exits 0, so systemd does not restart the runtime

**FOUND AND FIXED 2026-11-25** (decision #592) — the entry was filed from a
reading of the code, and the reading was RIGHT about the mechanism and WRONG
about the consequence. The runtime does not stay down because the drain
failed; it stays down because the drain SUCCEEDED.

**THE MECHANISM, as filed.** `src/infra/runtime/graceful-shutdown.ts` ends
with `const exitCode = drained ? 0 : 75;` — a clean drain exits **0** — and
the unit sets `Restart=on-failure`. A clean exit is not a failure, so the
supervisor does nothing.

**AND THE CONSEQUENCE WAS WRONG IN ONE DIRECTION AND RIGHT IN THE OTHER.**
The entry said "an exit 0 leaves the runtime down, with no restart". That is
true for an exit 0 nobody asked for, and FALSE for the exit 0 the operator
asked for — and the difference is the whole repair.

MEASURED on this host, with a scratch unit (so the live service was never
the experiment):

| what was done to the unit             | `Restart=on-failure`  | `Restart=always`    |
| ------------------------------------- | --------------------- | ------------------- |
| `systemctl stop` (the operator asked) | stays `inactive`      | stays `inactive`    |
| an unsolicited `kill -TERM`, exit 0   | **`inactive`, pid 0** | comes back, new pid |

**SO THE HARM IS NARROWER AND WORSE THAN FILED.** An operator-initiated
stop is honoured either way — systemd does not restart a unit the operator
stopped. What `on-failure` loses is every UNSOLICITED exit: a SIGTERM from
anywhere else, a supervisor that decided to stop the process, a `kill` in a
script. The unit then goes `inactive` with **pid 0** and nothing in the log
says why. The operator cannot tell "the runtime stopped on purpose" from
"the runtime is gone" — and the runtime's own last words (`shutdown.exit`,
`exitCode: 0`, `drained: true`) read like a SUCCESS.

**MEASURED ON THE LIVE SERVICE, after the repair:**

```
kill -TERM <MainPID>
→ shutdown.start (reason SIGTERM) → shutdown.exit exitCode=0 drained=true
→ 12 s later: active=active, MainPID 2339519 (was 2312087), NRestarts=1
```

and the operator's own stop still works:

```
systemctl --user stop → 8 s later: active=inactive, pid=0
systemctl --user start → active=active, health ok
```

**THE REPAIR IS THE POLICY, and the gate pins it.** Both shipped units
(`scripts/systemd/memphis.service` and `ops/memphis.service` — two units
for the same runtime, and the E-03 gate already knew there were two) now
say `Restart=always`. `RestartPreventExitStatus=101 102 103` still stops
the supervisor from looping on the same crash, and `StartLimitBurst=5` still
caps a boot loop, so `always` costs nothing there.

`scripts/check-systemd-units.mts` now flags a long-running service whose
`Restart=` is not `always` — the gate can fail: flipping the unit back to
`on-failure` makes it exit **1** with a structured message, and the unit is
the only place the policy is written.

**AND THIS IS THE OTHER END OF E-08's CHAIN — and that end is now closed
(2026-11-25, decision #594).** The SIGTERM that arrived during the drill was
never handled — not one `shutdown.*` line was written in the 45 seconds that
followed, and systemd's SIGKILL is what finally ended it. The cause was not
systemd and not the drill's logic: the drill's `tar` was a **synchronous** child
process, and a synchronous child process holds the runtime's event loop, and
the event loop is what dispatches the signal handler. E-08's repair took the
drill's block from **19 300 ms** to **9 583 ms**, but the tar passes were
still synchronous, so a stop that landed inside a drill still waited for the
drill to finish. The tar passes are now **asynchronous** (`scripts/backup-tar.mjs`
owns the rule, and the runtime calls it from inside its own loop), so the
worst silence inside a drill is **1 842 ms** — the chain verifier's block
reads, not tar — and a stop that lands inside a drill is answered in **1 ms**.
The drain budget is 15 s, the stopper budget is 5 s, and the unit's
`TimeoutStopSec` is 45 s: the drill now fits in all three.

#### E-08 · The backup retention stops when the restore drill fails

**FOUND AND FIXED 2026-11-25** (decision #591) — the entry was filed from a
reading of the code, and the reading was RIGHT about the latch and WRONG
about everything else. The drill had not failed once; it had failed three
times in a row, on archives that were complete, and the failure was the
drill's own verdict being wrong.

**THE HARM, MEASURED.** The scheduled backup ran a restore-drill on three
consecutive nights and reported it FAILED every time:

| the backup                          | the drill said               | what was actually true                                       |
| ----------------------------------- | ---------------------------- | ------------------------------------------------------------ |
| `scheduled-2026-11-23-02-00.tar.gz` | `invalid chain name`         | the archive was complete                                     |
| `scheduled-2026-11-24-02-00.tar.gz` | `invalid chain name`         | the archive was complete                                     |
| `scheduled-2026-11-25-02-00.tar.gz` | `Command failed: tar -xzf …` | the archive was complete — tar was killed by the unit's stop |

**THE DRILL WAS VERIFYING A THING THAT IS NOT A CHAIN.** The archive holds
`chains/.archives` — the rotation's container, which holds `.jsonl.gz` files
and no blocks. The drill walked every directory under `chains/` and called
`verifyChainIntegrity` on it, and the verifier throws `invalid chain name`
for a name that is neither a plain chain nor a recognised `.backup-*` copy.

**AND THE OWNER ALREADY SAID SO.** `classify_chain_directory`
(`crates/memphis-paths/src/chain_names.rs`) answers `foreign` for
`.archives`, and the artefact of cases carries that answer
(`tests/fixtures/chain-name-contract.json`, the `.archives` case). The drill
never asked. REPRODUCED on this host, against the newest archive:
`drillBackup('scheduled-2026-11-25-02-00.tar.gz')` → **`invalid chain
name`**, while `tar -xzf` of the same archive exits 0 and yields 486 MB.

**THE DRILL'S ANSWER WAS A PROPERTY OF THE MACHINE, NOT OF THE BACKUP.**
Three things made the drill's verdict depend on the host's free memory:

1. the drill extracted into `os.tmpdir()`, and `/tmp` here is a **tmpfs** —
   RAM: 1 974 234 blocks of 4 KiB, 8.09 GB of memory, of which 4.9 GB was
   already used by leftovers;
2. the drill probed "is this the JSON fallback format?" by gunzipping the
   WHOLE archive — 182 MB in, a 486 MB buffer and a 486 MB string out — to
   learn that the answer was "no";
3. the drill ran inside the runtime, whose cgroup is capped at `MemoryMax=4G`
   while the host's swap was **fully consumed** (4095 of 4095 MB).

MEASURED: the drill blocks the Node event loop for **19 300 ms** — a 50 ms
timer fired **2** times in a 19.6 s drill where it should have fired 392.
And in the runtime it took **22 m 16 s** (`backup.scheduled.success` at
01:06:39 UTC → `backup.scheduled.drill.failed` at 01:28:55 UTC), against
19.6 s standalone.

**AND THAT IS WHAT TURNED A STOP INTO A KILL.** MEASURED in the journal:
systemd sent SIGTERM at 02:28:53 CET — while the drill held the event loop —
and the handler never ran: **not one `shutdown.*` line** was written in the
45 seconds that followed. `TimeoutStopSec=45` expired, systemd sent SIGKILL,
and the unit logged `Failed with result 'timeout'`. The drill's own `tar`
was a child of the unit, so the cgroup's SIGTERM killed it, and the drill
reported the tar's death as a failed backup.

**THE REPAIR, in four parts, each with its own falsifier.**

1. **The drill asks the owner.** `classifyChainDirectory` decides what each
   directory is; `foreign` directories are skipped and NAMED in the result
   (`foreignDirectories`), so a drill that skipped something says so. The
   owner is not re-implemented here — the mirror that E-03 put in place is
   the one that answers.
   - **FALSIFIER, measured on this host:** before, the drill of the newest
     archive ended in `invalid chain name`; after, the same archive is
     verified to its end and the drill reports the **true** defect it holds
     — the `system.backup-1782897312539` copy inside it carries the wrong
     identity, because that archive was written BEFORE E-15's repair. A
     fresh archive of the repaired corpus drills clean: **15 chains, 12 380
     blocks, `foreignDirectories: [".archives"]`**, 14.1 s.
2. **The reason is in the message.** `execFileSync` puts tar's stderr in the
   error object and not in the message, so the drill said `Command failed:
tar -xzf …` and threw the reason away. A broken archive and a broken
   machine looked identical — and, measured, three days of failures said
   nothing about which one it was.
3. **The scratch directory is created next to the archive**, not in
   `os.tmpdir()`. The filesystem that holds the archive is the one that has
   room for its contents, and the backups root is EXCLUDED from the archive
   (`--exclude=./backups`), so a drill in flight cannot land inside the next
   backup.
4. **The retention is a BOUND, not a latch.** The old rule skipped the
   cleaner entirely once a drill had failed; the drill had been failing for
   three days, so the scheduled archives would have grown by one 182 MB
   archive a day, for ever, with nothing in the log saying so. The intent is
   kept as a NUMBER: a failed drill buys exactly **ONE** extra recovery
   candidate — the archive just beyond the window — and the cleaner runs
   either way. The total is bounded by `keep + 1` whatever the drill does.
   - **FALSIFIER:** three consecutive failed drills must all clean with
     `keep + 1`, and the number must not creep.

**THE GATES.** `tests/integration/backup-content-drill.test.ts`: the drill
skips a directory that is not a chain and names it; the drill does not
materialise the whole archive to decide that it is not a fallback archive.
`tests/unit/scheduled-backup.test.ts`: the retention is the plain window
after a good drill, the window plus ONE after a failed drill, and it does
not creep across failures. Reverting the repair fails **5** of the **17**
tests in those two files.

**THE RESIDUAL, stated rather than hidden.** The rotation's `.jsonl.gz`
archives inside a backup are still not verified by the drill — they are not
blocks, and the drill has no reader for them. What the drill now says is
"the chains and the rollback copies are intact", which is what it can say.

**THE RESIDUAL THAT WAS LEFT AFTER THE REPAIR — CLOSED 2026-11-25** (decision
#594). The four repairs above fixed the drill's VERDICT. They did not fix the
drill's TIMING: the tar passes were still `execFileSync`, so the drill still
held the runtime's event loop for the length of the extraction — and that is
what turned E-07's stop into a kill.

MEASURED, from the runtime's own journal on 2026-11-25 (local time):

```
02:00:05  backup.scheduled.start
02:06:39  backup.scheduled.success  (182 229 559 bytes)
           ... the drill calls execFileSync('tar', ['-xzf', …]) — the loop is BLOCKED …
02:28:53  systemd: Stopping memphis.service  (SIGTERM)
           ... ZERO shutdown.* lines: a signal handler cannot run while the loop is asleep …
02:29:38  systemd: State 'stop-sigterm' timed out. Killing.
02:29:38  SIGKILL — "Failed with result 'timeout'"
```

and the scheduler task closed with `lastError: "Command failed: tar -xzf
…/scheduled-2026-11-25-02-00.tar.gz -C /tmp/memphis-verified-drill-RRgpLl"` —
the drill died of the stop, and the stop died of the freeze. (An ordinary stop
at 01:14:57 the same night logged `shutdown.start` and `shutdown.exit` within
two seconds: the handler was fine. The drill was the difference.)

**THE REPAIR, fifth part.** `scripts/backup-tar.mjs` is the ONE owner of the
tar rule — how tar is invoked, how its failures are read, how its stderr
reaches the operator — and **every** call through it is asynchronous. The two
runners (the compiled CLI, which the runtime calls from inside its own loop,
and the plain-Node systemd runner) had already drifted: the CLI classified
tar's failures one way and the runner re-implemented the "file changed as we
read it" rule inline and dropped the reason from the message. The capability
probes moved with it (tar's `--version` probe was 6 ms and the substitution
probe 14 ms, once per process — small, but still a synchronous child process
in the loop), and the archive digest now STREAMS instead of reading 182 MB
into the heap.

MEASURED after, on this host, against the same 181 MB archive:

|                                  | before             | after                                      |
| -------------------------------- | ------------------ | ------------------------------------------ |
| the drill's longest silence      | **11 302 ms**      | **1 842 ms** (the chain verifier, not tar) |
| heartbeat ticks during the drill | 35 of 336 (10.4 %) | **520 of 693 (75 %)**                      |
| a SIGTERM aimed at the drill     | **never answered** | answered in **1 ms**, clean exit 0         |

- **FALSIFIER, and the gate can fail:** `tests/integration/backup-event-loop.test.ts`
  puts a `tar` shim first on PATH that sleeps a second and writes a marker
  before and after the sleep, so the test knows exactly the window in which
  tar ran; a 20 ms heartbeat runs for the whole call. Against the pre-fix
  code both cases fail with **`expected 0 to be greater than 0`** — zero
  heartbeat ticks inside the tar window — and pass after. The gate asserts
  about the LOOP, not about a duration: no threshold to tune.
- `tests/unit/backup-tar-contract.test.ts` holds the artefact of cases: the
  bridge re-exports every runtime export of the shared module; the CLI and
  the runner produce the **same archive** from the same tree; a tar failure
  still names the reason; and no file in the archive path waits on a child
  process synchronously.

**WHAT IS STILL OPEN, stated rather than hidden.** The 1 842 ms that remain is
the chain verifier's block reads (`verifyChainIntegrity` reads 12 380 blocks
one at a time), not tar. It is 24× under the unit's `TimeoutStopSec=45`, and a
stop is answered inside it — but it is a real pause, and it belongs to the
storage layer, not to this rule.

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
defect this repository's own ledger keeps finding — _one rule, two owners, no
gate that compares them_. E-01 is the bridge's vocabulary, E-03 is the rule
that decides whether a chain name is safe, E-04 is the rule that decides
where the bridge lives. The block hash (closed 2026-11-23) and the tool
contract (closed by ADR-012) were the same shape.

**So there are two ways to spend the next rounds**, and the ledger is explicit
about the difference:

|                                       | what it fixes                                                   | what it costs                                              |
| ------------------------------------- | --------------------------------------------------------------- | ---------------------------------------------------------- |
| **Break the loop (Family B first)**   | the operator gets loud failures; the wedge stops feeding itself | does not make the runtime _developed_ — it makes it honest |
| **Close the owners (Family A first)** | the boundary stops being a guess                                | does not stop the loop today                               |

The house has already decided which of these it does first: the ledger's own
rule is "one owner per rule, one artefact, two runners", and every gate in
this repository is of that shape. A runtime is called _developed_ when its
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

| Hypothesis                                                                                                               | What the measurement said                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The `src/` tree still reverts the #767 stale-WAL-lock fix, so the next build restores a busy-wait                        | **False.** `src/infra/storage/task-queue-wal.ts`, `src/infra/runtime/process-lock.ts` and `tests/unit/task-queue-wal.test.ts` all match commit `807350e85e` byte for byte. The fix is present.                                                                                                                                                                                                                |
| Two different native binaries are reachable in production (the service's release `.so` and the CLI's debug `index.node`) | **False today.** `crates/memphis-napi/index.node` and `target/release/libmemphis_napi.so` are the same file — sha256 `0f47b84c81c8e3ea…`, 7 377 664 B. It was true on 2026-11-21 (a 58.7 MB debug build) and was closed by `scripts/check-native-bridge.mts`, which now gates artifact freshness, the split brain, and `catch_unwind` on every export (added 2026-11-22, commits `722653bb05`, `370014cf90`). |
| `scheduler.tick()` can reject and kill the daemon every 30 s                                                             | **False.** `tick()` has its own `try`/`catch`/`finally` (`src/infra/runtime/scheduler.ts:1012`+), and the daemon policy does not exit on an unhandled rejection either.                                                                                                                                                                                                                                       |
| The block hash is computed by several different formulas                                                                 | **False since 2026-11-23.** `src/core/chain-hash.ts` is the only TypeScript owner; the native owner is `crates/memphis-core/src/hash.rs`, and the two are compared by `tests/fixtures/block-format-parity.json`.                                                                                                                                                                                              |
| The public chat loads every block of three chains per request                                                            | **False since 2026-11-23.** `PUBLIC_CHAIN_TAIL_LIMIT = 1000` windows the non-journal chains and the reader is streaming (`readPublicCandidates`).                                                                                                                                                                                                                                                             |
| The consent gate and the relay have no tests                                                                             | **False since 2026-11-23.** 22 tests, 12 falsifiers.                                                                                                                                                                                                                                                                                                                                                          |
| The fatal guard decides "daemon" by scanning argv for `serve`, and the parser lets a boolean flag eat the command        | **False since 2026-11-23.** Both closed, with 18 tests and 11 falsifiers.                                                                                                                                                                                                                                                                                                                                     |

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

State today, measured 2026-11-25: (1) **fails** — E-01, E-02, E-03 and E-04 are
closed, E-09 is closed in six phases; (2) **fails** — the bridge's vocabulary, the chain-name
vocabulary and the embed profile have their artefacts and their two runners,
E-09 is closed in six phases; the package artefact now has an owner and a runner as well
(E-12: the gate installs under a declared policy, proves the native binding and
probes a command that opens the database); (3) **holds** — every gate added in
the last four rounds ships
with proven falsifiers; the bridge gate found a hole in itself on its first
run, the chain-name gate was run BEFORE its fix and failed with
`[".archives", "cases.backup-2026-07-07T15-07-23-108Z", "journal"]`, and the
embed-profile gate was run before the fix and failed with
`left: 32, right: 768` — and then failed AGAIN on its first CI run, on a
hole in its own artefact; (4) **fails** — E-05 alone: the fifteen recovery
turns need the operator's acknowledgements, and no code can clear them.
E-07 (a clean drain left the unit down, because a clean exit is not a
failure) and E-08 (the retention was a latch, and the drill's verdict was a
property of the machine) are closed, and so is E-16 — the cockpit named a
`/recovery` command it did not have, and the escape from the wedge now
lives where the wedge happens; (5) **holds** — the
two dead files are gone; (6) **holds** — the block-format, tool-contract,
bridge-vocabulary, chain-name and embed-profile artefacts are generated;
(7) **holds**.

The first step closed (1) and (2) for the bridge's vocabulary, and (5) on the
way through; the second closed (1) for the bridge path; the third closed (1),
(2) and (3) for the chain-name vocabulary; the fourth closed (1), (2) and (3)
for the embed profile; the fifth closed (2) for the artefact that ships — the
package-artifact gate now installs under a declared policy, proves the native
binding, and probes a command that opens the database (E-12).
**Next, in this order:** Family B's
wedge (E-05), which needs the operator's fifteen acknowledgements before
any code can help — and, beside it, the ONE residual this round measured
rather than hid: the rotation's `.jsonl.gz` archives inside a backup are
still not verified, because the drill has no reader for them. The other
residual — the drill's synchronous tar passes, which is what turned a stop
into a SIGKILL — is **closed** as of 2026-11-25 (decision #594): the tar
rule has one owner and every call through it is asynchronous, the drill's
longest silence fell from 11 302 ms to 1 842 ms, and a stop aimed at the
drill is now answered in 1 ms.
