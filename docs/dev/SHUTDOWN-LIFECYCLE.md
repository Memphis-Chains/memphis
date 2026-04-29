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

## History

- 2026-04-22 — Bug 3 investigation (`BUG3-SEGV-INVESTIGATION.md`). Hypothesis: race between V8 atexit and `EmbedPipeline` Mutex / static Drop. Fix proposed but deferred to Q2.
- Sprint 2.3 (PR #333) — `embed_shutdown` Rust export added, `resolveEmbedShutdown` bridge wired into `performGracefulShutdown` step 5.5; pino flush added as step 5.6 to catch sonic-boom destinations holding lines past SIGTERM.
- 2026-04-29 (PR #340) — stress test added; 30/30 clean baseline on main `259fbec`. Phase 1 audit confirmed `EMBED_PIPELINE` is the only static with non-trivial Drop. Issue #270 closed evidence-driven.
