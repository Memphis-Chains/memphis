# Memphis Runtime State Model

Status: canonical runtime state source of truth for the current `memphis` repository.

This document defines:

- what counts as active Memphis runtime state,
- which paths are canonical sources of truth,
- which files are derived or rebuildable,
- what cleanup is allowed to remove,
- what belongs to core vs extension vs historical narrative.

For product boundaries, see `docs/CANONICAL-ARCHITECTURE.md`.
For trust boundaries and dependency hardening, see `docs/RUNTIME-SECURITY-ARCHITECTURE.md`.

## 1. Consolidation baseline

### 1.1 What is really connected

These surfaces are part of the supported core runtime today:

- source checkout plus `npm run bootstrap`,
- local agent profile and `soul-*` identity/memory surfaces,
- vault initialization and local secret storage,
- durable memory via chains plus derived recall indexes,
- CLI, HTTP, MCP, and Rust TUI operator paths,
- Rust-backed chain, vault, embed, operator, and TUI crates,
- `memphis reset --runtime --yes` as the canonical destructive cleanup path.

### 1.2 What is half-connected

These surfaces exist, but remain optional or operationally uneven:

- cloud provider coverage and fallback quality,
- optional channel transports such as Telegram,
- advanced sync, trade, and federation lanes,
- deeper cognitive surfaces beyond the bounded automatic prelude/post-response pass,
- some session and operator-state convergence across all interfaces.

They must not redefine the core runtime path.

### 1.3 What is aspiration or narrative

These are not canonical product truth:

- personhood or self-aware framing as the definition of Memphis,
- overnight deployment snapshots as architecture truth,
- `life.db` as the canonical source of runtime truth,
- historical counts in memory notes that conflict with active code and canonical docs.

Historical and operator-local notes may remain useful, but they do not override this document.

## 2. Canonical runtime roots

### 2.1 Repo root

The repository root is the supported operator checkout. It may contain:

- `.env` for local runtime configuration,
- `.memphis/` for workspace context generated from the checkout,
- optional operator notes such as `AGENTS.md` and `CLAUDE.md`,
- source code, docs, tests, scripts, and build outputs.

The repo root is not the canonical place for durable runtime databases or chain data unless explicitly configured that way.

### 2.2 Data root

The canonical runtime data root is:

1. `MEMPHIS_DATA_DIR`, if set
2. `MEMPHIS_DIR`, if set
3. `~/.memphis`, by default

The data root is where Memphis stores persistent runtime state such as:

- `config/agent-profile.json`
- `config/soul-manifest.json`
- `config/soul-memory.json`
- chains
- vault files
- backups
- logs
- local operational markers

### 2.3 Operational SQLite path

The canonical operational SQLite path is `DATABASE_URL`, which defaults to `file:./data/memphis.db` in the repo-local bootstrap layout.

This database is active runtime state. It is not a derived cache.

### 2.4 Derived recall state

`RUST_EMBED_PERSIST_PATH` and similar recall indexes are derived runtime artifacts.

Rules:

- chains remain the audit source of truth,
- derived recall indexes accelerate lookup,
- derived indexes may be removed and rebuilt,
- direct debug writes must not replace the canonical chain-backed write path.

## 3. Runtime loop truth

The canonical conversational execution loop is:

1. user input enters the gateway/runtime,
2. a shared local turn runtime prepares chain-backed recall and bounded cognitive context,
3. the model decides whether tool calls are needed,
4. tool execution happens,
5. tool results are written into audit surfaces and added back into loop context,
6. a follow-up model turn produces the final assistant response,
7. the response is delivered to the operator,
8. session and memory persistence are attempted before the turn is considered finished,
9. post-response cognition updates local chain-backed state for later turns.

The loop does not terminate at `tool exec -> chain`. Tool results must feed back into the assistant response path.

## 4. Active state domains

Memphis core runtime state is split into these domains:

- agent profile and operator defaults,
- identity and memory surfaces (`soul-manifest.json`, `soul-memory.json`),
- durable chains and related recall indexes,
- vault material and recovery metadata,
- operational SQLite state for sessions, approvals, jobs, and runtime control,
- logs, backups, and recovery markers.

`life.db` is not part of this canonical runtime state model.

## 5. Cleanup semantics

The canonical destructive cleanup path is:

```bash
memphis reset --runtime --yes
```

`reset --runtime` is allowed to remove:

- the active data root,
- `.env`,
- `.memphis/`,
- repo-local operator helper files such as `AGENTS.md` and `CLAUDE.md`,
- configured operational DB and embed index paths,
- stale repo-root `memphis.db*` and `embed-index.json` leftovers,
- orphan historical runtime roots such as `./undefined/`.

`reset --runtime` is not a migration tool. Its job is to return the checkout to a clean runtime baseline.

The canonical non-destructive repair path is:

```bash
memphis repair runtime
```

Use `repair runtime` for rebuildable local state such as:

- exact-search SQLite state,
- stale runtime locks,
- degraded `patterns` chain and stale legacy `patterns.json` residue.

`repair runtime` must not delete canonical memory chains or vault state.

## 6. Fresh-install contract

The canonical fresh-install path is:

1. clone the repository,
2. run `npm run bootstrap`,
3. run `npm run -s cli -- init`,
4. run `npm run -s cli -- doctor --fix`,
5. if health reports degraded-but-repairable local state, run `npm run -s cli -- repair runtime`,
6. run `npm run -s cli -- health --json`,
7. start the runtime with `npm run dev` or the installed user service,
8. open the Rust TUI or use CLI/HTTP/MCP.

This flow must not depend on:

- historical chain debris,
- historical persona seeds,
- operator-local overnight notes,
- `life.db`,
- deprecated downstream integrations.

## 7. Cognitive boundary

The canonical runtime now includes an automatic local cognitive pass around each turn.

Current truth:

- pre-response cognition is chain-first and bounded: local chains plus local exact/semantic recall feed the live assistant turn,
- post-response cognition updates local state for future turns,
- CLI, gateway, and HTTP `/v1/chat/generate` now use the same canonical turn-runtime contract,
- Model B is chain-first in product truth; git/file helpers are optional adjunct signals,
- Model D remains intent-gated rather than mandatory on every turn,
- GitHub and git history remain secondary review surfaces, not runtime memory truth.

## 8. Historical and advisory material

These materials may exist in the repo, but are not canonical runtime truth:

- `memory/` handoff notes and synths,
- overnight deployment reports,
- advisory identity/memory docs that use older `soul` language,
- downstream or pilot documentation,
- archived legacy surfaces.

When they conflict with active docs or code, the order of truth is:

1. active code and tests,
2. `README.md`,
3. canonical docs under `docs/`,
4. advisory or historical notes.
