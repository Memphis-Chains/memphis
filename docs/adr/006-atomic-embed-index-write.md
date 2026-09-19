# ADR-006 — Atomic Embed Index Write (kill the reset-then-rebuild data loss)

Date: 2026-09-18
Status: Proposed
Deciders: operator (Marcin Kukla), mcode exec session `mvs_df0ab992…`
Supersedes: —
Related: issue #628, decision #156, decision #190, `docs/adr/ADR-005-live-camera-stream.md`

## Context

Issue #628 (`bug`, P0, opened 2026-09-17) documents a reproducible data-loss
path in `memphis embed reindex`:

1. Operator runs `memphis embed reindex`.
2. The JS shim (`src/infra/memory/embed-reindex.ts`, ~L256 in source, ~L173 in
   compiled `dist/`) calls `embedReset(rawEnv)` **before** preparing the new
   index.
3. `embedReset` → NAPI `embed_reset` → `pipeline.clear()` →
   `persist_best_effort()` → `persist_now()` → atomic write of a 33-byte empty
   payload over the previous full file
   (`crates/memphis-embed/src/pipeline.rs:902-905` + `:1036-1062`).
4. Bulk upsert (`embedStoreMany` → `pipeline.upsert_many` with
   `set_auto_persist(false)`) populates the in-memory HashMap only.
5. Materialising flush (`embedFlush` → `pipeline.flush()` →
   `persist_now_json_v1`/`persist_now_ndjson_v2`) writes the new full payload
   atomically via `write tmp + fs::rename`
   (`pipeline.rs:1085-1093` for v1, `pipeline.rs:1096-1128` for v2).

If anything fails between steps 3 and 5 (process killed, OOM, JS exception,
two reindexers racing), the on-disk file is the empty 33-byte payload. The
previous chain-derived embedding history is gone.

In-the-wild instances:

- Decision #156 (2026-09-12): `memphis repair runtime` dropped 4832→0 docs.
- 2026-09-17 session: two `memphis embed reindex` processes raced (one
  `--all`, one default). Both reset, neither rebuilt. Lost ~205 docs.

The on-disk write itself is **already atomic** at the FS level
(`write tmp + rename`). The hazard is the **order** in which the destructive
clear is committed to disk relative to the new full payload being ready.

## Decision

Adopt a **two-tier clear** so the destructive disk write is never observable
without a successful rebuild behind it:

- `EmbedPipeline::clear()` — **unchanged**. Clears in-memory HashMap and
  persists an empty on-disk payload. Used by `memphis embed reset` (CLI
  handler `src/infra/cli/handlers/embed.handler.ts:18`) and `doctor-v2`
  (`src/infra/cli/utils/doctor-v2.ts:509`) where the operator explicitly
  wants the on-disk file wiped.
- **New** `EmbedPipeline::clear_in_memory_only()` — clears the in-memory
  HashMap and **does not persist**. Caller is responsible for materialising
  a replacement via `flush()`. Surface it as a new NAPI binding
  `embed_clear_in_memory`.
- `embed_reset` (NAPI) keeps its current "wipe and persist" semantics for the
  existing CLI/doctor callers.
- The JS bulk rebuilder (`src/infra/memory/embed-reindex.ts`) switches from
  `embedReset` to the new in-memory-only clear in a follow-up commit on the
  same branch — the destructive on-disk write then happens only after the
  bulk upsert succeeds and the materialising flush commits atomically.

`crates/memphis-embed/src/store.rs::VectorStore::persist_to_disk` is **not**
in scope here. That path is a separate API surface (not currently wired into
the embed rebuilder) and uses `std::fs::write` directly. Fixing it can be a
follow-up ADR if/when VectorStore becomes load-bearing for rebuild.

## Consequences

Positive:

- Crash between clear and flush leaves the previous index intact
  (`clear_in_memory_only` never wrote the empty payload in the first place).
- Crash during flush atomic-rename leaves the previous index intact
  (`fs::rename` over a missing or incomplete `.tmp` is a no-op for the live
  file).
- Race between two reindexers: the second `clear_in_memory_only` only
  mutates in-memory state; whichever flush lands first wins, and the losing
  flush's empty state is never observable on disk.

Negative / risk:

- Two paths to clear (`clear` vs `clear_in_memory_only`). Mitigated by
  naming + the rustdoc on each method, plus the regression test added with
  this change.
- A future caller that wanted destructive wipe + persist for non-rebuild
  reasons must use `clear()` explicitly. Documented at the binding level.
- Adds one NAPI surface (`embed_clear_in_memory`). Trivial cost.

## Implementation

### `crates/memphis-embed/src/pipeline.rs`

Append after `clear()` (~L905):

```rust
/// In-memory only destructive clear. The on-disk index is left untouched —
/// the caller MUST follow with `flush()` to materialise a replacement, or
/// accept that the next `with_persistence` load sees the previous index.
pub fn clear_in_memory_only(&mut self) {
    self.docs.clear();
}
```

### `crates/memphis-napi/src/lib.rs`

Append after `embed_reset` (~L679): `embed_clear_in_memory` NAPI binding
mirroring `embed_reset`'s shape (lock, call new method, return
`{cleared: true}`).

### `crates/memphis-embed/src/pipeline.rs` test

New `#[test]` `clear_in_memory_only_leaves_disk_unchanged_on_drop` that
snapshots the on-disk file before clear+upsert, drops the pipeline
(simulating SIGKILL between clear and flush), and asserts the post-drop
snapshot is byte-identical to the pre-clear snapshot.

### `src/infra/storage/rust-embed-adapter.ts`

Register `embed_clear_in_memory` in `EMBED_BRIDGE_ALIASES` and
`NormalizedEmbedBridge`; add `embedClearInMemory()` TS function with a
fallback to `embedReset()` when the loaded NAPI crate predates the ADR-006
surface.

### `src/infra/memory/embed-reindex.ts`

Switch the bulk rebuilder's `embedReset(rawEnv)` call to
`embedClearInMemory(rawEnv)` so the destructive on-disk write happens only
after the bulk upsert succeeds and the materialising flush commits
atomically.

### `tests/unit/runtime-repair.embeddings.test.ts`

Mock the new `embedClearInMemory` export; change the regression assertion
to require `embedClearInMemory` to be called exactly once and
`embedReset` to be called zero times (regression guard for issue #628).

## Validation

- New unit test in `pipeline.rs::tests` (described above) passes.
- Existing test suite (`cargo test -p memphis-embed`, 28 tests) continues to
  pass — no `clear()` callers depend on the persist-on-clear behaviour for
  their own correctness; we only added a new method.
- `tests/unit/runtime-repair.embeddings.test.ts` (vitest) updated and
  passing — the regression assertion now proves the rebuilder takes the
  in-memory-only clear path.
- Manual repro from issue #628 (kill mid-rebuild) now leaves the previous
  index intact after the TS follow-up commit wires the new binding.

## Out of scope (follow-up)

- Atomic write for `crates/memphis-embed/src/store.rs::persist_to_disk`
  (separate API surface; not currently wired into embed rebuild).
- `memphis embed restore --from-backup` subcommand from issue #628's
  acceptance criteria. Existing scheduled-backup tarballs are the
  acceptable recovery path until that subcommand lands.