## Unreleased

### The case index is checked against the chain it caches

The case index is a cache; the chain files are the truth. On this host the
cache had lost a third of its entries, and nobody asked.

Measured on the operator's host: the `cases` chain holds **2 190** case
blocks; `~/.memphis/case-index.sqlite` held **1 372** rows — the missing
**818** included the host's only nominative entry and both instrumental
ones. The two query paths of the same adapter disagreed: the Rust path
(the live one) answered 1 372, the TypeScript path answered 2 190.

Two findings:

- **Nothing noticed, because the wrong signal was available.** The index's
  highest block index was the chain's last, so every check that looked at
  the tail said "fine" — a gap at the *head* is invisible to it.
- **The repair existed and was dead code.** `reconcileIfNeeded()` — whose
  own doc says it ensures the index matches the filesystem — had no caller
  in the tree, and neither did `rebuildIndex()` beside it.

The index is now checked before it is read: the owner answers how many
entries it holds (`case_index_status`, a new optional bridge export — 43
exports now, not 42), the runtime compares that count with the chain's
count of case blocks, and the index is rebuilt when they differ. The count
is the chain's count of *case* blocks, so the check cannot loop, and it
cannot miss a gap at the head.

This host is repaired: one query through the adapter took the index from
1 372 rows to **2 190**, and the two paths now agree to the entry.

The cost, stated plainly: the check scans the chain (233 ms for 2 190
blocks), so the Rust path now answers in 323 ms against the TypeScript
fallback's 283 ms. The Rust path's speed advantage on this host is gone,
because the check costs what the fallback costs — the old speed was bought
with a wrong answer. The check lands only on the MCP tool and the CLI.

The index's primary key is still `block_index` alone, and this host has a
second case chain whose 276 blocks carry the same indices as the live
chain. Nothing collides today — the rebuild covers one chain — but a
rotation is close (the threshold is 10 MB, the chain is 8.8 MB). That
needs a schema migration, not a quiet edit.

### The embed-profile family has one owner — and the last hand-written type is gone

The last family of bridge payloads, and the last surface that owned a
payload type by hand.

Measured on the built module: the manifest answers six keys and the facts
fourteen, and the manifest's own `modes` carries **three** — `local`,
`alias` and `providers`.

- **The type did not describe the wire.** The hand-written
  `EmbedProfileManifest` declared `modes` with two keys; the wire has
  carried three since the manifest was written. The missing one is
  `alias` — the word that means "the OpenAI-compatible provider"
  (`RUST_EMBED_MODE=provider`). The shape comes from the owner now, and
  the closed vocabularies come with it.
- **The gate learned a third kind of source.** The embed profile's words
  live in constants (`SOURCE_ENV`, the four `VERDICT_*`,
  `PROVIDER_MODE_NAMES`), so the gate reads a constant as the source of a
  closed vocabulary — one word (`&str`) or a list of them (`&[&str]`). A
  name that resolves to two things is refused, not guessed.
- **A list of words is as closed as one word.** The manifest's three
  lists are rendered as unions —
  `('env' | 'index' | 'local-deterministic')[]` — with the brackets,
  because `'a' | 'b'[]` is a union of a word and an array.
- **The `Option` fields are present and null**, measured: an environment
  without an index answers `indexDimension: null`, and a process without a
  mismatch answers `dimensionRemedy: null`.

The ratchet counts the surfaces that still own a payload type: **one down
to zero**. No TypeScript surface declares a bridge payload type by hand any
more — every shape the bridge carries is the owner's, projected into one
mirror and checked by two runners.

### The manifest family has one owner too

The fourth family of bridge payloads, and the one the runtime reads first:
`bridge_manifest` is what the bridge serves about itself, and what the
runtime asks before it decides the bridge is good enough to start.

Measured on the built module: six keys, in this order — `exportBindings`,
`exports`, `name`, `optionalExports`, `requiredExports`, `schemaVersion`.

Three findings:

- **The shape was written down twice** — once in the runtime's
  `RustBridgeManifest` and once in the export projection's reader — and
  both copies were wrong the same way: they marked `exportBindings` and
  `optionalExports` optional, while the wire always sends both. Both
  copies now come from the owner.
- **`optionalExports` carried the wrong answer and nobody read it.** The
  wire carried a hand-written list of two names (`mv2_export`,
  `mv2_inspect`) — a leftover from June 2026, from before the export
  table existed — while the table already knew ten optional exports. It
  is derived from the table now, so the answer cannot drift from the rule
  it reports, and a gate holds it there.
- **The answer had no owner**: it was a `json!` literal, like the chain
  and soul families. It is a struct now, and the binding it carries is a
  typed struct too.

One measured wire change, and only one: `optionalExports` now carries the
table's ten optional exports instead of the hand-written two. The key set,
the types, the key order and every other value are identical.

`exportBindings` is optional in the contract for a measured reason: a
binary older than the vocabulary table (before 2026-11-23) does not send
it, and the export projection already failed loudly when it was missing.

The ratchet counts the surfaces that still own a payload type — two down
to one, and the one that remains is the embed-profile family.

### The embed family has one owner too

The embed family's payloads were measured on the built module — against an
isolated index, so the operator's own index was never touched — and three
things showed up that the source does not say out loud:

- **`embed_discard_replacement` carries TWO shapes.** Without an initialized
  pipeline it answers three keys; with one it answers seven. The TypeScript
  side declared `{ discarded: boolean }` and cast the other six away without
  knowing they were there.
