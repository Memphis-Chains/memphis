# Bug 3: SIGSEGV Investigation

> **RESOLVED 2026-04-29**. Forward-looking lifecycle doc + invariants live in [`SHUTDOWN-LIFECYCLE.md`](./SHUTDOWN-LIFECYCLE.md). Original fix landed in sprint 2.3 (PR #333: `embed_shutdown` export + pino flush). Empirical regression guard + 30/30 stress baseline added in PR #340. Issue #270 closed with evidence.

**Status:** Investigation complete — fix shipped
**Date:** 2026-04-22 (investigation), 2026-04-29 (closed)
**Severity:** P2 (intermittent, affects shutdown only)

## Observed Behavior

Occasional SIGSEGV during process shutdown. No SEGV handler installed — the process dies silently with exit code 139 (128 + 11).

## Architecture

```
Node.js process.exit()
  └─ V8 isolate teardown
      └─ GC collects NAPI externals
          └─ Rust NAPI addon statics (OnceLock<Mutex<EmbedPipeline>>)
              └─ RACE: Rust destructor vs V8 cleanup
```

### Key files

| File | Role |
|------|------|
| `crates/memphis-napi/src/lib.rs:69` | `static EMBED_PIPELINE: OnceLock<Mutex<EmbedPipeline>>` |
| `src/infra/runtime/graceful-shutdown.ts` | Hooks SIGTERM/SIGINT, drains, calls `process.exit()` |

### What exists

- **Graceful shutdown** (graceful-shutdown.ts): hooks SIGTERM/SIGINT, drains in-flight turns, stops background loops, flushes PULSE/OTel, then calls `process.exit()`.
- **No SIGSEGV handler** anywhere in the codebase.
- **No explicit Rust cleanup** before exit — `OnceLock` statics live for the process lifetime; Rust does not run `Drop` for statics.

### What does NOT exist

- No `shutdown()` export from the NAPI crate.
- No coordination between Node.js exit and Rust resource teardown.
- No `process.on('exit')` hook that cleans up the NAPI side.

## Root Cause Analysis

### Hypothesis 1: Concurrent Mutex access during exit (MOST LIKELY)

1. An `embed_store` or `embed_search` call acquires the `EMBED_PIPELINE` Mutex lock.
2. Mid-operation, a signal arrives and `performGracefulShutdown()` calls `process.exit()`.
3. V8's atexit handlers run, tearing down the NAPI runtime.
4. The Rust function still holds a reference to NAPI `Env` state that V8 just freed.
5. The Rust function tries to write to or read from freed V8 memory → SEGV.

Evidence: The `pipeline.lock()` calls at lines 368, 398, 462 are synchronous NAPI functions — Node's event loop is blocked while they execute. But `process.exit()` from a signal handler can interrupt the event loop between microtasks.

### Hypothesis 2: NAPI static destructor ordering

On some platforms, `OnceLock<Mutex<EmbedPipeline>>` static destructors run after V8's atexit handlers have freed the NAPI environment. If `EmbedPipeline::drop()` accesses any NAPI-registered resources (unlikely but not verified), it would SEGV.

### Hypothesis 3: EmbedPipeline persistence flush race

`EmbedPipeline` has persistence support (`EmbedPersistenceConfig`). If Drop or a background thread flushes the persistence file during teardown while the OS has already invalidated file descriptors or memory maps, this could SEGV.

## Proposed Fix (Q2)

### Step 1: Export `embed_shutdown()` from NAPI crate

```rust
// crates/memphis-napi/src/lib.rs

#[napi(js_name = "embed_shutdown")]
pub fn embed_shutdown() -> String {
    if let Some(pipeline_mutex) = EMBED_PIPELINE.get() {
        match pipeline_mutex.lock() {
            Ok(mut pipeline) => {
                pipeline.clear();
                // Persistence flush happens inside clear()
                ok(serde_json::json!({ "shutdown": true }))
            }
            Err(_) => err("embed_pipeline_lock_poisoned"),
        }
    } else {
        ok(serde_json::json!({ "shutdown": true, "was_initialized": false }))
    }
}
```

### Step 2: Call from graceful-shutdown.ts

Add to `performGracefulShutdown()` between step 4 (PULSE) and step 5 (OTel), before `exitFn()`:

```typescript
// Step 4.5: Release Rust NAPI resources before V8 teardown
try {
  const napi = await import('../../napi/memphis_napi.node');
  if (typeof napi.embed_shutdown === 'function') {
    napi.embed_shutdown();
  }
} catch {
  // NAPI not loaded or already cleaned up — safe to ignore
}
```

### Step 3: Consider OnceLock → Mutex<Option<>> pattern

For a cleaner shutdown, replace:
```rust
static EMBED_PIPELINE: OnceLock<Mutex<EmbedPipeline>> = OnceLock::new();
```
with:
```rust
static EMBED_PIPELINE: OnceLock<Mutex<Option<EmbedPipeline>>> = OnceLock::new();
```

This lets `embed_shutdown()` take ownership: `pipeline.take()` drops the `EmbedPipeline` entirely, not just clearing its index. Any subsequent NAPI calls return "pipeline not initialized" cleanly.

### Step 4: Install SIGSEGV handler for diagnostics

Even after the fix, install a handler for crash diagnostics:

```typescript
process.on('SIGSEGV' as any, () => {
  process.stderr.write('SIGSEGV caught — likely NAPI teardown race\n');
  process.exit(139);
});
```

Note: Node.js doesn't officially support catching SIGSEGV. A production alternative is `--abort-on-uncaught-exception` + core dump analysis, or using the `segfault-handler` npm package for stack traces.

## Risk Assessment

- **Frequency:** Low — only during shutdown, and only if an embed operation is in-flight at that exact moment.
- **Impact:** Process exits with 139 instead of 0. Supervisor restarts it. No data loss (chain writes are atomic; embed index is append-only).
- **Workaround:** The graceful shutdown drain window (default 15s) reduces the chance of concurrent access, but doesn't eliminate it for long-running embed operations.

## Decision

Fix deferred to Q2 Sprint 2 because:
1. The SEGV is intermittent and non-destructive (supervisor auto-restarts).
2. The fix requires Rust changes + rebuild of the NAPI addon.
3. Sprint 1 priority is the 7 nadpiski (N1-N7) which affect runtime correctness, not shutdown cleanliness.
