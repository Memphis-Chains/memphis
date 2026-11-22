# ADR-012 — One contract across the bridge: the registry is the tool contract on both sides

Date: 2026-11-22
Status: Accepted
Deciders: operator (Wodzu)
Related: ADR-010 (Tauri build status), ADR-011 (cockpit core and Tauri shell),
`docs/design/MEMPHIS-CRASH-REBUILD.md` §6 item 1, `docs/roadmap/ROADMAP_2026_2030.md` point 1,
`sites/memphis-v5/roadmap/index.html` (the published public plan)

## Summary

Memphis has two agent runtimes: the Rust `memphis-operator` (24 533 LOC) that the Ratatui
cockpit drives, and the TypeScript `src/gateway` + `src/providers` (23 113 LOC) that the
service drives. Both answer the same question — "what does this tool accept?" — and until
2026-11-22 they answered it from two different places.

This ADR decides what that question's one answer is, and what happens to the duplication
that is left.

**The decision: the Rust core owns the data plane, the TypeScript arm owns the model
surface, and the tool CONTRACT is one — owned by `TOOL_REGISTRY` — on both sides of the
bridge.** The two runtimes stay; the second copy of the contract does not.

This is not a new architecture. It is the architecture the public roadmap already claims
(`ROADMAP_2026_2030.md` point 1: "rdzeń Rust + orkiestracja TypeScript"), written down as a
rule with a gate, because a rule nobody checks is a convention.

## The measurement that forced it

Measured on the operator host on 2026-11-22, comparing the native cockpit's advertised
catalog against `TOOL_REGISTRY`:

- The native surface offers **23** tools; the registry declares **64**. Every native tool is
  a subset of the registry — there is no native-only tool.
- **Five of the 23 advertised different arguments than the registry.** A model talking to
  the cockpit and a model talking to Telegram, the CLI or MCP were offered different tools
  under the same names:

  | Tool | Registry | Native cockpit |
  | --- | --- | --- |
  | `memphis_journal` | `content`, `tags`, `chain` | `content`, `tags` |
  | `memphis_case_append` | `entry` **or** the flat case fields | `entry` only |
  | `memphis_chain_query` | `chain`, `limit`, `offset`, `blockType`, `contains`, `tag` | `chain`, `limit`, `contains`, `tag` |
  | `memphis_classify` | `criteria` is a union (object of labels, or an array of 2–10 labels) | `criteria` is an object only |
  | `memphis_self_modify` | `intent`, `files`, `changes`, `plan_id`, `step_idx` | `path`, `content`, `mode` |

- `memphis_self_modify` is the worst of them, and it is not a schema drift: **under one name
  the registry means "apply changes to many files, with a snapshot and a test run", and the
  native tool writes ONE file.** Two different operations, one name.
- One catalog entry was simply wrong: `memphis_git` required `command`, while the executor
  beside it — and the registry — used `subcommand`. The catalog was lying about the tool it
  sat next to.