- **The wire's `normalized` is a WORD, not a boolean** — `"true"` or
  `"provider-dependent"`, never `"false"`, never missing. The side declared
  `boolean | string` and wrote a helper to guess which it had got, including
  a branch for a `"false"` that cannot arrive and a fallback for a missing
  value that cannot arrive either. Both are dead code, and both are cut.
- **A closed vocabulary needs an owner too.** The owner declares the words
  *and* the function that writes them; the gate parses that function out of
  the crate's source and compares, so the owner can neither invent a word
  the crate never writes nor forget one it does.

The embed family is migrated onto the same owner as the vault family: nine
payloads, nine shapes, the closed vocabularies rendered as unions
(`normalized: 'true' | 'provider-dependent'`) instead of a bare `string`.
The ratchet counts the surfaces that still own a payload type — six down to
four — and the counter may only go down.

Dead code went with it: the chain adapter's `embedStore` and `embedSearch`
had no callers anywhere in the tree, and with them three hand-written copies
of the embed payloads, one of which silently dropped the `tags` field of
every hit.

The wire itself did not move in MEANING: the probe before and after the
change answers the same keys with the same values. Its key ORDER did move —
a `json!` literal is a `serde_json::Value`, whose map is sorted, while a
struct serializes in declaration order. Nothing reads a JSON object by
position, so no consumer can observe the difference; the correction is
recorded in the ledger.

### The chain, soul and case families have one owner too

The third family of bridge payloads, and the one that had NO shape at all:
the `chain_*`, `soul_*` and `case_*` answers were built from `json!`
literals — a payload with no owner, which is how the TypeScript side
ended up hand-writing its shape.

