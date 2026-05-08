# Shutdown lifecycle

Canonical reference for how Memphis shuts down cleanly and the invariants that keep it that way.

**Status as of 2026-04-29**: SEGV-on-shutdown closed. 30/30 stress baseline clean (20 mcp serve + 10 full daemon). See `tests/integration/shutdown-segv-stress.test.ts`.

## Sequence (full daemon `memphis serve`)

`installShutdownHandlers` from `src/infra/runtime/graceful-shutdown.ts:369` registers persistent SIGTERM and SIGINT handlers. On signal, `performGracefulShutdown` (`graceful-shutdown.ts:162`) runs:

| Step | What | Why |
|---|---|---|
| 1 | Audit `system.shutdown.signal` | Non-repudiable record that the runtime received the signal — survives even if the rest of the sequence fails. |
| 2 | `signalDrain` + `waitForDrain(drainTimeoutMs)` | Aborts in-flight turn controllers and waits up to `MEMPHIS_SHUTDOWN_DRAIN_TIMEOUT_MS` (default 15s). Drain success vs. timeout decides exit code. |
| 3 | `Promise.all(stopFns)` with per-stopper timeout | Stops background loops (HTTP server, watchdog, scheduler, reflection, backup, channel gateway). One hung stopper does not block the whole shutdown — it logs and proceeds. |
| 4 | Final PULSE heartbeat | Continuity: PULSE history shows healthy/degraded as the last heartbeat. |
| 5 | `shutdownOtel()` | Flush pending OTel spans before the SDK is gone. |
| 5.5 | `embed_shutdown()` via `resolveEmbedShutdown` | Releases the only Rust process-static with a non-trivial Drop (`EMBED_PIPELINE`). Must run before V8 teardown to avoid the original Bug 3 SEGV race. |
| 5.6 | `flushAllPinoStreamsSync()` | Flushes all sonic-boom log destinations. Order matters: after `embed_shutdown` (which itself logs), before `exitFn` (which triggers V8 teardown of the FDs). |
| 6 | `exitFn(drained ? 0 : 75)` | Clean drain → 0. Timeout → 75 (EX_TEMPFAIL) so the supervisor restarts. |

The lighter `mcp serve` path (`src/infra/cli/commands/mcp.ts:208-224`) does **not** run this sequence — it just flips a `stopRequested` flag and lets the HTTP server close. Operators using `memphis serve` get the full sequence; operators using only `mcp serve` rely on V8's natural teardown plus whatever the HTTP server's own close routine does.

## Process-static state inventory (Rust crates)

The only `static OnceLock<Mutex<…>>` / `lazy_static!` in Rust crates with a non-trivial `Drop`:

| Static | Crate | Cleanup | Test |
|---|---|---|---|
| `EMBED_PIPELINE: OnceLock<Mutex<EmbedPipeline>>` | `crates/memphis-napi/src/lib.rs:69` | `embed_shutdown()` (`lib.rs:493-505`) | `embed_shutdown_is_idempotent_and_handles_uninitialized` (`lib.rs:781-795`) |

`Vault` (`crates/memphis-vault/src/vault.rs:12-15`) and `CaseIndex` (`crates/memphis-case-index/src/lib.rs:67-69`) are constructed per call and dropped per call — no static state requiring explicit shutdown.

If you add a new `static` with a non-trivial Drop, follow the invariant below.

## Invariant (rules to add a new static or shutdown step)

1. **Pair every non-trivial static with a shutdown export.** Each new `static OnceLock<Mutex<…>>` or `lazy_static!` in a Rust crate whose drop touches I/O, file descriptors, or NAPI environment state must have a matching `#[napi(js_name = "<thing>_shutdown")]` export. Pattern: `crates/memphis-napi/src/lib.rs:493-505`.
2. **Idempotent + failure-tolerant.** The export must succeed when called twice in a row, and must succeed when the static was never initialized (return a JSON envelope with `was_initialized: false`). Test pattern: `crates/memphis-napi/src/lib.rs:781-795`.
3. **Wire the call before pino flush.** Add a step in `performGracefulShutdown` (`src/infra/runtime/graceful-shutdown.ts:287-308`) that mirrors `resolveEmbedShutdown` — dynamic NAPI bridge resolver, log on failure, never throw. The new step must run **after** OTel shutdown and **before** `flushAllPinoStreamsSync` so the static's Drop completes while log streams are still alive to record any failure.
4. **Cover the lifecycle in the stress test.** If the new static is engaged on `mcp serve` boot or full-daemon boot, the existing 30/30 stress baseline already exercises its drop. If it is engaged only via a specific tool path, extend `tests/integration/shutdown-segv-stress.test.ts` to drive that path before SIGTERM.

## Test pattern

Stress test: `tests/integration/shutdown-segv-stress.test.ts`. Env-gated `MEMPHIS_SEGV_STRESS=1`. Two paths:
- `mcp serve --transport http` × 20: regression guard against new statics being engaged in this lighter path.
- `memphis serve` (full bootstrap) × 10: exercises `performGracefulShutdown` end-to-end.

