# Chain block write race condition — class of corruption affecting cases #275 + #385

## Severity
**MEDIUM-HIGH**

Re-reported from decision #146 (2026-09-11). Pattern verified recurring (different instances, different backup chains). Class of bugs not single bug.

## Observed (from log evidence)

Two chain corruption instances with **different symptoms but same root cause class**:

| Block | Chain | Pattern | Detection |
|---|---|---|---|
| `#385` (cases) | `cases/` | trailing extra `}` after JSON close | Python `json.loads` raised "Unexpected non-whitespace character after JSON at position 482" |
| `#275` (cases backup) | `cases.backup-2026-07-07T15-07-23-108Z/` | extra text `"8c23"` appended after hash | different shape, same class |

Both chains written via the same hybrid Rust+TS writer path. Backup #275 was not caught because chain_verify returns `ok:true` for both — it verifies **hash linkage** (`prev_hash → hash`), NOT **parseability** (`json.loads`).

## Cascade

Corrupted block → `cognitive prelude loadRecentBlocks` throws on parse fail → `post-response cognitive pass` fails → "gateway turn persistence degraded" → TUI never gets terminal event.

Live session 2026-05-08 saw this exact cascade.

## Why chain_verify is insufficient

`chain_verify` checks `prev_hash + hash match → ok`. It does NOT `JSON.parse(file)`. The corruption pattern is:
1. Block written correctly (valid JSON, valid hash)
2. Later, **something else** appends garbage to the file (extra `}`, extra `"8c23"`, etc.)
3. Hash on disk still matches (was correct at write time)
4. But file content is no longer valid JSON

So `chain_verify ok:true` is necessary but not sufficient. Real parse validation requires read-and-parse every block.

## Repro

1. Make a write to `cases/` chain
2. Wait for backup chain `cases.backup-*/` to flush
3. Various race conditions can occur:
   - Concurrent Rust NAPI bridge write + TS writer appendViaRust (mixed path)
   - fsync timing — write hits disk before fsync, but reader cached partial state
   - Stream/error handler appending garbage on partial write

Non-deterministic. Race-condition class.

## Expected

Every block is parseable JSON at all times. `chain_verify` should catch this. Or a separate `chain_parse_check` should run on every block in every chain.

## Actual

`chain_verify` reports OK on corrupted blocks. `json.loads` fails when block is read by `cognitive prelude`. Session degrades silently — operator sees "gateway turn persistence degraded" without indication WHY.

## Suggested fix (3 layers, ranked by impact)

### Layer 1 (immediate, low effort): parse-check on every read
Wrap `readBlockFile` in `crates/memphis-operator` (or wherever) to `JSON.parse` after read; throw on failure (already does this per `chain-file-io.js:64`) — but ALSO throw on parse failure for the WHOLE read operation, not just per-block. Currently the throw is caught downstream and degrades silently.

### Layer 2 (1-day): regression test that catches BOTH patterns
Add `crates/memphis-core/tests/chain_parse_validation.rs` (or `.test.ts`) that:
- Writes a valid block
- Appends extra `}` to it (simulates #385 pattern)
- Appends extra `"8c23"` to it (simulates #275 pattern)
- Asserts `chain_verify` or `chain_parse_check` flags both as corrupt

### Layer 3 (1-week): atomic writeBlockAtomic post-condition
After every `writeBlockAtomic` in `chain-adapter.ts:121`, do a synchronous `JSON.parse(read-back)` to confirm the file is parseable. Rollback tmp if parse fails. This is the standard Postgres `fsync` + `integrity_check` pattern.

## Acceptance criteria

- `cargo test -p memphis-core` (or `npm test --workspace`) passes new test that catches both #275 and #385 patterns.
- `chain_verify <chain>` returns `ok:false` (or new field `parseOk:false`) for corrupted blocks.
- New scheduled task `memphis-chain-parse-sweep.timer` runs hourly, parses last 5 blocks of every chain, alerts on failure.

## Related

- Decision #146 (2026-09-11): original analysis
- Issue #626 (`[bug] Chain block write occasionally produces trailing extra brace`) — covers #385 pattern only
- Issue #628 (`[bug] embed reindex — atomic write needed (P0 data loss)`) — same root cause class, embed chain variant

## Workaround

Manual `python3 -c "import json; json.loads(open('~/.memphis/chains/cases/000385.json').read())"` to detect corruption. Surgical fix: `python3 -c "import json; ...; json.dump(...)" | atomic mv` to rewrite. **Lossy for downstream readers that trust the hash field**.

## Owner

@memphis-runtime maintainers

## Labels

bug, infra, race-condition, chain-corruption, regression, class-of-bugs
