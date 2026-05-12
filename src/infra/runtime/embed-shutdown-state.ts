/**
 * Process-wide flag indicating whether `embed_shutdown()` has been
 * called on the Rust NAPI bridge. Two independent code paths can fire
 * the call:
 *
 *   1. `graceful-shutdown.ts` step 5.5 — runs from the SIGTERM /
 *      explicit-stop path before V8 begins releasing the NAPI env.
 *   2. `napi-shutdown.ts` `beforeExit` / `exit` handler — last-resort
 *      safety net for natural-exit or `process.exit()` paths the
 *      graceful path didn't cover.
 *
 * If BOTH fire in sequence (graceful shutdown → process.exit() →
 * beforeExit listener), the second call lands AFTER V8 has started
 * unmapping the cdylib that owns the `EMBED_PIPELINE` static. Reading
 * the OnceLock's internal atomic state then dereferences a freed
 * page → SIGSEGV with the stack signature documented in
 * `notes/segv-rca-2026-05-12.md` (NULL `Once::is_completed` →
 * `AtomicU32::load` at offset 0x0).
 *
 * This module is the synchronization point: whichever caller fires
 * first marks the flag; the other checks the flag and skips its own
 * call. The Rust side is already idempotent + arms a shutdown barrier
 * after the first invocation, so the only thing we need to prevent is
 * the second invocation reaching a torn-down cdylib.
 *
 * The flag lives in module scope (process-wide). It is intentionally
 * NOT exposed via env or persisted to disk — embed shutdown is a
 * one-shot per-process operation; restarting the daemon resets the
 * flag with the rest of the module.
 */

let embedShutdownCalled = false;
let embedShutdownCaller: string | undefined;

export function markEmbedShutdownCalled(caller: string): void {
  embedShutdownCalled = true;
  embedShutdownCaller = caller;
}

export function hasEmbedShutdownRun(): boolean {
  return embedShutdownCalled;
}

export function getEmbedShutdownCaller(): string | undefined {
  return embedShutdownCaller;
}

/** Test-only: reset the flag between cases. Production never calls this. */
export function __resetEmbedShutdownStateForTests(): void {
  embedShutdownCalled = false;
  embedShutdownCaller = undefined;
}