Measured on the built module (the case family's SQLite index pointed at a
scratch directory, so the operator's own index was never touched):

- **`case_query` answers with SIX keys per row** — `block_index`,
  `block_hash`, `chain`, `case_type`, `full_json` and `entry`. The
  hand-written `CaseIndexRow` declared TWENTY-FOUR fields, none of which
  the wire sends, and was missing `entry`, the one key that carries the
  case itself. The adapter's two query paths therefore answered with two
  different shapes.
- **`memphis explain --case-type` read fields that never arrive.** It
  printed `entry.entity` and `entry_timestamp` off the row; on the Rust
  path those keys do not exist, so it printed an empty entity and a `?`
  for every row. It reads the case under `entry` now.
- **`case_rebuild` answers with THREE keys** — `indexed`, `skipped` and
  `errors`. The TypeScript side knew two of them.

The owner grew a rule it did not have: the ENUM shape. A tagged enum has
no struct and no field list — the wire carries the tag plus the fields of
that one variant — so the owner declares the tag and the union of the
variants' fields, and the gate checks the tag's name, the union's order
and the presence of each field. The gate also reads a vocabulary from an
enum now (its variant names, renamed by the enum's own rule) and refuses
a read-side alias in one: an alias is a word the crate accepts on read,
never a word the wire writes.

The ratchet counts the surfaces that still own a payload type — four down
to two, and the two that remain are the manifest and embed-profile
families.

Dead code went with it: the case adapter's `extractFields` built the
eighteen flat fields the wire never sends, and the row it fed them into
was the hand-written type. Both are gone.

### The bridge's payload shapes have one owner

The shape of what the bridge carries was guessed, in seven TypeScript files.
The guess was not carelessness: the Rust owner speaks two conventions — a
`#[napi(object)]` struct with an explicit `#[napi(js_name = "...")]` is
exported in snake_case, one without it in camelCase. Measured 2026-11-24 on
the built module: `vault_load_state` returns `error_code`,
`vault_decode_entry` returns `errorCode`, `vault_parse_entries` returns
`entriesJson`. One hand-written interface covered two payloads, so it hedged
over both spellings.

The shapes now have one owner (`crates/memphis-napi/src/bridge_payloads.rs`),
the projection copies them into an artefact and a TypeScript mirror, and both
arms check themselves against it. The vault family is migrated; the six
surfaces that still own a payload type are counted in the gate, and the
counter may only go down.

The compatibility with older binaries stays and is now declared rather than
guessed: the naming stabilization of 2026-03-21 changed `master_key` and
`created_at` from `masterKey` and `createdAt`.

## v1.14.2 - 2026-11-24

One ledger entry closed: the package that ships. The published v1.14.1 tarball
installed cleanly and then could not start — and every gate said it was fine.

### The tarball that ships is now the thing the gate looks at

Measured on the operator's host, 2026-11-24, against the **published** v1.14.1
tarball (`memphis-chains-memphis-1.14.1.tgz`, 4 599 032 B, checksum verified
against the workflow's own `SHA256SUMS`), installed into a clean prefix with
npm 12.0.2:

- the install **succeeded** (exit 0);
- every command died with `Could not locate the bindings file` and thirteen
  candidate paths;
- `node_modules/better-sqlite3/build/` did not exist — the native binding was
  never built.

npm 12 blocks dependency install scripts by default and reads `allowScripts`
from the **project root**, so a published package cannot approve its own
dependencies: the installed `package.json` carried
`{"better-sqlite3": true, "esbuild": true, "onnxruntime-node": true}` and the
script was blocked anyway. `better-sqlite3` ships no prebuilt binding — its
install script is the thing that fetches one.

The gates missed it because `ops:validate-package-artifact` installed with
`--ignore-scripts` — which guarantees that no binding is built — and probed
only `memphis --help` and `memphis completion bash`, neither of which opens
the journal database.

What changed:

- **The gate installs under a declared policy**, proves the native binding
  exists, and probes `memphis vault list --json` — a command that opens the
  database.
- **The CLI names the cause and the remedy.** A missing binding now prints
  what npm 12 did and the one line that fixes it, instead of thirteen paths.
- **The README documents the npm 12 rule** for operators, including why
  approving `onnxruntime-node` breaks the install (its script downloads a CUDA
  build that answers 404; the CPU runtime ships inside the package).

Falsifier, measured on this host: with the approval revoked in the install
prefix, the gate fails with `the installed package has no better-sqlite3 native
binding`. With it, the binding is there and `memphis vault list --json` answers
`{"ok": true, "entries": []}`.

## v1.14.1 - 2026-11-24

One ledger entry closed: the embed profile. The dimension and the index
path had defaults from two different eras, and four owners that disagreed.

### The embed profile has one owner, and it answers with its source

"Which embedding profile is in force?" had four owners on this host and four
answers. The dimension default was a hard-coded `32` in four places plus the
config schema — and `32` was never an embedding dimension: it is
`DEFAULT_EMBEDDING_DIM`, the width of the LOCAL DETERMINISTIC embedder,
the placeholder used when no provider is configured, applied unconditionally.
The index-path default was written twice with two roots (HOME-based in
TypeScript, data-dir-based in Rust), so the two sides read different files
whenever `MEMPHIS_DATA_DIR` is not `~/.memphis`.

Measured on the operator's host, 2026-11-23:

| process | index it reads | dim | result |
| --- | --- | --- | --- |
| the service (systemd `EnvironmentFile`) | `embed/bge-m3-20261106/index-v1.json` | 1024 | `mode: semantic` |
| a shell, the CLI, any spawned script | `embed/index-v1.json` | 768 on disk vs **32** configured | `index_dimension_mismatch: disk_dim=768 config_dim=32` |

The mismatch was not the cause. The cause was that the shell has no
provider configured at all.

The rule now lives in ONE module, `crates/memphis-embed/src/profile.rs`:
the index path, the dimension, the model, the source of each, and the
verdict. The dimension is resolved `env` → the dimension recorded **in the
index on disk** → the local deterministic width (reached only when there is
no index to contradict it). The model is never guessed from a name. The
TypeScript side asks through the bridge and keeps no copy of the rule; the
vocabulary reaches it as a projection.

Measured again, 2026-11-24, the owner asked for the two processes this host
has:

| process | dimension | verdict |
| --- | --- | --- |
| the service | **1024** (from `env`) | `ok` |
| a bare shell | **768** (from the index) | `no-provider` |

The false mismatch is gone, and the verdict names the cause that is there.

A claim the code no longer supported: the comment in
`src/infra/http/health.ts` said the provider's vector was "truncated to the
configured dim without warning". That was true on 2026-10-25 and stopped
being true on 2026-11-06, when the provider path became strict (PR #749).
The comment survived 18 days and was quoted in the error ledger; it is now
the measured behaviour — with a provider the wrong width is a **loud**
error, with the local embedder it is the **silent** one
(`cosine_similarity` returns 0.0 for vectors of unequal length).

Shape: one owner, one artefact of cases (14, every one naming a committed
fixture index), two runners (Rust 7 tests, TypeScript 9 tests), and a gate
that fails when the mirror drifts (`ops:sync-embed-profile-contract
-- --check`, in CI).

## v1.14.0 - 2026-11-23

316 commits since the `v1.13.5` tag. A new chain, one owner for the tool
contract, one owner for the chain-name rule, and a measured error ledger that
says what is still open — including what is not.

The shape of the release is the shape of the house's rule: **one owner per
rule, one artefact per cross-boundary rule, two runners, and a gate that can
fail.** Every cross-arm rule that was decided in two places now has one owner
and a gate; every claim in the notes below is a number measured on the
operator's host.

### The tarball ships every module the CLI loads

The first attempt to publish v1.14.0 failed. The `release` workflow's first
step packs the npm tarball, installs it into a temporary prefix and runs the
real binary — and the binary died on startup:

```
[ERROR] Failed to load Memphis CLI: Cannot find module
  '.../node_modules/@memphis-chains/memphis/scripts/backup-manifest.mjs'
  imported from '.../node_modules/@memphis-chains/memphis/dist/infra/cli/commands/backup-manifest.js'
```

`src/infra/cli/commands/backup-manifest.ts` imports
`../../../../scripts/backup-manifest.mjs` — a file OUTSIDE `src/` — and
`package.json`'s `files` list did not mention it. The import is a
module-load-time import, so the omission broke **every** command, not one;
`memphis completion bash` was simply the first probe the validator ran.
Introduced by `f4b9bc2875`; `git log -S"scripts/backup-manifest.mjs" --
package.json` was empty, so the path had never been published.

The list in `files` was a denylist of omissions, and a denylist nobody checks
is a wish. The rule is now inverted: `scripts/check-package-runtime-closure.mts`
discovers every file the shipped code imports from outside its own tree, and
each one must be listed. Measured on this host: **2** such edges
(`scripts/backup-db-snapshot.mjs`, `scripts/backup-manifest.mjs`), both
covered. The artefact is `tests/fixtures/package-runtime-closure.json`; the
runners are the script and `tests/ops/package-runtime-closure.test.ts`.

The gap that let this reach CI was the gate list itself: the local preflight
never checked the tarball, so it reported `ok: true` for a broken artefact.
Both packaging gates now live in `ops:release-preflight` — the fast closure
check (seconds) and `ops:validate-package-artifact` (minutes) — so the suite
the operator runs before a release is the suite CI runs.

### The gate that was green where it was measured, and red where it was not

The public chat's `/ready` answers 200 only when the provider is configured
**and** the basal layer is healthy — and the basal layer is an HTTP service on
127.0.0.1:8000. The relay's test asked the **real** service, so its verdict
depended on whether a basal service happened to be running.

Measured 2026-11-23: this host answers `/health` with `{"ok":true,"ready":true}`,
so the test passed locally; a CI runner has nothing on that port, so the test
failed there with `expected 503 to be 200` — the required
`cross-arch (ubuntu-24.04-arm)` check was red, and the failure was already
present on `34cb179074`, before this release's fixes.

A test that is green where it was measured and red where it was not is a test
that hides itself. The readiness check is now injected next to the classifier
that was already injectable, and the test pins the three real cases — provider
configured and basal ready (200), provider unconfigured (503), basal not ready
(503). The third could not be told apart from the second before. The test
also points the ambient basal URL at a closed port for its duration, so it is
its own falsifier: if the injection is ever dropped, it fails with the CI
message instead of quietly depending on the room.

### One dependency bump (RUSTSEC-2026-0592)

`url` 2.5.8 → 2.5.9 (with `form_urlencoded` 1.2.2 → 1.2.3). The advisory was
issued on 2026-11-22: `Url::origin()` recursed into `blob:` URLs without a
depth limit, so a 50 KB URL with 10 000 nested `blob:` prefixes overflowed the
stack and killed the process — `catch_unwind()` does not catch a stack
overflow. `url` reaches Memphis transitively through `ureq` in
`memphis-embed`. Fixed upstream in 2.5.9; `scripts/cargo-audit-check.sh`
reports no vulnerabilities against the new lockfile.

### The chain-name vocabulary has one owner (ledger E-03)

"What is a chain called?" had four owners and three answers. The native
runtime asked *"does the name end in `.backup-<digits>`?"* and nothing else —
so an archive whose stamp was a DATE was a live chain, an archive whose stamp
was a number was not, and `.archives` (the dot-directory the rotation writes
its `.jsonl.gz` files into) was a chain.

Measured on one disk state: the runtime's status counted **11 510 blocks in 14
directories**, the live chains hold **11 234 in 12**, and the audit counted
**11 981**. The 276-block gap was one archive of `cases`, counted as if it
were the chain itself.

Now: `crates/memphis-paths/src/chain_names.rs` owns the vocabulary, the
bridge serves it (`bridge_chain_name_manifest`, `bridge_chain_name_facts`),
the projection reads the owner's ANSWERS through the built bridge and writes
`tests/fixtures/chain-name-contract.json` (36 cases) plus the TypeScript
mirror, and both arms check themselves against that artefact. The native
runtime counts **12 directories and 11 236 blocks**; the audit keeps counting
archives on purpose — verifying an archive is its job — and now labels that
number "scannable" instead of "live" (747 of those blocks are copies of a
chain, not new memory).

### The bridge's export vocabulary has one owner (ledger E-01)

The vocabulary of the N-API bridge was declared in three places and compared by
nobody. Measured by reading the built module: the binary exported **37**
functions, the manifest named **34** — three real exports were unreachable from
TypeScript and nine names were spellings the bridge never exports. One table
(`crates/memphis-napi/src/bridge_exports.rs`) owns it now, the manifest serves
it, the projection copies it into the artefact and the TypeScript mirror, and
the gate checks the table against the crate's own `#[napi]` declarations.
The bridge exports **39** functions in this release (the two chain-name
vocabulary calls), and every one of them can be named from TypeScript.

The gate found a hole in itself on its first run — flipping one export's
`required` flag was caught by nothing — so the required FLOOR now lives in
the Rust arm, and relaxing it is a deliberate change to the gate rather than
a quiet edit in the table.

### One tool contract across the bridge (ADR-012)

The native surface advertised 23 tools whose schemas were a second copy of the
TypeScript registry, and the copies had drifted: five tools advertised
different arguments than the registry, and `memphis_self_modify` meant "write
one file" on one side and "apply changes to many files" on the other.

The native catalog is now a **projection** of the registry — every tool,
`23 of them`, and the `DIVERGENCES` table is **empty**: all five were closed
when the native arms started honouring the registry, and the table stays so
that the NEXT divergence is declared there instead of discovered in
production. The fixture `tests/fixtures/native-tool-contract.json` is read by
both arms. The commit-
culture stub, which described a tool that never shipped, is gone.

### The public chat: a gate per block, and a bounded window

Consent is read **per block**, not per chain: the journal's 1 071 blocks hold
287 `consent=exportable` marks and exactly one carries the `public-chat` tag,
so a chain-level default would publish far more than the operator agreed to.

The public catalog also stopped reading three chains in full on every
request. It asked for `Number.MAX_SAFE_INTEGER` blocks — 36 MB of JSON parsed
into objects per request, to find one usable note — and that is where the
runtime's 9.6 GB memory peak came from. The window is now 1 000 blocks for
the non-journal chains, the journal is still read in full (it carries the
consent annotations), and one block is in memory at a time.

The relay distinguishes a wrong body from a wrong conversation: a non-JSON
body is **415**, a JSON body that is not a conversation is **400**. Eleven
tests, eight falsifiers.

### The fatal guard and the CLI parser

The daemon guard decided "am I the daemon?" by scanning the whole argv for
the token `serve` — three of seven shapes were wrong, and `memphis ask serve`
never finished the process: it hung the shell. The guard now asks the parser
(`serve`, `mcp serve`) and resets cleanly.

The parser had a second defect: a logical flag **ate the command**. `memphis
--safe-mode health --json` printed the usage guide and exited 0 — the health
check never ran and safe mode was never on. 40 boolean flags are now declared
as such.

### Chain rotation, archives, and one block format

The chains grew without bound: the `system` chain held 15 748 blocks and
62 MB, and 180 of the last 200 were scheduler noise; the `insights` chain
held 33 MB because every generated insight embedded full copies of its
sources. Rotation existed and could not be enabled, because a rotated chain
produced a chain every validator rejected as "missing genesis block".

Fixed: the rotation head marker proves the live chain continues an archive,
the publish step runs under the same write lock the append path takes (so no
reader observes a chain mid-rotation), the archive is readable by the reader
that reads chains, and the archive GC keeps four archives per chain.

A block file now has **one byte format**, written by both arms — the
migration was the odd one out. The insights chain no longer copies its
sources into itself.

### The operator's to-do is structural, not prose (#773)

An item addressed to the operator sat inside the free-text `activeWork`
field, nothing said whose item it was, and the agent read the operator's
to-do as its own assignment — sixteen tool calls and a generic "I stopped at
the tool limit" reply to a one-word greeting. The distinction is now a
field: `context.operatorTodo`.

**The merge found the gap.** `main` added the field to the runtime's shape
and to the native hand-written schema, but not to the registry — and a zod
object strips the keys it does not declare, so the operator's to-do was
dropped before it reached the write path. The registry is the single truth,
so the field is declared there, and the projection carries it to the cockpit.

### Measured, not assumed: the error ledger

`docs/design/MEMPHIS-ERROR-LEDGER.md` lists ten open errors with a
measurement each, six **rejected** hypotheses (measured false, so nobody
spends a round on them again), the connections between the errors — one loop
in three families — and "developed" written as seven checks that can be run
rather than admired. Three of the seven open items are closed by this
release (E-01, E-03, E-04).

### What is still open

- **E-02 — the embed profile.** The semantic half works only in a process
  that has the service's environment. Measured at the recall surface: the
  service answers `mode: semantic`; a shell or the CLI answers
  `index_dimension_mismatch: disk_dim=768 config_dim=32`. The failure IS
  reported (`degraded: true` plus the message), but the dim default `32` is
  written in four places and the index-path default in two, so a fresh
  install reproduces the broken profile by construction.
- **E-05 — the wedge.** 15 recovery turns still wait for an operator who
  cannot clear them from where he is: the acknowledgement path wants a local
  TTY and the operator's passphrase, and the TUI has no recovery command.
- **E-07 / E-08 / E-09** — the clean drain that exits 0 (so systemd does not
  restart the runtime), the backup retention that stops when the restore
  drill fails, and the bridge's payload types (which have no `index.d.ts`).
- **The taxonomy.** The chain-NAME rule is shared now; the chain-LIST is
  not. The native runtime lists `_quarantine` as a chain and the TypeScript
  registry does not — twelve directories against eleven. It holds 0 blocks
  today, and that is the point.

## v1.13.5 - 2026-10-02

40 commits since the `v1.13.4` tag. Two release blockers closed, one test-isolation
defect that wrote to the operator's live configuration, and the Tauri/concurrency
work that was already in flight.

### Release blockers (both found via the nightly-crystal artifact, not the job log)

- **Format gate.** `scripts/format-check-changed.sh` checks `HEAD^..HEAD` only, so
  the gate saw a regression introduced in `ed2f1f4`: 11 files violated Prettier.
  Reformatted; the only text-level change is one `.toBe()` call collapsed to a
  single line, semantics identical, `tsc` clean.
- **Dependency audit.** `@grpc/grpc-js` 1.14.0–1.14.4 carries two High advisories
  (GHSA-m9gg-hp2v-232j, GHSA-f596-whhp-79r4). `nightly-crystal-pass.sh:143` runs
  `npm audit --omit=dev --audit-level=high`, so this is a hard gate, not advisory.
  Bumped to 1.14.5 in `overrides`.

### Configuration isolation (the `sk-test` mystery)

- **`mcp-config-set.test.ts` wrote to the operator's real `.env`.** The test set
  `MEMPHIS_ENV_PATH`; the variable `resolveDotEnvPath()` actually reads
  (`src/infra/config/dotenv-file.ts:7`) is `MEMPHIS_ENV_FILE`. The override was
  ignored, every run resolved the install-root `.env`, and `setDotEnvValues`
  wrote production config — which is how a `ANTHROPIC_API_KEY=sk-test` placeholder
  kept reappearing and why `GEN_TIMEOUT_MS` reverted to a stale 45000 against a
  600000 value the surrounding comment justified at length.
- Fixed the variable name, changed the test value to `123456` (45000 was a real
  operator setting), and added a guard test asserting writes land in the per-test
  tmp `.env`. All 8 original tests preserved.
- **`npm-shrinkwrap.json` is the pin, not `package-lock.json`.** The latter is in
  `.gitignore:9` and unused by `npm ci`. Changing `overrides` without syncing the
  shrinkwrap fails the `Install` step. One-line diff; rebuilding the lock dragged
  in unrelated drift (`@napi-rs/wasm-runtime`, `@tybys/wasm-util`).

### Providers and models

- **MiniMax M3 context window (#654).** The anchored regex in
  `model-capabilities.ts` missed `M3.1-Flash-Preview` and capped it at 32k instead
  of 1M. `MEMPHIS_CHAT_MAX_MESSAGES` raised to 20000 to match.
- **Health now separates "configured" from "usable" (#653).** A provider with a
  vault ref pointing at a non-existent entry is no longer reported as healthy.
- **Dead vault refs removed from `.env`.** `DEEPSEEK_VAULT_KEY` and
  `GLM_VAULT_KEY` pointed at entries that never existed, producing a
  `vault_not_found` loud skip on every boot (`doctor-v2.ts:977`). `MINIMAX_VAULT_KEY`
  is valid and stays.

### Telegram

- **`memphis_send` could not send with real configuration** (`ed2f1f4`). The tool
  read `process.env` directly, so `VAULT:telegram_bot_token` went out verbatim and
  Telegram returned 404, and it looked for `TELEGRAM_CHAT_ID` while the operator
  configures `MEMPHIS_TELEGRAM_CHAT_ID`. Added `resolveTelegramBotToken` with
  vault-first ordering; 10 new test files, one case each (the shared-`stubGlobal`
  approach made the file order-dependent and intermittently unbound).
- **Inbound logging added** to `telegram-presence.ts` — the middleware every
  update already passes through. Logs `updateId`, `fromId`, `username`, `chatId`,
  `allowed`, `tier`, and a 200-char preview, with allowlist-rejected messages on a
  separate `warn`. Previously the gateway logged nothing inbound, so traffic it
  received and dropped was invisible.

### Concurrency, memory, and runtime

- **ADR-009 cross-process write race (#643).** Regression test drives two
  concurrent `writeBlockAtomic` callers; the corruption class is a race, so the
  test has to actually race.
- **Memory persistence limit (#651).** `assistantReply.slice(0, 500)` truncated
  what the embed index saw, so semantic search could not recover long answers
  beyond 500 chars. Raised to 4000 with a `MEMPHIS_MEMORY_REPLY_LIMIT` env
  override and a regression test.
- **Four real bottlenecks behind the three "flaky" timeouts (#650).** Also
  carries the `memphis_soul_write` / `memphis_case_query` / `memphis_case_append`
  JSON Schemas, which were bare `{"type": "object"}` with no `properties` — the
  model was guessing the shape and reaching for `{"item": [...]}`. Now every list
  field is `array` + `items` with `additionalProperties: false`, guarded by
  `tool_schemas_declare_no_array_without_items`.
- **Worker panic surfacing (#652).** A panicking worker reported as
  "stopped without a terminal event"; the panic reason now reaches the operator.
- **Security event no longer corrupts runtime health** (`df290c6`).

### Ops and desktop

- **Backup USB autodetection** (`cd63745`, contract in `315a16d`). The script
  hardcoded a pre-XDG path while this host automounts under `/run/media`, so every
  run exited 2 and `SuccessExitStatus=0 1 2` reported it as success.
- **Tauri Phase G-minimal scaffold** (#644). Two real bugs fixed en route: the
  manifest path was two levels off, and adding Tauri to the cargo `members` list
  broke `cargo build --workspace` on `glib-sys`, so it moved to `exclude` with a
  documented build command.
- **Phase L offline-invariant CI gate**, dashboard DB + API, chain integrity
  sweep with an hourly timer, and `set-github-pat` helper.

### Repository hygiene

- Client data and a Telegram `chat_id` scrubbed from what was, until
  `68780a7`, a public repository. `.gitignore` hardened for operator artifacts
  (`7a99797`, `fe9f150`).
- CHANGELOG entry for v1.13.4, which had 61 undocumented commits (`536812a`).

### Verification

- `unit`: 405 files / 2876 tests passed. `integration`: 60 files / 227 tests passed.
- `tsc --noEmit` and `eslint` clean. `cargo test -p memphis-operator schema`: 6/6.
- `nightly-crystal-pass.sh`: pass=8 fail=0.
- CI run `37038551780` on `23ffbc9`: `quality-gate` 15/15, plus
  `cross-arch (macos-latest)` and `cross-arch (ubuntu-24.04-arm)` both success.
- `.env` md5 identical before and after the full 2876-test suite — the isolation
  fix holds at suite scale, not just on a single run.

### Known limitation

`format:check:changed` only inspects `HEAD^..HEAD`, so 186 files in the repository
do not pass `prettier --check .`. This is the gate's intended scope, not an
oversight, and no repository-wide reformat was done here.

## v1.13.4 - 2026-09-21

### CI portability + scheduled workflow PAT fix

- **CI portability.** Workflow runners and local toolchains diverged on shell/locale assumptions; release and CI paths normalized so `npm run ci` behaves identically on ubuntu-latest and on the operator's WSL2 host. Release commit `e6db168`.
- **weekly-runtime-kpi PAT.** The scheduled workflow could not write to `issues.create` — the repo-level cap on the scheduled token overrides any per-workflow `permissions:` block. Fixed by syncing the CI bot token used by the weekly job (`chore/sync-ci-bot-token-script`, PR #641). GitHub issue #638.
- **README version parity.** README claimed `v1.13.4` while CHANGELOG still stopped at v1.13.2. `daa6aa8` aligned README; this entry closes the CHANGELOG side. Contract covered by `tests/ops/public-status-docs-contract.test.ts` and `tests/ops/release-draft-version-parity-contract.test.ts`.

### Merged after v1.13.3

- **ADR-009 + cross-process write race regression** (PR #643, `4b12631`). Concurrent `writeBlockAtomic` race test, 450 lines, plus the ADR. Regression test is the point: the corruption class is a race, so it needs a test that actually races two writers.
- **Tauri Phase G-minimal desktop scaffold** (PR #644, `b55c94f`). Two real bugs fixed in the process: `src-tauri/Cargo.toml` used `path = "../../crates/..."` but sits two levels below `apps/memphis-gui`, so the manifest never loaded; adding Tauri to the workspace `members` list broke `cargo build --workspace` on `glib-sys`, so it was moved to `exclude` with a documented build command instead.
- **`canSelfModify` computed + MiniMax H3 integration** (PR #649, `738b50c`). Branch reduced from 39 to 7 commits before merge — `git cherry` showed 35 were already in main under different merge commits. Adds the `play-customer-promo-video` skill and `.gitignore` hardening.

### Repository hygiene (2026-09-29)

- **Post-reset memory restoration.** `memphis reset --runtime` cleared chains, soul memory, and several working directories. Restored 14,077 blocks from `pre-reset-2026-09-29` (SHA256-verified, custom linkage check 14,077/14,077 clean), soul selectively (10 preferences, 4 strengths, 9 of 35 learnings after dropping activity-clock noise), plus `halt/`, `audit/`, `scripts/`, `skills/`. Both search indexes rebuilt: FTS 2 → 5,435 entries, semantic 2,084 → 10,046 docs.
- **Embedding throughput characterized, not guessed.** nomic-embed-text costs ~418 ms/chunk on this host regardless of batch size (batch=8 → 381 ms, batch=64 → 410 ms) or concurrency (1/2/4/6 → 418/420/426/424 ms) — Ollama serializes internally. Token-limit edge case found and worked around: dense Polish text at 4,000 bytes exceeds the 2,048-token context window, so chunk 107-c0 needed byte-safe truncation to 3,800.
- **Offsite backup silently broken for 2+ days.** `scripts/backup-to-usb.sh` hardcoded `/media/memphis/usb-backup` (pre-XDG), but this host automounts at `/run/media/$USER/memphis-usb-back`. Every run logged "not a mountpoint", exited 2, and `SuccessExitStatus=0 1 2` reported it as success. Replaced with `resolve_usb_dir()` probe + `MEMPHIS_USB_DIR` override.
- **HALT registry: two dead entries removed.** `477256d46949788d` guarded a linter script that was never committed (verified via `git log --all`), and its premise was disproved — all 10 workflows using `actions/setup-node` already have an explicit `npm ci`. `a3e22cf68b5da623` said "staged but not committed" about a file committed 8 days earlier in `49d301c`, and carried a stale `memphis/` path prefix. Both deregistered with backups and audit entries; `bbb6dcf315560236` kept — `memphis-chain-draft/` is 1,287 LOC outside the repo and the roadmap marks it deferred.
- **Client and account data scrubbed from the public repo.** `notes/szczepan-briefing-2026-04-26.md` (a named third party) removed, copy at `~/private-work/`. Telegram chat id replaced with `${TELEGRAM_CHAT_ID}` across 11 files, and with the neutral `99999999` in 5 test fixtures — 62/62 unit tests still pass. Author name, contact, and host/port deliberately kept: attribution, not leakage.
- **`.gitignore` hardened.** Added `.test-tmp/` (25 stale vitest sandboxes, 804 KB), `work/` (96 MB of private client video renders and conversation dumps), `private-work/`, and `notes/szczepan-*.md`.

## v1.13.2 - 2026-09-12

### Monitoring, self-recovery, and chain-corruption defense

- **Chain integrity sweep + hourly systemd timer.** `scripts/chain-integrity-sweep.mjs` reads the tail (default: 5 blocks) of every chain in `/home/memphis/.memphis/chains/` and verifies each block parses as JSON with required fields (`index`, `hash`). Exits non-zero on any failure with details on stderr. Defensive: read-only probe first, per-chain optional, supports `--tail` and `--chain` flags. Companion unit `memphis-chain-integrity-sweep.{service,timer}` runs hourly with 0–5 min jitter (anti-thundering-herd). Detects the class of chain-corruption bugs observed in decisions #98 (cases/000382.json) and #146 (cases/000385.json) within an hour rather than discovered by a stuck TUI session.
- **Runtime warmup with GPU→CPU auto-fallback.** `scripts/runtime-warmup.mjs` pre-loads Ollama LLM + embedding models at boot so the first request after restart doesn't hit a cold-load timeout (which previously manifested as `Status: provider did not answer in time` on the TUI/Telegram surface). Probe Ollama via `/api/tags` first; GPU VRAM probe via `nvidia-smi` tunes `num_ctx` based on free VRAM. Phase 1: warm with GPU offload. Phase 2: on `signal arrived during cgo execution` (runner crash, observed on GTX 960 with 4 GB VRAM and `qwen2.5-coder:3b` at `num_ctx=8192`), auto-fallback to `num_gpu=0` (CPU only) at smaller `num_ctx`. 30s timeout per request with `AbortController`; per-model retry with backoff; best-effort `exit 0` (never blocks `memphis.service` boot). Companion unit `memphis-warmup.service` (`Type=oneshot, Before=memphis.service`); `memphis.service` modified with `After=memphis-warmup.service` so boot order is deterministic. Verified: `canSelfRecover` flipped from `false` to `true` because `ollamaReachable=true` + `provider.offline.ready=true` now hold at first turn.
- **Scheduled backup runner + standalone tier-0 fix.** `scripts/scheduled-backup-runner.mjs` replaces the broken builtin `scheduledBackup()` path (`scheduler-builtins.js:74` deletes `MEMPHIS_BACKUP_INTERVAL_MS` before calling `tickNow`, so the loop never starts). Standalone runner calls `wal-checkpoint.mjs` first (flushing WAL avoids `file changed as we read it` errors during tar), then runs tar with `--ignore-failed-read` (GNU tar returns exit 1 on any exclude pattern match even with `--warning=no-all`; this flag suppresses non-fatal exit codes). Excludes: `./backups`, `./cache`, `./logs`, `*.lock`, `*.wal`, `*.shm`. Verifies drill (chain blocks present in archive), cleans up old backups beyond `--keep N` (default 7), computes `sha256`. Companion unit `memphis-scheduled-backup.{service,timer}` runs daily at 02:00 UTC (off-peak). Verified: service exit 0/SUCCESS, 23 MB backup with 10859 entries, drill OK, 9 old backups cleaned.
- **Chain read-after-write verification (port of dist fix).** `src/infra/storage/chain-file-io.ts` now ports the existing `dist/` fix (commit `b2cde13 fix(runtime): repair chain reads and case tool payloads #609`) back to source. Without this port, every `npm run build` would compile the unchanged `src/` and overwrite the `dist/` fix, re-introducing chain corruption. Logic: capture previous file content (best-effort) before rename; after rename, read the just-written file back and compare against the payload sent to write — if they diverge (corrupted by trailing garbage, partial write, or serializer race), throw and either restore previous content (if file existed before) or remove the corrupted file (if new index), so the chain integrity sweep can heal it. Type-safe port: reads use `'utf8'` encoding so both `written` and `payload` are strings, compared byte-exact via `written !== payload`. Known limitation: catches corruption AT writeBlockAtomic boundaries — does NOT catch concurrent-process corruption between `writeFile` and `readFile`. For that, `chain-integrity-sweep.mjs` (above) remains the second line of defense.
- **Stable LLM model swap.** `OLLAMA_MODEL` swapped from `qwen2.5-coder:3b` to `qwen2.5:0.5b` in `.env` after the larger model was found to crash its runner with `signal arrived during cgo execution` on this operator's GTX 960. The 0.5b model is smaller (397 MB vs 1.9 GB) and 100% stable. Backup: `.env.bak-pre-model-swap-20260912-010538`.

### Decisions

- **#146** cases chain corruption #385 — root cause zlokalizowany, naprawa lokalna, plan działań na przyszłość
- **#147** chain sweep + integrity monitor — v1.13.2 bump?
- **#148** runtime warmup + GPU/CPU auto-fallback + memphis.service warmup dependency (homeostaza odblokowana)
- **#149** scheduled backup runner — standalone tier-0 fix for scheduler-builtins bug
- **#150** self-modify (tier-0): port dist fix to src — read-after-write verification in chain-file-io.ts

## v1.13.1 - 2026-09-11

### Hardening and self-discipline

- **Anti-confab phase 6 (external facts labeling).** `src/gateway/system-prompt.ts` now requires every concrete figure about the external world (prices, legal fees, dates, statistics, etc.) to be labeled `VERIFIED` (fetched this turn), `UNVERIFIED ESTIMATE` (from model knowledge, not fetched), or `OUT OF SCOPE` (need to fetch). This closes a third anti-confab incident in two days.
- **WAL checkpoint runner.** `scripts/wal-checkpoint.mjs` runs `PRAGMA wal_checkpoint(TRUNCATE)` on `data/memphis.db` with a `PRAGMA integrity_check` guard. Designed to be invoked by a systemd user timer (`memphis-wal-checkpoint.{service,timer}`) every 6 hours with 0–5 min jitter (anti-thundering-herd). Pure Node 22, no native deps.
- **Gitignore hardening for private operator artifacts.** New explicit patterns for `docs/operator/*.{md,html}`, `docs/pilots/memphis-*.md`, `.agent-prompts/`, `.README-PROPOSAL*.md`, `.README-SESSION-NOTES.md`, `wp-json*.json`, and `*.bak-pre-*`. These were staged by mistake in the v1.13 cycle and are per-operator-machine, never part of Memphis public source.
- **ADR-003 versioning model accepted.** Source-code `package.json.version` is the single source of truth; git tags follow `vX.Y.Z`; codenames stay internal. The "v5" leak into the domain and `agents.json` is documented as a known inconsistency to be reconciled in a future release.
- **AUTHORS.md corrected.** Cognitive subpersonas are now listed by their actual runtime identifiers (Model A — Conscious Capture, Model B — Inferred Decisions, Model C — Pattern Recognition, Model D — Collective Coordination, Model E — Meta-Cognitive Reflection). Drafted placeholders that had no implementation (`Iskra`, `Codex Snapshot`, `Cline`, `Claude Code`, `OpenClaw`, `Hermes`) are removed.
- **LICENSE updated.** Copyright holder line now lists only Marcin Kukla; a third-party attribution footer points at `AUTHORS.md` and `NOTICE` for full contributor and dependency license info. Aligns with the corrected `AUTHORS.md`.

## v1.13.0 - 2026-09-05