Run locally:

```bash
MEMPHIS_SEGV_STRESS=1 npx vitest run tests/integration/shutdown-segv-stress.test.ts
```

Asserts `exit code !== 139 && signal !== 'SIGSEGV'` per iteration. Default test runs skip it (1 file skipped, 1 test skipped).

## Operator-facing env vars

| Var | Default | Effect |
|---|---|---|
| `MEMPHIS_SHUTDOWN_DRAIN_TIMEOUT_MS` | 15000 | How long to wait for in-flight turns before exiting with code 75. |

The per-stopper timeout (5000 ms) is a code constant `DEFAULT_STOPPER_TIMEOUT_MS` in `graceful-shutdown.ts` and not exposed as an env var today. Add one if a single hung stopper is observed in production.

## Recommended nightly schedule

To catch lifecycle regressions before they reach a release, register the stress test as a nightly schedule on any host running Memphis as a service:

```bash
memphis schedule add \
  --type shell \
  --cron "0 3 * * *" \
  --name "nightly-shutdown-stress" \
  --value "cd /path/to/memphis && MEMPHIS_SEGV_STRESS=1 npx vitest run tests/integration/shutdown-segv-stress.test.ts"
```

The test takes ~40 seconds and is harmless — fresh tmpdir per iteration, no chain or vault writes against the operator's data.

## Track B: residual race — layered defence (issue #270)

