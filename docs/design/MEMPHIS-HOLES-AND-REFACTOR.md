# Memphis — the holes, measured, and the refactor that closes them

**Status:** design, measured 2026-11-03 on this host.
**Predecessors:** `docs/design/DREAMING.md` (the mechanism),
`docs/design/DREAMING-GAPS-AND-REFACTOR.md` (the Dreaming tier's own gaps),
#733–#739 (D1–D2, R1, R2).

---

## 0. Why this document exists

The Dreaming refactor (`DREAMING-GAPS-AND-REFACTOR.md`) closed the holes **in
one mechanism**: one classifier for failure, one proposal chain, one command
that fills it. It measured them and it shipped them.

The runtime around that mechanism has the same kind of holes, and they are
bigger. This document measures those, and designs the refactor that closes them
— including the part of the Dreaming plan that is still open (R3, R4, R5).

Three things this document is not:

- **It is not a wish list.** Every number below was measured on this host on
  2026-11-03. §7 carries the commands, so every number can be re-derived and
  argued with.
- **It is not another layer of guards.** §2 shows why the last eleven
  postmortems did not stop the recurrence: every fix added a guard at a door,
  and the next writer found another door. The plan below closes doors by making
  one door the only door.
- **It is not scoped to Dreaming.** The user's brief was "completely". The
  Dreaming remainder is S6; everything before it is the runtime that carries it.

The single most important claim in this document is measurable, and it is
measured first, because everything else depends on it:

> **The failure mode that repeats in this repo is a new writer that does not
> go through an existing boundary.** Five independent instances, measured below.
> The boundary exists. It is just not the only way in.

---

## 1. The inventory, measured

Nine holes. Each one carries the measurement that proves it and the cost it
has already paid.

### H1 · Two definitions of a valid chain block

`memphis chain verify` and the native Rust core do not agree on what a valid
block is, and only one of them is the one that writes.

Measured today:

```
$ memphis chain verify
[chain-adapter] skipping 1 non-allowlisted chain dir(s) under /home/memphis/.memphis/chains: _quarantine.
ok: true
chainsChecked: 11
blockCount: 22618
```

The native core, asked about the same blocks:

```
$ node -e "require('./crates/memphis-napi/index.node').chain_validate(blockJson, null)"
journal              -> {"ok":true,"data":{"errors":["hash mismatch"],"valid":false},"error":null}
decision             -> {"ok":true,"data":{"errors":["hash mismatch"],"valid":false},"error":null}
system_event         -> {"ok":true,"data":{"errors":["hash mismatch"],"valid":false},"error":null}
proposal             -> {"ok":false,"data":null,"error":"invalid_block_json: unknown variant `proposal`"}
autonom_publication  -> {"ok":false,"data":null,"error":"invalid_block_json: unknown variant `autonom_publication`"}
autonom_archive      -> {"ok":false,"data":null,"error":"invalid_block_json: unknown variant `autonom_archive`"}
```

And the block that makes the two disagree is on disk, not hypothetical:

```
$ python3 -c "import json;print(json.load(open('/home/memphis/.memphis/chains/autonom_archive/000001.json'))['data']['type'])"
autonom_publication
```

So: the `autonom_archive` chain holds one block whose type the Rust core
cannot deserialize at all, and `memphis chain verify` reports the whole system
as `ok: true`. `BlockType` (`crates/memphis-core/src/block.rs:5`) is a **closed
serde enum** — the variant list is `journal`, `ask`, `decision`, `system`,
`system_event`, `insight`, `tool_call`, `tool_result`, `error`, `case`, and the
wallet transaction types, plus read-side aliases for legacy names.

**Correction, 2026-11-03, found by the S0 audit: it is two blocks, not one.**
Validating **every** live block against the native core (23 388 blocks) finds a
second one the verifier never reported:

| chain                          | block    | the core says                                         |
| ------------------------------ | -------- | ----------------------------------------------------- |
| `autonom_archive`              | `000001` | `unknown variant 'autonom_publication'`               |
| `journal.backup-1784913076785` | `000210` | `missing field 'type'` — the block has no type at all |

The second one is a different defect wearing the same symptom: not an unknown
type, but a block written **without** the required field. It sits in a backup
snapshot, which is exactly where nobody looks — and it is in the allowlist, so
the verifier _promises_ to scan it (see H2).

**Cost.** `chain_append` parses the whole chain before appending — and the
parse of that one block fails. Measured today, against the live chain's shape,
without writing anything:

```
$ node -e "…chain_append(<the chain as a JSON array>, <a new system_event block>)"
append into the live chain shape -> {"ok":false,"data":null,"error":"invalid_chain_json: unknown variant `autonom_publication`, expected one of `journal`, …"}
append into an empty chain        -> {"ok":true,"data":{"appended":false,"errors":["hash mismatch"]},"error":null}
```

The chain is readable by the tool that reports on it and **unwritable by the
core that writes it**. The second line is the control: the same new block
appends cleanly into an empty chain, so the failure is the chain's history, not
the block.

### H2 · The chain registry lives in four places, and one of them wins silently

| registry                                           | count | what it holds                                                       |
| -------------------------------------------------- | ----- | ------------------------------------------------------------------- |
| `src/memory/chain-catalog.ts` (the taxonomy)       | 13    | `proactive` and `messages` have no directory and no allowlist entry |
| `src/infra/storage/chain-adapter.ts:118` (code)    | 14    | 11 active + 3 frozen backup snapshots                               |
| `.env:63` `MEMPHIS_CHAINS_ALLOWLIST` (live config) | 14    | **replaces** the code default (`chain-adapter.ts:138`)              |
| `/home/memphis/.memphis/chains/` (disk)            | 14    | 11 active + 3 backup snapshots, plus `_quarantine`                  |

Four lists, no gate that compares them. The gap is not cosmetic: two names in
the taxonomy (`proactive`, `messages`) exist in no other list.

**And the allowlist promises chains the scanner cannot reach.** The code's
allowlist holds **14** entries — 11 active chains and 3 frozen backup
snapshots, with the comment "these are valid chain blocks too". But
`verifyChainIntegrity` filters directories through `SAFE_CHAIN_NAME`
(`/^[A-Za-z0-9_-]{1,64}$/`), and a backup snapshot's name contains a dot
(`journal.backup-1784913076785`). The dot fails the pattern, so:

| what                                        | count  |
| ------------------------------------------- | ------ |
| entries in the allowlist                    | 14     |
| chains the verifier actually opens          | **11** |
| allowlisted chains the name pattern rejects | 3      |

The three unreachable ones are exactly the frozen backup snapshots — and one of
them (`journal.backup-1784913076785`) holds the second unreadable block from
H1. So the list says "these are valid chain blocks too", the verifier cannot
open them, and one of them is not valid. Measured by the S0 audit, which reads
the allowlist, the disk and the name pattern as three separate facts.

**The silent part is the expensive part.** The live config overrides the code
default, and the override is a git-ignored file that only the operator edits.
A chain added to the code is therefore invisible to the live scanner until
somebody also edits `.env` — with no warning, because the scanner _prints_ the
skip and still returns success:

```
[chain-adapter] skipping 1 non-allowlisted chain dir(s) under /home/memphis/.memphis/chains: _quarantine.
ok: true
```

This is not hypothetical. R2 added the `proposals` chain and needed exactly one
operator edit in `.env` to make the scanner see it. Had that line been
forgotten, `memphis chain verify` would have reported `ok: true` over 10
chains while quietly ignoring the new one.

**Correction, 2026-11-04, found while building S1: the name pattern was in five
places, and they did not all say the same thing.**

| file                                         | what it decided                          |
| -------------------------------------------- | ---------------------------------------- |
| `src/infra/storage/chain-adapter.ts`         | the verifier's filter                    |
| `src/infra/storage/chain-rotation.ts`        | which directories the rotation may touch |
| `src/infra/storage/chain-archive-restore.ts` | which archives may be restored           |
| `src/infra/storage/migrations/runner.ts`     | which chains a migration may rewrite     |
| `src/infra/http/routes/memory.ts`            | what the HTTP surface may address        |

Five copies of the rule that decides what Memphis is willing to open. The
copies were identical — until S1 had to change one of them (the verifier's,
to let an archive through), which is the only way to find out how many
places the rule really lived in. The pattern now lives in
`src/memory/chain-catalog.ts`, the module that owns the answer to "what is
a chain", and the other four import it.

**Correction, 2026-11-04: the operator's answer to "which chains may be
scanned" is narrower than "whatever the config says".** The live config
**replaced** the code default; it may now only narrow it. A name the
registry does not know is not added to the scan by the config — the config
asks for a chain that is not there, and the audit says so.

### H3 · The SLO reports "passing" on four metrics that have no data

```
$ memphis slo status --days 7
SLO status: passing
window: 7d (2026-10-27T19:08:35.995Z - 2026-11-03T19:08:35.995Z)
samples: 1408; span files: 7
  - p99_turn_latency_ms: unavailable; value=n/a; threshold=90000 ms; samples=0 (no turn.dispatch spans with latency in window - last turn.dispatch span 28h ago)
  - confabulation_rate: unavailable; value=n/a; threshold=0.001 ratio; samples=0 (no turn.dispatch spans in window - last turn.dispatch span 28h ago)
  - provider_error_rate: unavailable; value=n/a; threshold=0.01 ratio; samples=0 (no provider.completion spans in window - last provider.completion span 28h ago)
  - tool_error_rate: unavailable; value=n/a; threshold=0.05 ratio; samples=0 (no tool.call spans in window - last tool.call span 28h ago)
```

**Every** metric is `unavailable` — zero samples each, the last span 28 hours
old — and the verdict is `passing`.

The cause is one line (`src/mcp/tools/slo-status.ts:32`):

```ts
allSlosPassing: failingSlos.length === 0,
```

`unavailable` is a third status (`src/observability/slo-evaluator.ts:7`) and is
neither `pass` nor `fail`, so a metric with no data cannot fail, and an empty
window passes. The same false green is printed by the scheduler
(`src/infra/runtime/scheduler-builtins.ts:238`): `SLO 7d: OK`.

### H4 · `memphis health` says "status: ok" while a check inside it says "fail"

```
$ memphis health
status: ok
service: memphis
version: 1.13.5
nodeEnv: development
runtimeStatus: healthy
repairable: false
recommendedAction: none
checks: {
  ...
  "embed_index_dimension": {
    "status": "fail",
    "message": "dim mismatch: config=768 index=32",
    "fixAction": "RUST_EMBED_DIM=768 but /home/memphis/.memphis/embed/index-v1.json holds dim=32. Queries embed to a different width than the stored vectors, so cosine similarity scores 0 and recall matches nothing meaningful. ..."
  }
```

The check is correct, detailed, and has a fix action. It is also **invisible
in the verdict**, because the top line is computed from two checks
(`src/infra/http/health.ts:456`):

```ts
const requiredHealthy = checks.database.status === 'ok' && checks.data_dir.status === 'ok';
```

Every other check — including this one — is informational. The measured state
is: queries embed to 768 dimensions, the index holds 32-dimensional vectors,
and recall matches nothing meaningful. The host reports itself as healthy.

### H5 · The deployed artifact is not the repository

The operator's `memphis` is a link into the repo, and the repo's build output
is behind `main`.

```
$ ls -la /home/memphis/.local/share/npm-global/lib/node_modules/@memphis-chains/
memphis -> ../../../../../../memphis

$ ls -la dist/ | head -2
drwxr-xr-x 28 memphis memphis  4096 Oct 29 13:25 .
$ find dist -type f -printf '%T+\n' | sort | tail -1
2026-11-02+00:46:28
```

So: `dist/` files were last written **2026-11-02 00:46:28**, and the service
has been up since **00:46:31** with `NRestarts=0` — it has never restarted
since. Measured against the build timestamp:

| what                                        | count  |
| ------------------------------------------- | ------ |
| commits on `main` since the build           | **11** |
| `src/` files changed since the build        | **17** |
| new `src/` files since the build            | **10** |
| tracked files changed since the build (all) | 35     |

The runtime the operator talks to is the runtime from before R1, R2 and the
proposals chain existed. It shows:

```
$ memphis dream list     → Unknown command: dream
```

**Correction, 2026-11-03, from the S0 audit: one command, not three.** The
first draft of this section also listed `memphis journal append` and
`memphis recall` as missing commands. They are not: **`journal` and `recall`
were never CLI verbs in this repository** — the journal is written through the
`memphis_journal` MCP tool, and recall is a route, not a command. Comparing the
source registry with the built one gives the truth:

```
$ node -e "…CLI_COMMAND_REGISTRY…"      # source: 39 commands
$ node -e "…dist/…/registry.js…"        # build:  38 commands
missing from the build: dream
```

One command, and it is the one R2 shipped three days ago. The audit measures
this as a **difference between two lists**, not as a timestamp, because a
timestamp says "old" while a list says "missing what, exactly".

Two aggravating details:

- **The live unit never builds.** `/home/memphis/.config/systemd/user/memphis.service`
  is `ExecStart=/usr/bin/node /home/memphis/memphis/dist/infra/cli/index.js serve`
  with **no build step**. The repo's `ops/memphis.service` — a _different unit_
  (`WorkingDirectory=/opt/memphis`, `ExecStart=/usr/bin/node dist/index.js`,
  `NODE_ENV=production`, `ExecStartPre=/usr/bin/npm run build:rust`) — is not
  the unit that runs, and no gate compares them.
- **Nothing measures the drift.** No script and no workflow checks whether
  `dist/` matches `main`. The only mentions of staleness in the repo are
  `scripts/pre-demo-smoke.sh` (`'--skip-build set; dist/ may be stale'`) — a
  warning on a demo script.

**Correction, 2026-11-04, found by the audit measuring the very drift it was
built to catch: the freshness window was read in the wrong timezone.**

The S0 check compares the newest built file with the commits on `main`, so it
needs a timestamp. It built one by cutting the zone off a UTC ISO string:
`2026-11-04T10:39:01.352Z` → `2026-11-04 10:39:01`. But `git rev-list --since`
parses a **naive** timestamp in the **local** zone, so the window was read one
offset off — on this host (CET, UTC+1), an hour into the past.

Measured on this host, right after the S1 merge:

| what                                                    | count |
| ------------------------------------------------------- | ----- |
| commits on `main` newer than the build (the truth)      | **0** |
| what the audit reported                                 | **1** |

The commit it counted was the S1 merge itself — **61 seconds older than the
build**. The check that exists to catch a stale deployment was reporting a
stale deployment that was not there: the mirror image of the false green it was
built to replace, and worse for the operator, because a false red on the
operator's own repair is a repair that never happens.

The stamp now carries its zone, and a test pins it. A temporary repository
with one commit dated a minute before the build and a `dist/` dated a minute
after it, measured in CET, must report **0**; the mirror case — the commit
after the build — must report **1**. The first case fails against the old
code with the exact symptom above.

### H6 · A writer that pushes to `main` without checking what branch it is on

`crons/tuesday-code.sh:152-155`:

```bash
cd "$REPO" && git add -A docs/roadmap/current-priorities.md 2>/dev/null
if ! git diff --cached --quiet 2>/dev/null; then
  git commit -q -m "chore(priorities): auto-generowana lista na wtorek $(date -I)" 2>/dev/null
  git push -q origin HEAD:refs/heads/main 2>&1 | tail -1
fi
```

`git push origin HEAD:refs/heads/main` pushes **whatever HEAD is** to `main`.
On a feature branch, that is a push of that branch's commits into `main`.

It is not supposed to be possible, and it was caught — but by luck and by
GitHub, not by this project. Measured on 2026-11-03: the cron committed
`c06adfca` on a feature branch and tried to push `9a34adc5` to `main`; the
push was rejected (journalctl, 13:13:31, "failed to push some refs").

What protects `main` today:

```
$ gh api repos/Memphis-Chains/memphis/rulesets/14186283 --jq '.rules[].type'
deletion
non_fast_forward
required_status_checks

$ gh api repos/Memphis-Chains/memphis/branches/main/protection
{"message":"Branch not protected"}   (HTTP 404)
```

The ruleset requires four status checks and forbids deletions and force-pushes.
**It has no "required pull request" rule**, and classic branch protection is
not enabled at all.

**Correction, 2026-11-03, measured on my own push.** The paragraph above
first draft said "a direct push to `main` is structurally allowed; only the
required checks stand in the way". The second half is stronger than that: the
ruleset sets `strict_required_status_checks_policy: true`, and the strict
policy requires the commit to have **passed** the required checks before it may
be pushed. Measured by trying it — a one-line documentation commit, pushed
straight to `main`:

```
$ git push origin main
 ! [remote rejected]       main -> main (push declined due to repository rule violations)
error: failed to push some refs to 'https://github.com/Memphis-Chains/memphis.git'
```

So the strict policy blocks **every** direct push that carries a commit the
checks have never seen — which is every direct push that carries anything at
all. The 2026-11-03 13:13 rejection was this rule, not luck: the cron pushed a
commit that had never been through CI.

**What that changes.** The cron's push does not "land code on `main`" — it
cannot. What it does is **fail quietly**: the push's stderr is piped through
`| tail -1`, so the rejection is one line in a log nobody reads, and the
operator's weekly priority list silently stops being updated. The hole is not
"the boundary is missing"; the boundary holds. The hole is that the writer
tries, fails, and pretends otherwise.

**And the asymmetry that makes the repo work.** A pull request merged through
GitHub's API is _not_ a push, so the strict policy does not apply to it — that
is why the automerge workflow lands merges while direct pushes are refused.
The repository's real entry point is the pull request; the cron is written as
if it were a second one.

### H7 · Six gates measure the wrong thing, and a seventh does not exist

| #   | gate                                                                            | what it actually measures                            | measured evidence                                                                                                                                                                          |
| --- | ------------------------------------------------------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | `.github/workflows/chain-invariant.yml`                                         | the **fixture** in `tests/fixtures/chain-invariant/` | the workflow runs `tests/integration/chain-invariant.test.ts`; the live sweep exists only as a local systemd timer (`memphis-chain-integrity-sweep.timer`, `enabled`, last fired 20:03:42) |
| 2   | `scripts/check-systemd-units.mts:48` (`UNIT_DIR = scripts/systemd`)             | **13** unit files in one directory                   | `ops/memphis.service` and the live user unit are outside it. CI does run it (`ci.yml:126`) — the scope is the hole, not the invocation                                                     |
| 3   | `cargo audit` (`scripts/rust-core-safety-check.sh`, npm `ops:rust-core:safety`) | nothing — no workflow invokes it                     | grep over `.github/workflows/` → no reference                                                                                                                                              |
| 4   | `.github/workflows/backup-restore-drill.yml`                                    | an `echo`                                            | `workflow_dispatch` only; its one job is `disabled-in-public-repo` and prints a notice                                                                                                     |
| 5   | `scripts/pii-scan.sh:99`                                                        | the working tree only                                | it scans `git ls-files` — never history                                                                                                                                                    |
| 6   | `scripts/default-secret-scan.sh:126`                                            | source, not tests                                    | `tests/*` and every `*.test.*` are skipped (a deliberate, documented exemption)                                                                                                            |
| 7   | _no freshness gate exists_                                                      | —                                                    | §H5: `dist/` is 11 commits behind and nothing notices                                                                                                                                      |

Each of these can be green while the class of failure it names is live on this
host. Gate 1 is the sharpest example: the chain invariant passes on a fixture
of three directories and seven blocks while the live chain contains a block
type the core cannot read (H1).

### H8 · The postmortem corpus cannot answer "what is still open?"

There are **11** postmortems in `docs/postmortems/`. The index lists **3** of
them and is dated `2026-09-26`:

| file                                            | date       | severity | status             |
| ----------------------------------------------- | ---------- | -------- | ------------------ |
| `2026-09-22-chains-halt-invalid-block-shape.md` | 2026-09-22 | HIGH     | Resolved (PR #385) |
| `2026-09-21-soul-append-and-deep-restart.md`    | 2026-09-21 | MEDIUM   | Resolved           |
| `2026-05-08-zawoja-and-runtime-state.md`        | 2026-05-08 | LOW      | Resolved           |

The status of the other eight documents is prose. Measured across all eleven
files: the whole corpus contains **1** `DONE` marker and **1** `TODO` marker;
statuses are written as sentences ("Resolved", "Open", "fixed", "open"). There
is no field, no front-matter, no table that a tool can read.

**Cost.** The inventory in this section was assembled by reading eleven
documents by hand, and it cannot be re-derived automatically. A plan whose
evidence cannot be re-derived will rot exactly the way that index did — which
is why S0 below is an audit of the _live system_, not of a document.

### H9 · The Dreaming tier is still open where it matters most

From `DREAMING-GAPS-AND-REFACTOR.md` §3, restated against the code as it
stands after R2:

| stage | state                                                                                                                                                   |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1    | **done** — one shared failure classifier (`src/core/failure-classification.ts`)                                                                         |
| R2    | **done** — the `proposals` chain, the lifecycle, `memphis dream list/show/propose`                                                                      |
| R3    | **does not exist** — no accept, no reject, no apply, no rollback                                                                                        |
| R4    | **half** — the provenance field exists and is always empty: `basedOn: { sessionIds, chainBlockHashes: [] }` (`src/cognitive/dreaming/proposals.ts:388`) |
| R5    | **does not exist** — no scope policy; any agent-initiated write may target any chain, including `system`                                                |

Twenty-one proposals sit in the `proposals` chain, all `pending` — plus one
retired test record, `superseded`, because a chain is append-only and a
retirement is a new block rather than an edit. Measured: `memphis dream list`
prints 21 `[pending]` and 1 `[superseded]`.

The mechanism can find a problem, write it down with evidence, and then
nothing can happen next. R3 is the stage that makes the whole tier mean
anything; it is also the stage that needs the operator's passphrase, so it
cannot be automated away.

---

## 2. The diagnosis: why the same shape keeps coming back

Five measured instances of one shape:

| #   | the writer                         | the boundary it bypassed              | measured cost                                                  |
| --- | ---------------------------------- | ------------------------------------- | -------------------------------------------------------------- |
| 1   | the `autonom_archive` chain writer | the Rust core's block-type vocabulary | a chain the writer can read and the core cannot (H1)           |
| 2   | the `proposals` registration       | the live scanner's allowlist          | one silent operator edit in `.env` (H2)                        |
| 3   | `crons/tuesday-code.sh`            | the branch / pull-request boundary    | a push of `HEAD` to `main` (H6)                                |
| 4   | the deployment path                | the build                             | `dist/` 11 commits behind, the CLI missing three commands (H5) |
| 5   | the postmortem index               | the corpus it indexes                 | 8 of 11 documents unindexed since 2026-09-26 (H8)              |

In every case the boundary exists, is documented, and is enforced _somewhere_.
The writer simply does not go through it.

The corpus says how the repo has responded to this so far. Measured vocabulary
across the eleven postmortems: **12** mentions of "guard", **6** of
"allowlist", **7** of "refactor"/"restructure". The dominant shape of a fix in
this repo is a guard — a check at one door — rather than a change to the shape
of the system that made the door reachable.

That is why H1–H9 will come back if they are answered one by one with more
guards. Six more guards is six more doors.

**Two conclusions, and the plan is built on them.**

1. **One entry point that measures the live system.** Not a fixture, not a
   copy, not a document — the live state, with the four-state verdict R1
   already established (`success` / `failure` / `inconclusive` / `unknown`).
   Every gate that measures the wrong thing becomes a check inside it, and
   every existing gate keeps its own entry point but delegates to the audit, so
   no logic is orphaned and no two gates can disagree.
2. **Boundaries that cannot be bypassed.** The registry is one list, not four.
   The block vocabulary is one file, consumed by both implementations. The
   deployment artifact is produced by the path that runs it. The branch
   boundary is enforced by the branch, not by a script that hopes to notice.

The anti-hubris constraint follows: each stage below must be falsifiable on
this host, with a command and an expected output. A stage that cannot be
falsified does not ship.

---

## 3. The plan

Seven stages. Each is independently mergeable, each carries its own
falsifier, and none lands before the thing it depends on.

| stage  | delivers                                                                                                                                  | closes                                                            | falsifier (summary)                                                                                                                                                                                                     |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **S0** | **one audit entry point** — `npm run -s ops:audit` measures the live system and returns a verdict per check                               | **none yet** — it _measures_ H1–H4 and H6–H8; they close in S1–S6 | on this host the audit names every hole in §1 with the numbers in §1, and exits non-zero while any is open                                                                                                              |
| **S1** | **one registry, one vocabulary** — the registry is derived from the taxonomy and the disk; the native core owns the block-type vocabulary | H1, H2                                                            | after the repair the audit says `block-vocabulary` SUCCESS and `chain-registry` SUCCESS; a chain added to the catalog is reported until the config names it                                                             |
| **S2** | **truth in the status surfaces** — `unavailable` is not `pass`; a failing check can flip the top line                                     | H3, H4                                                            | with today's state, `memphis slo status` stops saying "passing" and `memphis health` stops saying "status: ok"; after the embed dim is fixed, health says ok again                                                      |
| **S3** | **the deployed artifact is the repository** — a freshness gate, one build path, one unit                                                  | H5                                                                | `memphis dream list` works in the operator's shell; the freshness check is green; the check fails when `dist/` is one commit behind                                                                                     |
| **S4** | **writer boundaries** — the cron cannot push to `main`; the branch boundary is enforced by the branch                                     | H6                                                                | a mutation test: a cron run on a feature branch cannot push to `main`; the ruleset rejects a direct push                                                                                                                |
| **S5** | **the scanners see what matters** — history-inclusive scans, tests/ not exempt, `cargo audit` on a workflow, a drill that drills          | H7, H8                                                            | a secret committed in a test file in history is found; `cargo audit` runs; the drill workflow performs a round trip                                                                                                     |
| **S6** | **the Dreaming remainder** — R3 (the gate), R4 (real provenance), R5 (scopes)                                                             | H9, G4–G6                                                         | end-to-end on this runtime: a proposal is accepted on tier 2, applied carrying `basedOn` with real block hashes, rolled back; an agent write to an operator-only scope is refused and the refusal is in the audit chain |

### 3.1 S0 · One audit entry point

This is the core of the plan. Everything else is either a thing the audit
measures or a thing the audit makes impossible to get wrong.

```bash
npm run -s ops:audit          # or: memphis audit-runtime
```

**The command is `audit-runtime`, not `audit`.** `memphis audit` already
exists and is the governance chain's search (`audit search --since …`). Two
commands must not answer to one word — and the confusion between "search the
audit chain" and "measure the runtime" is exactly what this plan removes.

It reads the **live** system — the live chains, the live `.env`, the live
`dist/`, the live repository, the live workflows — and prints one line per
check in the four-state vocabulary R1 already shipped.

**As built, on this host, 2026-11-03:**

```
$ npm run -s ops:audit
chain-registry        FAILURE  catalog=13 allowlist=14 disk=15 drift=proactive,messages
                      in the taxonomy only: proactive, messages
                      on disk but never scanned: _quarantine
                      in the allowlist but unreachable by the scanner (the name is not safe):
                        cases.backup-2026-07-07T15-07-23-108Z, journal.backup-1784913076785,
                        system.backup-1782897312539
block-vocabulary      FAILURE  2 of 23388 live blocks cannot be parsed by the core
                      autonom_archive/000001.json: type=autonom_publication invalid_block_json: unknown variant `autonom_publication` …
                      journal.backup-1784913076785/000210.json: invalid_block_json: missing field `type` …
slo-reporting         FAILURE  4 of 4 metrics unavailable; verdict=passing
health-reporting      FAILURE  1 failing check(s); top-line=healthy
                      checks.embed_index_dimension=fail
deployment-freshness  FAILURE  dist is 13 commit(s) behind main; 2 cli command(s) missing
                      newest built file: 2026-11-01T23:46:28.476Z
                      main head: 91049d2ee369e62b7e4847ae5b4c0bc3da38e222
                      missing from the build: dream, audit-runtime
branch-boundary       FAILURE  1 script(s) push HEAD to a protected branch
                      crons/tuesday-code.sh:155 pushes main
gate-coverage         FAILURE  6 gate(s) measure a scope that cannot fail on this host
                      chain-invariant: scans the committed fixture, never the live chains
                      check-systemd-units: reads scripts/systemd/ only; never checks ops/memphis.service
                      cargo audit: the script exists, no workflow invokes it
                      backup-restore-drill: the workflow prints a notice instead of drilling
                      pii-scan: scans the working tree only, never the history
                      default-secret-scan: exempts tests/ and every *.test.* by path
postmortem-status     FAILURE  indexed=3/11 machine-readable status=0/11
overall: FAILURE (8 open, 0 inconclusive, 0 unknown)
```

Exit code **1** when a check failed, **2** when nothing failed but something
could not be measured, **0** when everything measured and was right. `--json`
prints the same report as JSON on stdout (the config loader writes to stderr,
so the JSON stays parseable).

**The four states are not decoration.** `unknown` is a state the repo already
uses in `src/core/failure-classification.ts`, and it is the honest answer for
"the check could not reach the live system" — which is exactly what every
mis-scoped gate does today. A gate that cannot see the live system must say
`unknown`, never `success`.

**Which gates delegate, and which do not.** The audit owns the eight opinions
it measures. A gate that overlaps one of them must call the audit rather than
keep its own copy — two gates that disagree is H1's shape. The gates that do
**not** overlap (the Dreaming falsifiers, the PII and secret scans) keep their
own logic; the audit _reports on their scope_ (`gate-coverage`) instead of
re-implementing them.

**What S0 deliberately does NOT do.** The live chain sweep
(`scripts/chain-integrity-sweep.mjs`) keeps its own oracle for now, and that
oracle is the weakest of the three in this repository: it accepts a block if
the file parses as JSON and carries `index` and `hash`. It never asks the core,
so the sweep reports `ok: true` over 66 blocks while two of them cannot be
deserialized at all — measured today, side by side: the sweep says ok, the
audit says two failures. Rewiring it means changing the sweep's fixtures (they
are deliberately minimal) and the order of the CI steps that build the bridge
— both of which belong to **S1**, the stage that owns the vocabulary. The
audit covers the same ground today, on demand, with the core as the oracle.

**Falsifier, as run:** on this host, `npm run -s ops:audit` prints the eight
failures above with the numbers in §1 and exits 1. The part that matters is the
second half — **the audit's verdict moves when the system moves**:

| the system                                | the audit says                                         |
| ----------------------------------------- | ------------------------------------------------------ |
| this host, live                           | 8 failures, 0 unknown                                  |
| an isolated home with no chains, no repo  | 2 unknown, 1 failure (the empty SLO window), 5 unknown |
| a chain whose block the core cannot parse | `block-vocabulary` FAILURE, naming the block           |
| the same chain with a readable block      | `block-vocabulary` SUCCESS                             |
| the native core not loadable              | `block-vocabulary` UNKNOWN, never SUCCESS              |
| 0 live blocks to check                    | `block-vocabulary` UNKNOWN, never SUCCESS              |

The last three rows are unit tests (`tests/unit/runtime-audit.test.ts`), and
they are the point of the whole stage: a check that cannot change its answer
is not a check.

**What was built**

| file                                              | what it does                                                                                                           |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `src/infra/audit/types.ts`                        | the four-state verdict, borrowed from `src/core/failure-classification.ts` — one vocabulary, not a second one          |
| `src/infra/audit/checks.ts`                       | the eight checks, each a **pure** function over measured numbers; the verdict is computed here and nowhere else        |
| `src/infra/audit/runtime-audit.ts`                | the collector: reads the live chains, `.env`, `dist/`, the repository, the workflows and the postmortems; never writes |
| `src/infra/cli/commands/audit-runtime.ts`         | `memphis audit-runtime`                                                                                                |
| `src/infra/cli/handlers/audit-runtime.handler.ts` | the handler                                                                                                            |
| `scripts/audit-runtime.mts`                       | `npm run -s ops:audit`, with `--json`                                                                                  |
| `tests/unit/runtime-audit.test.ts`                | 35 cases, including the mutation property                                                                              |

Two small exports were added so the audit does not keep its own copy:
`getChainAllowlist` and `SAFE_CHAIN_NAME` from `src/infra/storage/chain-adapter.ts`.

**The oracle is the core.** The vocabulary check does not keep a list of legal
block types — it asks the native core to parse every live block, because a
second list in TypeScript is the very drift H1 is about. The audit's own
counts came from the same call the writer uses.

### 3.2 S1 · One registry, one vocabulary

**The operator's answer, 2026-11-04** (questionnaire `ask_f9aac26ffd9c21028bc880c9`):

| question                              | answer                                                                                                                          |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| may the runtime write to `crates/**`? | **no** — "memphis ma być autonomiczny, bez mcode". The core is not edited; the DATA is brought into the shape the core accepts. |
| may a chain be removed?               | **no** — "łańcuchy zostają". `proactive` stays, as the place where the runtime proposes how it could improve itself.            |
| may a backup be unreadable?           | **no** — "backupy powinny być czytelne jak nie są to jest zwykły bug".                                                          |

**This changes the design of this stage.** The sketch below (written before
the answer) proposed one JSON Schema file generated into both the Rust enum
and the TypeScript union. That is impossible under the first answer: it
writes to `crates/**`. The design that replaces it is better anyway — the
core cannot enumerate its own variants, but it can answer the only question
that matters: **is this type legal?** So the core stays the single owner of
the vocabulary, and the TypeScript side asks it instead of keeping a list.

#### What the vocabulary actually is, measured

The core's enum (`crates/memphis-core/src/block.rs:5`) is closed: 16 variants
plus 14 read-side aliases, 30 legal type strings in all. The core names them
itself, in its own error message:

```
invalid_block_json: unknown variant `autonom_publication`, expected one of
`journal`, `ask`, `decision`, `system`, `boot`, `categorize_report`,
`chain.repair`, `config`, `consent.annotation`, `health_state_change`,
`memory.action`, `memory.burn`, `mode_change`, `model-d-proposal`,
`reflection_report`, `scheduler_task`, `security_event`, `system_event`,
`unknown`, `insight`, `tool_call`, `tool_result`, `error`, `case`,
`wallet_tx_requested`, `wallet_tx_signed`, `wallet_tx_broadcast`,
`wallet_tx_confirmed`, `wallet_tx_failed`
```

The live disk, measured the same day — every block, its type and its kind:

| `(type, kind)`                  | count  | legal?                        |
| ------------------------------- | ------ | ----------------------------- |
| `system_event`/`scheduler_task` | 10 404 | yes                           |
| `insight`/`pattern`             | 5 279  | yes                           |
| `case`                          | 2 137  | yes                           |
| `tool_call`                     | 1 811  | yes                           |
| `journal`                       | 1 149  | yes                           |
| `decision`                      | 487    | yes                           |
| `system_event` (no kind)        | 376    | yes                           |
| `insight` (no kind)             | 368    | yes                           |
| `insight`/`reflection`          | 366    | yes                           |
| `system_event`/`memory.action`  | 349    | yes                           |
| … 14 more pairs                 | —      | yes                           |
| **`autonom_publication`**       | **1**  | **no — unknown variant**      |
| **no type at all**              | **1**  | **no — missing field `type`** |

So the drift is exactly **two blocks out of 23 391** — the two the S0 audit
already named. Every other type on disk is a variant or a documented alias.
The core is not behind the data; the CATALOG is behind the core (it declared
three names the core does not know: `autonom_publication`,
`mp_v0.envelope_sent`, `mp_v0.envelope_received`).

#### What was built

| file                                           | what it does                                                                                                                           |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `src/infra/storage/block-vocabulary.ts`        | the oracle: asks the core whether a type is legal, and what it says about a whole block. Cached per type. No list of types lives here. |
| `src/infra/runtime/chain-canonical.ts`         | the canonical block shape, in ONE place: the hash projection, the type inference, the normalisation, and the targeted rewrite          |
| `src/infra/runtime/chain-vocabulary-repair.ts` | the scan, the backup, the rewrite, the verification — in that order                                                                    |
| `src/memory/chain-catalog.ts`                  | the registry: `availability` on every chain, `SAFE_CHAIN_NAME` (one copy), the archive rules                                           |
| `src/infra/storage/chain-adapter.ts`           | the registry derived from the taxonomy and the disk; the config may only narrow it; the verifier opens archives                        |

**The registry is derived, not maintained.** `deriveChainRegistry()` answers
one question — _which directories under `chains/` hold a chain the taxonomy
names?_ — and everything else follows from it: the allowlist, the verifier's
filter, the audit's facts. A hand-maintained constant was the thing this
stage removes; adding one back would be the hole re-opening.

**The taxonomy is not a promise about the disk.** Chains are created by their
first writer, so a fresh install has fewer directories than the catalog
names, and two entries belong to features that may be off. Every chain now
carries `availability: 'standard' | 'conditional'`, and the audit reports a
conditional chain's absence as INFORMATION, not as drift. Measured: the
audit used to say `drift=proactive,messages` on every single run of a
perfectly healthy host.

**The repair rewrites what the core refuses, and nothing else.** The legacy
rewrite normalized every block it touched — on this host that would mean
rewriting 23 391 blocks to fix two. The vocabulary repair instead:

1. screens every block (the type check is cached, so the scan of 23 528
   blocks over 14 directories takes **964 ms**);
2. rewrites only the blocks the core refuses, into `system_event` with the
   original semantic name in `kind` — the convention from `block.rs:19`;
3. re-links the hash chain from the first rewritten block onward (a block's
   hash covers `prev_hash`, so the cascade is unavoidable; the bytes before
   it stay untouched);
4. verifies by scanning again.

Measured on a copy of the live data: **2 blocks rewritten, 212 blocks
untouched byte for byte**, and the verifier then opened the archive it had
never opened before and checked all 210 of its blocks.

**The repair is reversible and it is gated.** It backs up through the
operator's own mechanism first (`memphis backup restore` is the way back),
and rewriting chain history needs the operator's passphrase — asked once,
interactively, in the terminal, never written to a file.

**One more drift, found while measuring: the two implementations disagreed
about the hash.** The native core falls back `type` → `block_type` →
`journal` when it reduces a block's data for hashing
(`crates/memphis-core/src/hash.rs:46`); the TypeScript side skipped
`block_type` and went straight to `journal`. A block carrying only
`block_type` would have been hashed differently by the two. No such block
exists on this host today (measured), but the disagreement is exactly what
this stage exists to remove, so the TS projection now mirrors the core's.

**And one that is bigger, found by the sweep (S1c): the core and the writer
disagree about the hash of a READ-SIDE ALIAS.** The core deserializes
`data.type` into its enum before hashing it, so a block whose type is an
alias is hashed as the VARIANT (`security_event` → `system_event`). The
TypeScript writer hashed the raw string. Measured on this host:

| measurement                                       | value                                                                                  |
| ------------------------------------------------- | -------------------------------------------------------------------------------------- |
| blocks whose type is a read-side alias            | **47** — 45 in the live `system` chain, 2 in `system.backup-1782897312539`             |
| the core's verdict on them                        | `hash mismatch`                                                                        |
| the TypeScript verifier's verdict on them         | valid — and it checks the whole chain's linkage, so the chain is internally consistent |
| can the core still PARSE the live `system` chain? | **yes** — `chain_append` on the live chain returns `appended: true`                    |
| blocks a history rewrite would have to re-hash    | **12 732** — 12 728 in the live `system` (every block from index 257 to its end) and 4 in the archive |

The last row is the price of the decision, measured rather than estimated: the
first alias block in `system` sits at index **257**, so a rewrite that starts
there re-hashes everything after it. The alias blocks are all
`security_event`; none of them carries a `kind` yet, so the canonical shape
(`system_event` + `kind: security_event`) is still available to them.

So the chain is not corrupt: the two implementations disagree about what
the hash of 47 legacy blocks is. Which one wins is an **operator decision**,
and it is not this stage's: making the two agree means rewriting the hashes
of the live, actively-written `system` chain (12 970 blocks, 45 of them
alias-typed) — a tier-2 history rewrite, and the only one in this plan
that touches the chain the service writes to every minute.

Until that decision is made, the sweep asks the core only the question it
can answer unambiguously — **can you deserialize this block?** — and the
hash verdict stays `verifyChainIntegrity`'s. That is why the sweep's
`oracle` line says which oracle answered: a green line from the structural
oracle must not be mistaken for one from the core.

#### The falsifier, as run

The stage's claim is: _the registry is one list, and the vocabulary is the
core's_. It is falsified if the audit still reports drift it should not, or
if it stops reporting drift it should.

| the system                                   | the audit says                                                                               |
| -------------------------------------------- | -------------------------------------------------------------------------------------------- |
| this host, before the repair                 | `chain-registry` FAILURE (`drift=proactive,messages`), `block-vocabulary` FAILURE (2 blocks) |
| this host, after the repair                  | `chain-registry` SUCCESS, `block-vocabulary` SUCCESS (0 unreadable)                          |
| a chain added to the catalog, no `.env`      | `chain-registry` FAILURE — the config does not name it                                       |
| a config naming a chain the catalog does not | `chain-registry` FAILURE — the config may only narrow                                        |
| a conditional chain (`proactive`) absent     | `chain-registry` SUCCESS, reported as "planned, not installed"                               |
| an archive narrowed out of the config        | `chain-registry` SUCCESS, reported as the operator's choice                                  |

#### S1c · the sweep asks the core too

The hourly sweep (`scripts/chain-integrity-sweep.mjs`) was the weakest of the
three oracles in this repository: it accepted a block if the file parsed as
JSON and carried `index` and `hash`. It never asked the core, so it reported
`ok: true` over blocks the core cannot deserialize at all.

It asks now — and says in its summary which oracle answered
(`oracle: "native-core"` or `oracle: "structural"`), because the structural
fallback exists for a host without a built bridge, and a green line from the
weaker oracle must not be mistaken for the stronger one.

The sweep's fixtures were written by hand with placeholder hashes and a
block type the core does not know (`soul`). They are generated now
(`npm run -s ops:chain-fixture`), with real hashes and real types — the CI
workflow builds the Rust bridge **before** the sweep tests, so the vocabulary
case cannot pass vacuously.

The sweep runs from the repository, on the operator's host, every hour. That
is why the sweep's change lands in its own PR, **after** the repair: the
hourly gate would otherwise go red on the two blocks before anything could
fix them.

### 3.3 S2 · Truth in the status surfaces

**SLO.** `allSlosPassing` becomes three-valued, not two-valued:

| metric state  | what it means                    | verdict contribution                          |
| ------------- | -------------------------------- | --------------------------------------------- |
| `pass`        | samples present, under threshold | counts as passing                             |
| `fail`        | samples present, over threshold  | counts as failing                             |
| `unavailable` | no samples in window             | **does not pass** — reported as `unavailable` |

The policy question — _does an empty window fail the report, or is it a third
verdict?_ — is the operator's, and S2 implements whichever is chosen. The
current behaviour (an empty window passing) is not one of the options.

**Health.** The required-check set becomes a policy list rather than the
hardcoded pair at `src/infra/http/health.ts:456`. `embed_index_dimension`
is a candidate for "required", because the check's own `fixAction` says
queries "match nothing meaningful" — a system that cannot recall is not
healthy. This is again the operator's call: the audit reports which checks are
failing and what the top line says, and the policy decides which failures may
hide below it.

**Falsifier, to run:** with the state measured today (four `unavailable`
metrics, an embed dimension mismatch), `memphis slo status` no longer says
`passing` and `memphis health` no longer says `status: ok`. Then fix the
dimension (one `.env` line) and the health verdict returns to ok — which
proves the signal is real and not a permanently-red gate.

### 3.4 S3 · The deployed artifact is the repository

Three changes, one falsifier:

1. **A freshness gate.** `dist/` records the commit it was built from (a
   build stamp file), and a check compares it with `main`. Drift ≥ 1 commit is
   a failure, not a warning. This is the gate that does not exist today
   (H7 row 7) and the one that would have caught the 11-commit gap in §H5.
2. **One build path.** The live unit builds what it runs, or the deploy is a
   single documented command that the unit depends on. The live unit currently
   has no build step at all — that is why a repo 11 commits ahead is running a
   5-day-old build.
3. **One unit.** `ops/memphis.service` and the live user unit are reconciled
   into one source with an explicit "local override" file, and the audit
   compares them (path, entrypoint, env file, build step). The repo's unit
   says `/opt/memphis` and `NODE_ENV=production`; the live unit says
   `/home/memphis/memphis` and `NODE_ENV=development`. Both are correct for
   their context; the hole is that nothing says they differ.

**Falsifier, to run:** `memphis dream list` prints the 21 pending proposals in
the operator's shell — the command R2 shipped, missing from the installed CLI
today. The freshness check is green. Then commit anything to `main` and the
check goes red, which is what proves it measures.

### 3.5 S4 · Writer boundaries

**Operator decision, 2026-11-03: only the cron is blocked.** The repository's
rules stay as they are — four required status checks, no required review, no
classic branch protection. What changes is the writer that ignores them.

- **The cron stops pushing to `main`.** It commits to a branch
  (`automation/priorities`) and opens a pull request, or it stops committing
  to the repository at all and writes the file somewhere the operator reads.
  What it must not do is push `HEAD` to `refs/heads/main` — that is a
  statement about the branch, and the script does not know which branch it is
  on. **And it must not swallow the failure**: the push's stderr is piped
  through `| tail -1`, so a rejection becomes one line in a log nobody reads,
  and the operator's weekly priority list silently stops being updated.
- **The ruleset does not change.** The strict status-check policy already
  refuses every direct push carrying an unchecked commit — measured, see H6.
  The boundary holds; the writer was the problem.
- **One write path for chains.** Every chain append goes through one function
  that the audit also uses to validate. A writer that does not use it cannot
  produce a block the core cannot read.

**Falsifier, to run:** (a) the cron no longer attempts a push to `main`, and
a run of it leaves the priority list where the operator reads it — proven by
running the script on a branch and asserting that no `refs/heads/main`
refspec appears in the command; (b) the rejection is no longer silent: a
failed push exits non-zero and says why; (c) the audit's `branch-boundary`
check — which today reports `crons/tuesday-code.sh:155 pushes main` — turns
`SUCCESS`.

### 3.6 S5 · The scanners see what matters

- **History-inclusive scanning.** `pii-scan.sh` scans `git ls-files` — the
  working tree. A secret that was committed and later removed is still in the
  history, and it is still reachable by anyone who clones. The scan must walk
  the history (or the audit must scan the history) — the cost is stated in the
  design so it is a decision, not an accident.
- **Tests are not exempt by path.** `default-secret-scan.sh` skips `tests/*`
  and every `*.test.*`. The script documents why (fixtures quote example
  values), and the reasoning is sound — but the exemption is by path, so a
  real secret in a test file is invisible. A positive rule (known fake values
  are allowlisted by value, not by directory) keeps the intent and closes the
  hole.
- **`cargo audit` runs.** `scripts/rust-core-safety-check.sh` runs it and no
  workflow invokes the script. Either a workflow calls it or the audit runs
  it; "exists but is never called" is the third option and it is the current
  one.
- **The drill drills.** `backup-restore-drill.yml` is `workflow_dispatch` plus
  an `echo`. The drill it names — backup → wipe → restore with chain and
  vault state — runs locally by hand, where it cannot run on every change.
  In a public repository the drill can run against a scratch copy, not
  against the live home.

### 3.7 S6 · The Dreaming remainder

S6 is `DREAMING-GAPS-AND-REFACTOR.md`'s R3, R4 and R5, unchanged in content
and repeated here so the plan is complete:

| stage | delivers                                                                          | falsifier                                                                                                                                |
| ----- | --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| R3    | the operator gate: accept / reject / apply / rollback, on tier 2                  | end-to-end on this runtime: a proposal is accepted with the operator's passphrase, applied, and rolled back; the agent cannot accept one |
| R4    | provenance on memory writes — `basedOn` carries real chain block hashes, not `[]` | a memory write made from a session records the session id and the hash of the block it was based on; a write outside any session says so |
| R5    | runtime write policy by scope: `org` / `shared` / `personal` / `session`          | mutation: an agent-initiated write to an operator-only scope is refused, and the refusal lands in the audit chain                        |

**Order.** R4 first among these, because R3's accept writes the decision and
R4 is what makes that decision say what it was based on — a gate that records
no provenance reproduces G6, the gap the Dreaming design names as principle
#1. R5 alongside R3: the scope policy is what decides where an applied
proposal lands, so the two are one mechanism. R3 is tier 2 and needs the
operator's passphrase — it is the one stage that cannot be prepared in
advance and merged without the operator.

**What S6 needs from S0.** The gate in R3 must be visible in the audit: an
agent-initiated accept attempt, a refused scope write, and a rollback must all
land in the audit chain and be visible in `ops:audit`. A gate that cannot be
observed is a guard, and §2 says what guards buy.

### 3.8 Order, and why

| order | stage  | dependency                                                                |
| ----- | ------ | ------------------------------------------------------------------------- |
| 1     | **S0** | nothing — it measures, so it can land first and show the rest of the work |
| 2     | **S1** | S0 (the audit is what reports registry drift)                             |
| 3     | **S2** | S0 (the audit is what proves the verdict changed)                         |
| 4     | **S3** | S0 (the freshness check is an audit check)                                |
| 5     | **S4** | S1 (the branch boundary and the write boundary are the same shape)        |
| 6     | **S5** | S0                                                                        |
| 7     | **S6** | S0 (the gate must be observable), and the operator's tier 2 passphrase    |

S0 first is not a formality. Every later stage's falsifier is "the audit says
something different now" — which only works if the audit exists and is
honest. A plan that started with S6 would add a gate nobody can see.

---

## 4. Risks, and what would kill this

| risk                                                    | mitigation                                                                                                                       |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| the audit becomes its own form of fixture               | it reads the live system by construction, and its falsifier is that its verdict **changes** when the system changes              |
| S0 is a fifth parallel gate instead of a hub            | every existing gate must delegate to it; a gate that keeps its own logic is a gate that can disagree with the audit              |
| the registry collapses to "whatever the config says"    | the catalog is the source; the config may only narrow it, and the narrowing must be reported (H2 is the record of the opposite)  |
| "unavailable" becomes a permanent red                   | the policy is the operator's, and S2's falsifier includes the recovery path: fix the dimension, get ok back                      |
| the operator's CLI breaks on a rebuild                  | S3's freshness gate makes the drift visible before it is experienced; the rebuild is one command, not a ritual                   |
| the ruleset change blocks the operator's own automation | the operator chooses between "required pull request" and "direct pushes allowed, deliberately"; S4's falsifier covers the choice |
| history-inclusive scanning is slow or noisy             | the scan runs in the audit (scheduled), not on every commit; the cost is measured before it is required                          |
| S6 needs a passphrase and therefore waits               | R4 and the scope table are prepared first; the accept action is the only part that needs the operator, and that is by design     |
| the plan is over-built for one host                     | each stage is independently mergeable and independently falsifiable; S0 alone already reports the eight open holes on this host  |

**What would say this plan is bad.**

- If S0's verdict does not change when the system changes, the audit is a
  fixture wearing a hat, and the whole plan collapses into "add more gates".
- If S1 ends with the registry in three places instead of one, the plan has
  reproduced the disease it was written for.
- If S2 produces a permanently-red SLO, the operator learns to ignore the
  report — which is the failure this document opened with.
- If S6's gate cannot be observed in the audit, it is a guard, and the
  eleventh postmortem will be written about it.

---

## 5. What this document does not decide

- **The policy questions S2 raises.** Whether an empty SLO window fails the
  report, and which health checks are allowed to stay below the top line, are
  operator decisions with real consequences in both directions. The document
  names them and implements the current behaviour as the one option that is
  _not_ on the table.
- **The Rust enum's shape — decided, 2026-11-04.** S1 does NOT replace the
  hand-written enum with a generated one. The operator's answer to the S1
  questionnaire forbids writing to `crates/**`, and the question turned out
  not to need an answer anyway: the core cannot enumerate its variants, but it
  can say whether a type is legal, so the core stays the single owner and the
  DATA is brought into the shape it accepts (`system_event` + `kind`). A
  generated schema would have been a second source of truth with a build
  step; this is one question with one owner.
- **Multi-host.** Everything here is measured on one host. A second host
  changes the freshness and registry problems materially, and the plan does
  not pretend to cover it.
- **The LLM tier (D5).** Unchanged from `DREAMING-GAPS-AND-REFACTOR.md` §5: it
  waits for R2 and R3 to be on the runtime and to have produced proposals a
  human accepted.
- **Anything in `crates/**` at all.\*\* Tier 2, and the operator has ruled that
  this plan does not touch it (2026-11-04).

---

## 6. The stages that are already done

For completeness, because a plan that only lists what is open misleads:

| stage  | what it closed                                                                                                                       | shipped in                          |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------- |
| R1     | one shared failure classifier — 308 failures, 126 inconclusive, 0 unknown over 8 437 tool results                                    | #737 (`d7f6b352`)                   |
| R2     | the `proposals` chain, the proposal lifecycle, `memphis dream list/show/propose` — 26 signals → 21 proposals                         | #738, #739 (`7d2d2012`, `7edd0644`) |
| —      | the S2 blind spot: a loop is a call that did not succeed (4 → 7 loops)                                                               | #738 (`7d2d2012`)                   |
| **S0** | **one audit entry point** — `npm run -s ops:audit` measures the live system, one verdict per check                                   | #741 (`f7baece2f3`)                 |
| **S1** | **one registry, one vocabulary** — the registry is derived from the taxonomy and the disk; the native core owns the block vocabulary | #743                                |

**What S0 changed in the measurements of this document.** Two numbers were
wrong before the audit existed, and both were found by it, not by argument:

- H1 is **two** unreadable blocks, not one — the second one is in a backup
  snapshot and has no `type` field at all.
- H5 is **one** missing command, not three — `journal` and `recall` were
  never CLI verbs in this repository.
- H2 gained a fifth fact: the allowlist promises 14 chains and the verifier
  opens 11, because a backup snapshot's name contains a dot.

That is the point of S0 in one paragraph: a measurement that cannot be
re-derived drifts, and the drift is invisible until a tool measures the live
system again.

---

## 7. Measurement appendix

Every number in this document, and the command that produces it. Run from the
repository root (`/home/memphis/memphis`).

**The whole inventory, in one command (S0):**

```bash
npm run -s ops:audit           # the eight checks, one line each
npm run -s ops:audit -- --json # the same, as JSON on stdout
```

**H1 · two definitions of a valid block**

```bash
memphis chain verify
node -e "
const b = require('./crates/memphis-napi/index.node');
const mk = (t) => JSON.stringify({ index:0, timestamp:new Date().toISOString(), chain:'x',
  data:{ type:t, content:'c', tags:[] }, prev_hash:'0'.repeat(64), hash:'0'.repeat(64) });
for (const t of ['journal','system_event','proposal','autonom_publication','autonom_archive'])
  console.log(t, '->', b.chain_validate(mk(t), null));
"
python3 -c "import json;print(json.load(open('/home/memphis/.memphis/chains/autonom_archive/000001.json'))['data']['type'])"
# and the append that fails because of it (no write happens — the call errors out)
node -e "
const fs=require('fs');
const b=require('./crates/memphis-napi/index.node');
const chain=JSON.stringify([JSON.parse(fs.readFileSync('/home/memphis/.memphis/chains/autonom_archive/000001.json','utf8'))]);
const next=JSON.stringify({index:1,timestamp:new Date().toISOString(),chain:'autonom_archive',data:{type:'system_event',content:'probe',tags:[]},prev_hash:'0'.repeat(64),hash:'0'.repeat(64)});
console.log('live chain ->', b.chain_append(chain, next));
console.log('empty chain ->', b.chain_append('[]', next));
"
```

**The read-side aliases, and what a history rewrite would cost**

```bash
node --import tsx -e "
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { deriveChainRegistry } from './src/infra/storage/chain-adapter.js';

const ALIASES = new Set([
  'security_event','boot','health_state_change','memory.action','memory.burn',
  'model-d-proposal','mode_change','consent.annotation','scheduler_task',
  'chain.repair','config','reflection_report','categorize_report',
]);
const chainsDir = '/home/memphis/.memphis/chains';
let total = 0;
for (const dir of deriveChainRegistry()) {
  const chainDir = join(chainsDir, dir);
  if (!existsSync(chainDir)) continue;
  const files = readdirSync(chainDir).filter((f) => /^\\d+\\.json\$/.test(f)).sort();
  const idx = [];
  for (let i = 0; i < files.length; i += 1) {
    let b; try { b = JSON.parse(readFileSync(join(chainDir, files[i]), 'utf8')); } catch { continue; }
    const t = b?.data?.type;
    if (typeof t === 'string' && ALIASES.has(t)) idx.push(i);
  }
  if (idx.length === 0) continue;
  const cascade = files.length - idx[0];
  total += cascade;
  console.log(dir + ': blocks=' + files.length + ' alias=' + idx.length +
    ' first=' + idx[0] + ' last=' + idx[idx.length-1] + ' rehash=' + cascade);
}
console.log('blocks a history rewrite would re-hash:', total);
"
# and the two verdicts on the same blocks:
memphis chain verify --chain system                  # the writer's verdict: ok
node -e "const fs=require('fs');
const b=require('./crates/memphis-napi/index.node');
const blk=JSON.parse(fs.readFileSync('/home/memphis/.memphis/chains/system/000258.json','utf8'));
const prev=JSON.parse(fs.readFileSync('/home/memphis/.memphis/chains/system/000257.json','utf8'));
console.log('the core says:', b.chain_validate(JSON.stringify(blk), JSON.stringify(prev)));"
```

**H2 · the chain registry, before and after S1**

*Before S1 (the hole as found — the code carried its own allowlist):*

```bash
node --import tsx -e "
import fs from 'node:fs';
import { CHAIN_CATALOG } from './src/memory/chain-catalog.js';
const names = Array.isArray(CHAIN_CATALOG) ? CHAIN_CATALOG.map(c => c.name) : Object.keys(CHAIN_CATALOG);
const src = fs.readFileSync('src/infra/storage/chain-adapter.ts', 'utf8');
const block = src.slice(src.indexOf('const DEFAULT_CHAIN_ALLOWLIST'));
const arr = block.slice(block.indexOf('['), block.indexOf(']') + 1);
const entries = [...arr.matchAll(/'([^']+)'/g)].map(m => m[1]);
console.log('catalog:', names.length);
console.log('code allowlist:', entries.length, '| active:', entries.filter(e => !e.includes('backup')).length);
console.log('env:', fs.readFileSync('.env', 'utf8').split('\n')
  .find(l => l.startsWith('MEMPHIS_CHAINS_ALLOWLIST=')).split('=')[1].split(',').length);
console.log('disk:', fs.readdirSync('/home/memphis/.memphis/chains').filter(d => !d.startsWith('_')).length);
console.log('catalog - code active:', names.filter(n => !entries.includes(n)).join(', '));
const safe = /^[A-Za-z0-9_-]{1,64}\$/;
console.log('allowlisted but unreachable:', entries.filter(e => e.includes('backup') && !safe.test(e)).join(', '));
"
```

*After S1 (the registry is derived — there is no second list to read):*

```bash
node --import tsx -e "
import fs from 'node:fs';
import { deriveChainRegistry, getChainAllowlist } from './src/infra/storage/chain-adapter.js';
import { getChainNames, getStandardChainNames, getConditionalChainNames } from './src/memory/chain-catalog.js';

const registry = [...deriveChainRegistry()];
const allowlist = [...getChainAllowlist()];
const disk = fs.readdirSync('/home/memphis/.memphis/chains', { withFileTypes: true })
  .filter((e) => e.isDirectory() && !e.name.startsWith('_'))
  .map((e) => e.name);
const envLine = fs.readFileSync('.env', 'utf8').split('\n')
  .find((l) => l.startsWith('MEMPHIS_CHAINS_ALLOWLIST='));
const env = envLine
  ? envLine.split('=')[1].split(',').map((s) => s.trim()).filter(Boolean)
  : [];

console.log('taxonomy:', getChainNames().length,
  '| standard:', getStandardChainNames().length,
  '| conditional:', getConditionalChainNames().length);
console.log('derived registry:', registry.length);
console.log('effective allowlist:', allowlist.length);
console.log('disk directories:', disk.length);
console.log('config entries:', env.length);
console.log('config asks for a chain the registry does not name:',
  env.filter((n) => !registry.includes(n)).join(', ') || '(none)');
console.log('registry names not on disk:',
  registry.filter((n) => !disk.includes(n)).join(', ') || '(none)');
console.log('disk directories that are not chains:',
  disk.filter((n) => !registry.includes(n)).join(', ') || '(none)');
"
```

*And the rule that decides what may be opened now lives in exactly one place:*

```bash
grep -rn "SAFE_CHAIN_NAME = " src/            # 1 definition
grep -rn "const DEFAULT_CHAIN_ALLOWLIST" src/   # 0 — the second list is gone
grep -rln "SAFE_CHAIN_NAME" src/                # 5 importers, 1 owner
```

**H3 · the SLO's false green**

```bash
memphis slo status --days 7
sed -n '25,35p' src/mcp/tools/slo-status.ts
sed -n '5,10p' src/observability/slo-evaluator.ts
```

**H4 · health's false green**

```bash
memphis health | head -30
sed -n '450,460p' src/infra/http/health.ts
grep -n '^RUST_EMBED_DIM' .env
python3 -c "import json;print(json.load(open('/home/memphis/.memphis/embed/index-v1.json'))['dim'])"
```

**H5 · the deployment drift**

```bash
find dist -type f -printf '%T+\n' | sort | tail -1
git rev-list --count --since='2026-11-02 00:46:28' HEAD
git log --since='2026-11-02 00:46:28' --name-only --pretty=format: -- src/ | sort -u | grep -c .
git log --since='2026-11-02 00:46:28' --diff-filter=A --name-only --pretty=format: -- src/ | sort -u | grep -c .
ls -la /home/memphis/.local/share/npm-global/lib/node_modules/@memphis-chains/
systemctl --user show memphis.service -p ExecMainStartTimestamp -p NRestarts
memphis dream list
# what the build is missing, as a difference between two lists:
node --import tsx -e "
import { CLI_COMMAND_REGISTRY } from './src/infra/cli/registry.js';
const built = (await import('./dist/infra/cli/registry.js')).CLI_COMMAND_REGISTRY.map(r => r.name);
console.log('missing from the build:', CLI_COMMAND_REGISTRY.map(r => r.name).filter(n => !built.includes(n)).join(', '));
"
# the audit's own verdict, and the window it measured:
npm run -s ops:audit | grep -A2 '^deployment-freshness'
# the zone matters — git reads a NAIVE timestamp in the LOCAL zone, so a
# UTC stamp without its zone is read one offset off (this host: CET):
dist_newest=$(find dist -type f -printf '%T@\n' | sort -n | tail -1 | cut -d. -f1)
git rev-list --count --since="$(date -u -d "@${dist_newest}" +%Y-%m-%dT%H:%M:%SZ)" main  # zone kept
git rev-list --count --since="$(date -u -d "@${dist_newest}" +%Y-%m-%d\ %H:%M:%S)" main    # zone dropped
```

**H6 · the writer that bypasses the branch boundary**

```bash
sed -n '150,158p' crons/tuesday-code.sh
gh api repos/Memphis-Chains/memphis/rulesets/14186283 --jq '.rules[].type'
gh api repos/Memphis-Chains/memphis/branches/main/protection
journalctl --user -u memphis-tuesday-code.service --since '2026-11-03 12:55' --no-pager
```

**H7 · the mis-scoped gates**

```bash
grep -n 'fixtures\|vitest' .github/workflows/chain-invariant.yml
grep -n 'UNIT_DIR' scripts/check-systemd-units.mts
grep -rn 'safety-check\|rust-core-safety' .github/workflows/    # no hit
cat .github/workflows/backup-restore-drill.yml
grep -n 'ls-files' scripts/pii-scan.sh
grep -n 'tests/\*' scripts/default-secret-scan.sh
```

**H8 · the postmortem corpus**

```bash
ls -1 docs/postmortems/2*.md | wc -l
grep -c '^| \[' docs/postmortems/README.md
grep -r -o 'DONE\|TODO' docs/postmortems/*.md | wc -l
```

**H9 · the Dreaming remainder**

```bash
grep -rn 'chainBlockHashes' src/cognitive/dreaming/proposals.ts
memphis dream list
```

---

## 8. The short version

The runtime has nine measured holes. Eight of them are the same hole wearing
different clothes: **a boundary exists, and a writer went around it.** The
ninth is the Dreaming tier standing at its own gate with nothing on the other
side.

The plan is not nine fixes. It is one audit that measures the live system
(S0), four stages that make the boundaries un-bypassable (S1–S4), one that
makes the scanners see (S5), and the Dreaming gate that gives the mechanism
its point (S6).

Every stage carries a command and an expected output. If a stage cannot be
falsified on this host, it does not ship.
