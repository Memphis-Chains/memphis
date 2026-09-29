# ADR-009 — Concurrent-Process Race in `writeBlockAtomic` (Issue #626 Known Limitation)

Date: 2026-09-21
Status: Proposed
Deciders: operator (Marcin Kukla), Q4 plan (Phase T)
Supersedes: —
Related: issue #626 (chain read-after-write verification), commit `d4dacc6`
(read-after-write + rollback for same-process), `src/infra/storage/chain-file-io.ts`
lines 121–205, the new golden-fixture `tests/integration/chain-invariant.test.ts`
from ADR-008, prior `tests/unit/chain-file-io.test.ts` happy + rollback coverage
introduced by PR #635.

## Context

The `writeBlockAtomic(dir, index, payload)` function in `src/infra/storage/chain-file-io.ts`
writes a JSON-encoded chain block to `${dir}/${index:06}.json` via tmp-file +
`rename`. After `rename`, the function reads the just-written file back
(read-after-write) and compares against the payload. If they diverge
(corrupted by trailing garbage, partial flush, or serializer race), the
function rolls back: restore the previous content if it existed, otherwise
`unlink` the corrupted file. This is the partial-fix path from issue #626,
shipped in commit `d4dacc6` during the v1.13.2 cycle.

The same-process contract is **partially** covered by `tests/unit/chain-file-io.test.ts`
(which PR #635 extended with five regression cases pinned at line 130–166):

- happy-path new slot
- overwrite existing block
- genesis (index 0) overwrite refusal
- rollback to previous bytes when verification read diverges (vi.mock + vi.hoisted)
- unlink corrupted file when no previous exists (vi.mock + vi.hoisted)
- `withNapiAppendLock` serialises concurrent callback execution
- `withNapiAppendLock` cleans up its lock file

What is **missing**:

- **No test for cross-process concurrent writers.** The same-process
  `withNapiAppendLock` only protects between callbacks running inside the
  SAME Node process. Two `writeBlockAtomic` calls from two distinct
  processes (or two `npm`-spawned operators — e.g. gateway + TUI running
  in parallel, or two TUI windows in tmux) race for the same slot with NO
  inter-process lock.
- **No test for the read-after-write window between `rename` and
  `readFile` in the cross-process case.** A second process can `rename`
  in *during* the first process's `rename → readFile` window, causing the
  first process's verification read to see the SECOND process's payload.
  The post-rename read compares against the FIRST process's payload, fails,
  rolls back, and the chain ends up holding the SECOND process's payload —
  but the SECOND process was unaware that its write got verified-and-rolled-back
  by the FIRST process. The chain integrity sweep catches this within an
  hour (commit `d4dacc6` message: "Known limitation: catches corruption AT
  writeBlockAtomic boundaries — does NOT catch concurrent-process
  corruption between writeFile and readFile").

Per the v1.13.2 release notes (commit `4650f16`-backport block): the
`sweep` is the **second** line of defence. The **first** line — atomic,
synchronous, single-process — was never extended to be atomic across
processes because POSIX does not provide cross-process atomic tmp-file +
rename + read-back semantics. The kernel ordering between `rename(2)`,
`read(2)`, and another process's `rename(2)` is non-deterministic.

## Decision

Adopt a **process-level race regression test** as the regression surface
for the known limitation. The test does NOT try to fix the race; it
**pins the current contract**: a cross-process concurrent write may
produce either a clean "last-writer-wins" state, a torn write detectable
by `chain-integrity-sweep.mjs`, or a clean side-channel error like
`EACCES` on a read-only file. The contract pins all three as acceptable
operational states; a regression that produces a NEW failure mode (e.g.
unhandled exception with stack trace leaking bytes, or a directory
corruption) is the test's job to catch.

The test synthesises two child processes via `child_process.fork` of a
small in-repo helper script `tests/helpers/concurrent-writer.mjs`. The
helper is a minimal Node process that takes `--dir` + `--index` +
`--payload` argv and calls `writeBlockAtomic` once. The test forks two
copies, waits for both to exit, then:

1. Reads the final state at `${dir}/${index:06}.json` and asserts the
   block parses as JSON with required `index` + `hash` fields. This is
   exactly what `chain-integrity-sweep.mjs` checks; cross-test consistency.
2. Runs `node scripts/chain-integrity-sweep.mjs --tail 50` against the
   same dir and asserts exit 0 OR exit 1 (both acceptable), with the
   exit-2 path failing because the dir is the per-test sandbox.
3. Logs both child stdout/stderr for triage. On test failure (or
   invariant breach), the test attaches the captured streams as part of
   the vitest failure message, so a CI failure surfaces the actual
   process-level error.

The helper script is checked in (not generated) so a regression in
`writeBlockAtomic` is reproducible without re-deriving the harness.

**No change to `writeBlockAtomic` production code in this ADR.** The
known limitation is documented in the function header's "Known
limitation" comment (lines 195–198 of the source as of 2026-09-21)
and re-flagged here as a deferred Q1 2027 concern. Future fixes
(e.g. POSIX shared-memory semaphore between processes, or a per-chain
named mutex via `flock(2)`) belong in a separate ADR-009.b.

## Out of scope (intentionally deferred)

- **flock-based cross-process lock.** Would close the actual race window
  rather than pin it. Worth ~50 LOC + careful error-path design (current
  `withNapiAppendLock` is in-process; the flock version would need to
  coexist). Out of scope for the regression test ADR.
- **Fault injection on the production code path.** `task-queue-wal.test.ts`
  already uses a `faultInject` constructor option pattern; we could mirror
  that for `writeBlockAtomic` to deterministically trigger a partial flush.
  Decided NOT to do so here because the fork-based test is process-level
  (what the bug actually was) rather than syscall-level (what a fault
  injection would simulate). When the flock fix lands in ADR-009.b, the
  race test continues to be the integration signal.
- **Linux-only crash-test for the kernel-level rename collision.** The
  POSIX guarantee is weak enough that this is genuinely flaky; pinning
  via flock (ADR-009.b) is cleaner than chasing the kernel.

## Decision log

Pending operator review. Branch: `fix/adr-009-writeblock-process-race`.
Helper: `tests/helpers/concurrent-writer.mjs`. Test: `tests/integration/
writeblock-process-race.test.ts`.