- The descriptions differed for 21 of the 23 tools, and the native ones carried guidance the
  registry did not have: the bare-array rule that stops the model inventing
  `{"item": [...]}` (decision #322 — that shape reached `run_soul_write` 18 times).

## Why the Rust arm survives, and why the TypeScript arm does not replace it

ADR-011 F2 measured this and it did not change: **the TypeScript stack does not stream**
(`src/providers/index.ts:284` → `stream: false`), while the Rust stack streams token by
token. The cockpit's single most visible quality is streaming, and the planned Tauri GUI
inherits it by embedding the Rust runtime.

So the split is not "Rust or TS". It is:

| | Owner | Why |
| --- | --- | --- |
| Data plane — block format, hash, vault, embeddings, paths, chain write lock | **Rust** | already canonical; TypeScript reaches it only through N-API |
| Cockpit — TUI today, Tauri shell planned | **Rust** (`memphis-cockpit`, ADR-011 Layer 1) | streaming, tool executor, guards, buffer semantics |
| Service surfaces — Telegram, CLI, HTTP, MCP | **TypeScript** | the service IS the TypeScript arm (`ExecStart=node dist/infra/cli/index.js serve`) |
| Tool contract | **one**, owned by `TOOL_REGISTRY` | this ADR |

The Tauri project is what makes the contract question urgent rather than academic: the GUI
is planned to share the cockpit's Rust core, so the Rust tool contract becomes the contract
the operator sees in the GUI — while the same tool on Telegram goes through the TypeScript
one. Two contracts for one brand, growing with every tool.

## What the Tauri project and the phone app would have inherited

The cockpit's second shell is not hypothetical any more. Two tracks point at it, and both
are Tauri:

- **Desktop GUI** (ADR-011, Layer 3) — a Tauri app that embeds the Rust cockpit core,
  because the TypeScript stack does not stream (F2).
- **Phone app** (public roadmap, published 2026-11-20) — a Tauri app generated from the
  operator's own fork, which reaches the operator's computer over an authenticated SSH
  session and drives the same Rust engine there.

Both sit on the **cockpit side** of the bridge. That is the whole reason this ADR had to
be written before either shell started: the cockpit's tool contract becomes the contract
the operator sees in the GUI and on the phone, while the same tool on Telegram or in the
CLI goes through the TypeScript one.

What the shells would have inherited, had nothing been measured and nothing been decided
(all rows measured on 2026-11-22, § "The measurement that forced it"):

| Inherited divergence | What it looks like from a GUI or a phone |
| --- | --- |
| `memphis_journal` without `chain` | the model writes to a different chain than the one the shell shows |
| `memphis_case_append` accepting only `entry` | the shell's case form rejects what the registry accepts elsewhere |
| `memphis_chain_query` without `offset` / `blockType` | no paging in the one surface that has room to page |
| `memphis_classify` with the object form only | the union the registry documents is unreachable from the cockpit |
| `memphis_self_modify` meaning "write one file" | **one name, two operations** — the worst row: neither the model nor the shell can tell which one is meant |

The projection removes the possibility structurally rather than by convention. The
cockpit's tool schemas are *generated* from `TOOL_REGISTRY`, so a shell cannot offer a
tool shape the registry does not have, and a new tool reaches every surface by
regenerating one projection instead of by remembering to update a second hand-written
schema.

The rule that follows for the shells themselves: **a shell never defines a tool.** The
phone inherits the contract from the computer it talks to; the desktop GUI inherits it
from the core it embeds; Telegram and the CLI inherit it from the registry they already
read. "One brain, two shells" is only true if the shells hold no logic of their own —
which is exactly what ADR-011's Layer 1 extraction makes possible.

## The decision, concretely

1. **The registry is the contract.** `src/gateway/tool-registry.ts` declares every tool's
   arguments. The MCP server, the gateway executor, the provider surface and — now — the
   native cockpit read it.
2. **The projection is JSON.** `scripts/sync-native-tool-contract.mts` projects the registry
   into `tests/fixtures/native-tool-contract.json` (the agreed contract) and
   `crates/memphis-operator/src/chat_tool_contract.rs` (the cockpit's copy). The Rust side
   parses that copy; it no longer hand-writes a schema. JSON because the reference
   architecture says JSON is the only format, and because a hand-written Rust literal is a
   second copy the moment it is written.
3. **The gate is the same shape as the tier gate.** `scripts/sync-native-tiers.mts` already
   projects the registry's TIERS into the Rust catalog and fails the build on drift. This
   ADR adds the CONTRACT to the same pattern, with `--check` in CI next to it.
4. **Both sides check themselves against the artifact.** The Rust side
   (`crates/memphis-operator/src/chat_tool_catalog.rs`, `contract_tests`) and the TypeScript
   side (`tests/unit/native-tool-contract.test.ts`). Neither produces it alone, so neither
   can change it alone.
5. **Prose stays on the surface; the contract does not.** A field description is
   presentation, not contract: the gateway keeps its property descriptions at the call
   site, the cockpit keeps its own in `chat_tool_guidance.json`, and the projection merges
   the cockpit's into the contract without letting either override the registry's
   constraints. A gate asserts that the guidance describes only fields the contract
   declares — a description of a field that does not exist teaches the model to send
   something the surface rejects.
6. **The rule that was only on one side moved to the registry.** The bare-array rule now
   lives in `TOOL_REGISTRY` (`memphis_soul_write`'s description and its field
   descriptions), so BOTH surfaces teach it. It used to exist only in the cockpit's
   hand-written schema.

## What was closed, and what closing it taught

Four of the five declared divergences are closed as of 2026-11-22, each with a
falsifier. What the closure taught is more useful than the closure itself.

| Divergence | Closed by | The difference it hid |
| --- | --- | --- |
| `memphis_journal` ignored `chain` | the native journal validates the name against `JOURNAL_TARGET_CHAINS` and appends to it | the memory id, the exact-search key and the embed tags all followed "journal" |
| `memphis_chain_query` read neither `offset` nor `blockType` | the native arm runs the gateway's ORDER: window → offset → filters → limit | `contains` was a contiguous substring where the gateway tokenises the query (decision #190); `tag` matched case-insensitively where the gateway matches exactly |
| `memphis_classify` read only the object form of `criteria` | ONE normalisation, shared, checked from both arms against ONE fixture | a non-string description was DROPPED where the gateway stringifies it — which could turn two options into one |

**The contract artifact covers the INPUT SHAPE. It never covered the ANSWER.**
Every divergence above was about argument names, and each one turned out to hide
a difference in what the tool ANSWERS — the filters, the normalisation, the
order. A schema that matches on both sides is not a guarantee that the two
surfaces answer the same way.

So the closure added a SECOND axis: a behaviour contract. Two of them so far:

| Fixture | What it pins | Arms |
| --- | --- | --- |
| `tests/fixtures/classify-criteria-contract.json` | how `criteria` becomes options | `tests/unit/classify-criteria-contract.test.ts` · `crates/memphis-operator/tests/classify_criteria_contract.rs` |
| `tests/fixtures/case-append-contract.json` | which entry a call carries — the wrapped form and the flat form | `tests/unit/case-append-contract.test.ts` · `crates/memphis-operator/tests/case_append_contract.rs` |

Both use the pattern the journal-target allowlist already uses, applied to rules
that had been COPIED rather than shared. Each rule now lives in ONE function per
arm and is checked against ONE table of cases.

### The one difference this ADR does NOT close

An object's INSERTION order. The gateway keeps it; a `serde_json::Map` is
sorted. The two agree whenever the keys are already sorted, and they differ
only for an object whose keys are not — and then only under `orders: 1`, the
mode the BASAL service documents as order-sensitive ("Render the options IN THIS
ORDER", `basal_cpu.py`).

Closing it means giving the crate an order-preserving JSON map, which changes
how every block is serialised — and the canonical hash is computed over that
serialisation, so it is not a change to make while closing a divergence. It is
recorded here rather than hidden in a helper.

**Falsifier:** a classification over an object whose keys are not in sorted
order, with `orders: 1`, answered differently by the cockpit than by the
gateway.

## What is deliberately NOT decided here

The five declared divergences stay declared. They are recorded in the artifact with the
reason and the work that closes each one, because a schema that promises what the surface
cannot execute is the same class of bug as one that promises the wrong argument names:

| Tool | The gap | What closes it | State |
| --- | --- | --- | --- |
| `memphis_journal` | the registry declares `chain`; the native journal ignores it | plumb the chain through `run_native_journal`, validated by `is_journal_target_chain` | **closed** 2026-11-22 |
| `memphis_chain_query` | the registry declares `offset` and `blockType`; the native arm reads neither | apply both natively, mirroring the gateway tool | **closed** 2026-11-22 |
| `memphis_classify` | the registry's `criteria` is a union; the native arm reads only the object form | accept the array form natively, mirroring the gateway's `normalizeCriteria` | **closed** 2026-11-22 |
| `memphis_case_append` | the registry accepts the flat case fields; the native arm reads only `entry` | ONE normalisation, shared, checked from both arms against ONE fixture | the hand-written schema advertised an `entry.tags` field the case entry DOES NOT HAVE — the block's tags are derived — so the model was taught to send a field the surface dropped | **closed** 2026-11-22 |
| `memphis_self_modify` | same name, two different operations | implement the registry semantics natively, or rename the native operation so the name stops lying | open |

Closing them is mechanical except the last one, which is a decision about what the cockpit
is for. It is not this ADR's to make silently.

## What this ADR does NOT do

- **It does not collapse the two runtimes.** The Rust operator and the TypeScript gateway
  both stay. The duplication that goes away is the CONTRACT, not the code.
- **It does not touch the cockpit's architecture.** ADR-011's `memphis-cockpit` extraction
  and the Tauri shell are unaffected — this ADR makes the tool contract the cockpit's
  second shell inherits correct.
- **It does not make the TUI a client of the service.** The cockpit keeps its own engine
  because that engine streams. (It has no HTTP client today — `crates/memphis-tui/Cargo.toml`
  has no `reqwest` — so a "thin client" TUI would be a project of its own, not a side
  effect of this ADR.)

## Falsifiers

| Claim | What would prove it false |
| --- | --- |
| The registry is the contract on both sides | `npm run -s ops:sync-native-tool-contract -- --check` passes while the cockpit advertises something the registry does not — i.e. a hand-written schema reappears in the cockpit |
| The projection is current | the CI step fails on a registry change that was not re-projected |
| The cockpit honours the contract | a native tool's advertised arguments are not the ones its executor reads — the five divergences are the known list, and the gate names a sixth if one appears |
| The Rust arm has to survive | the TypeScript stack gains token streaming, and the cockpit can be a thin client of the service — then this ADR's split is wrong and the operator's decision changes |

## Evidence index

Everything asserted above was measured on the operator host on 2026-11-22:

- `crates/memphis-operator/src/chat_tool_catalog.rs` — the projected catalog and the
  declared divergences
- `crates/memphis-operator/src/chat_tool_contract.rs` — the projection (generated)
- `crates/memphis-operator/src/chat_tool_guidance.json` — the cockpit's prose
- `tests/fixtures/native-tool-contract.json` — the agreed contract
- `scripts/sync-native-tool-contract.mts` — the projection and the gate
- `tests/unit/native-tool-contract.test.ts` — the TypeScript side of the gate
- `src/providers/index.ts:284` — `stream: false`, the reason the cockpit keeps the Rust
  engine (ADR-011 F2)
- `systemctl --user cat memphis.service` — the service runs the TypeScript arm
- `docs/adr/011-cockpit-core-and-tauri-shell.md` §1.4 — the phone app as the first
  second shell, and the rule that a shell never defines a tool
- `sites/memphis-v5/roadmap/index.html` — the published public plan (2026-11-20) whose
  four stages the contract has to survive