The original Sprint 2.3 fix (PR #333) closed the race for the **runtime path** (`memphis serve`, `mcp serve`) that goes through `performGracefulShutdown`. PR #424 added `installNapiShutdownGuard` for the **script path** (one-shot tools, `tsx`-spawned scripts, vitest worker forks) so the same `embed_shutdown` + `pino flush` sequence runs on plain V8 process exit.

That reduced but did not fully eliminate the SEGV rate on the script path — the rare residual case manifested as `Worker forks emitted error` in vitest CI runs (~1 per full-suite) and `1/10 SEGV` in `script-shutdown-segv-stress.test.ts`. Per `BUG3-SEGV-INVESTIGATION.md` Hypothesis 2 / 3, the suspected source was V8↔Rust ordering during cdylib unload — Rust statics' implicit Drop runs late enough that libc thread-local-storage cleanup or the global allocator's bookkeeping is in transient state.

The principle for the fix: **graceful-by-default, hard-exit only as documented last-resort**. Track B is designed in two layers so we don't reach for `_exit(2)` unless the graceful path is empirically known broken on a specific surface.

### Layer 1 (primary, always on) — Rust-side Drop barrier

Owner: `crates/memphis-embed/src/pipeline.rs`.

A process-wide `AtomicBool SHUTDOWN_BARRIER` is armed by `set_shutdown_barrier()`, which `embed_shutdown()` calls at the end of its body (NAPI crate). When the barrier is set, `impl Drop for EmbedPipeline` swaps the heap-heavy fields (`docs: HashMap<…>`, `provider: Box<dyn>`) for empty/sentinel placeholders and `mem::forget`s the originals. The implicit Drop of the static at `dlclose` time then becomes a cheap no-op — no HashMap bucket free, no provider Box free, no race against a teardown-state allocator. Heap is reclaimed by the OS at process termination.

This is **defence in depth, always active**: it adds zero overhead during normal use (the AtomicBool check happens once per Drop), and it costs the runtime nothing because by the time the barrier fires, persistence has already been drained via `pipeline.clear()`. Tests that explicitly construct + drop an EmbedPipeline within the same process keep the normal Drop semantics — `__reset_shutdown_barrier_for_tests()` clears the flag between cases.

The **invariant**: any new process-wide static in memphis-* crates whose `Drop` touches the heap or syscalls should follow the same pattern — check `SHUTDOWN_BARRIER` and skip work that could race the libc/allocator teardown.

### Layer 2 (fallback, opt-in) — hard-exit for surfaces Layer 1 doesn't cover

Owner: `src/infra/runtime/napi-shutdown.ts`.

For paths that load the bridge but never initialise the embed pipeline (one-shot scripts that don't call `embed_store`), Layer 1's Drop handler never runs because the static is `OnceLock::None`. The residual SEGV on these paths is suspected to live in napi-rs internals or libc atexit ordering — we can't fix it from inside our crate. For those specific surfaces only, the auto-installed shutdown guard offers an opt-in `MEMPHIS_NAPI_HARD_EXIT=1` that, after our normal `embed_shutdown` + pino flush complete on the `'exit'` event, calls `process.reallyExit(process.exitCode ?? 0)`. That routes straight to the kernel's `_exit(2)` syscall — Node skips cdylib unload, the race has no surface.

Where Layer 2 is opted in:

- **`tests/integration/script-shutdown-segv-stress.test.ts`** runner subprocess — the 10/10 SEGV-free baseline is the post-Track-B regression check for this surface.

Where Layer 2 is **NOT** opted in (deliberate):

- **`vitest.config.ts`** — vitest worker forks are long-lived (one process runs many test files in sequence). Calling `reallyExit()` mid-suite makes the pool surface "Worker forks emitted error" because the worker disappears before the job-queue drains. The worker teardown keeps the Track A `dangerouslyIgnoreUnhandledErrors` backstop, gated by `MEMPHIS_STRICT_VITEST_RACE` for diagnostic use.
- **Production runtimes (`memphis serve`, `mcp serve`)** — explicit graceful-shutdown sequence (drain, stoppers, OTel flush, embed_shutdown, pino flush, exitFn) preserves OTel state, IPC notifications, and file-write integrity. Hard-exit would skip those. Default off; operators can opt in per-script if their script genuinely has nothing to lose.
- **Operator ops scripts** (`memphis ops:*`, `npm run -s ops:*`) — default off. Operators with state worth preserving (in-flight IPC, deferred writes) keep the graceful path. Operators running scripts whose only side effect already completed (read-only diagnostics, e.g.) can opt in.

Trade-off summary for `_exit(2)`: skips libc atexit handlers, the global allocator's debug accounting, V8's GC final pass, and any deferred I/O the operator hasn't already flushed. We verified empirically that the only resources in scope at the moment Layer 2 fires are heap (reclaimed by OS) and FDs (reclaimed by OS); persistence has already drained via `pipeline.clear()`. Calling Layer 2 from a path with deferred work would be a regression — that's why it's opt-in per surface.

### Escape hatches (documented inline in source)

If a future Node release drops `process.reallyExit`, or one of the layers produces unexpected behaviour, two env knobs exist:

- `MEMPHIS_STRICT_VITEST_RACE=1` — disables the Track A `dangerouslyIgnoreUnhandledErrors` swallow so the worker race resurfaces for diagnostic capture.
- `MEMPHIS_LEGACY_SEGV_TOLERANCE=1` — re-enables the previous 1-of-10 stress threshold (pre-Track-B) for environments where Layer 2 isn't viable.

Plus the test-only `__reset_shutdown_barrier_for_tests()` for Layer 1 (Rust crate, `cfg(test)`) so unit tests that explicitly arm-then-drop don't pollute siblings.

### Decision: when is hard-exit acceptable?

A short rubric, applied to every new caller of `MEMPHIS_NAPI_HARD_EXIT`:

| Question | Yes → Layer 2 OK | No → Stay on graceful |
|---|---|---|
| Is the surface a one-shot process (no recycle, no IPC mid-job)? | ✓ |  |
| Has all persistence-relevant work completed before exit? | ✓ |  |
| Is OTel / observability data already flushed (or not used here)? | ✓ |  |
| Does the operator expect to inspect coverage / leak data after exit? |  | ✗ |
| Does the path own user-visible IPC connections (Telegram, MCP, HTTP)? |  | ✗ |

If any "No" question lands on the right column, the path stays graceful. Layer 1 is the always-on defence; Layer 2 is the carefully-chosen exception.

## History

- 2026-04-22 — Bug 3 investigation (`BUG3-SEGV-INVESTIGATION.md`). Hypothesis: race between V8 atexit and `EmbedPipeline` Mutex / static Drop. Fix proposed but deferred to Q2.
- Sprint 2.3 (PR #333) — `embed_shutdown` Rust export added, `resolveEmbedShutdown` bridge wired into `performGracefulShutdown` step 5.5; pino flush added as step 5.6 to catch sonic-boom destinations holding lines past SIGTERM.
- 2026-04-29 (PR #340) — stress test added; 30/30 clean baseline on main `259fbec`. Phase 1 audit confirmed `EMBED_PIPELINE` is the only static with non-trivial Drop. Issue #270 closed evidence-driven (runtime-path variant).
- 2026-05-04 (PR #424) — `installNapiShutdownGuard` auto-attaches on bridge load; closes the script-path variant of #270 down to ~1/10 residual rate.
- 2026-05-08 (PR #528, Track A) — race-tolerance gates in `vitest.config.ts` + `script-shutdown-stress` while Track B was being designed.
- 2026-05-08 evening (PR #533, Track B initial) — `MEMPHIS_NAPI_HARD_EXIT=1` opt-in landed as a single-layer hard-exit fallback.
- 2026-05-08 evening (PR TBD, Track B layered) — Layer 1 added: Rust-side `SHUTDOWN_BARRIER` + `impl Drop for EmbedPipeline` so the primary defence is always-on and graceful-by-default. Layer 2 (hard-exit) reduced to a documented opt-in fallback for the script-spawn surface that Layer 1 doesn't cover. Production runtime stays graceful. The "graceful-by-default, hard-exit-as-last-resort" rubric is articulated above.
