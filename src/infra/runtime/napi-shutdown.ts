/**
 * Auto-installed teardown guard for any process that loads the Memphis
 * NAPI bridge. Closes the issue #270 NEW variant where short-lived
 * tsx-spawned scripts (e.g. `npm run -s ops:export-incident-bundle`)
 * import a module that transitively loads `crates/memphis-napi/index.node`,
 * use the bridge, then exit through the standard Node teardown path
 * WITHOUT going through `performGracefulShutdown` from the runtime
 * server boot path. The original issue #270 fix (PR #333) wired
 * `embed_shutdown()` + `flushAllPinoStreamsSync()` into
 * `performGracefulShutdown` (which `memphis serve` and `mcp serve`
 * call), but scripts and tests don't reach that codepath. They rely
 * on V8 process exit to tear down everything — and the EmbedPipeline
 * `OnceLock<Mutex<…>>` plus pino's async sonic-boom destination can
 * race with FD invalidation, producing SIGSEGV exit codes (139).
 *
 * The PR8 vault path migration surfaced this: the full `tests/ops/`
 * run started reproducibly emitting 1-2 SEGV per 32-file run because
 * the new TS bridge import added one more codepath that loaded the
 * NAPI binary in those subprocesses. Reverting to keep paths.ts in
 * pure-TS (and parity-testing it) un-tripped the race, but the bug
 * is still there for any future caller.
 *
 * Fix: when `loadBridgeModule()` resolves the binary, register a
 * single-shot exit guard that invokes the same teardown sequence as
 * the runtime's `performGracefulShutdown`, just without the drain /
 * HTTP / OTel pieces (those don't apply to scripts).
 *
 * Idempotency: a module-level flag prevents duplicate registration
 * when multiple TS modules load the same bridge. Sibling consumers
 * (chain-adapter, vault-adapter, paths-bridge…) all share the same
 * `index.node`, so once is enough — and re-registering would attach
 * N handlers that all race on the same EmbedPipeline mutex.
 *
 * Test seams: `__resetNapiShutdownGuardForTests()` clears the flag
 * + removes the registered handler so test-side reload cycles can
 * re-exercise the registration path.
 */

import {
  hasEmbedShutdownRun,
  markEmbedShutdownCalled,
} from './embed-shutdown-state.js';
import { flushAllPinoStreamsSync } from '../logging/pino.js';

let installed = false;
let cachedBeforeExit: ((...args: unknown[]) => void) | null = null;
let cachedExit: ((...args: unknown[]) => void) | null = null;

type BridgeModule = Record<string, unknown>;

interface NapiShutdownOptions {
  /**
   * Test seam: substitute for the bridge's `embed_shutdown` export.
   * Production callers leave this undefined; the resolver picks the
   * function off the bridge module itself.
   */
  embedShutdownFn?: () => void;
  /**
   * Test seam: substitute for `flushAllPinoStreamsSync`. Production
   * callers leave this undefined; we lazy-import the real flusher
   * so the guard module stays cheap to load (pino has heavy
   * transitive deps).
   */
  pinoFlushFn?: () => void;
  /**
   * Track B Layer 2: emergency hard-exit fallback.
   *
   * The primary defence against the V8↔Rust dlclose race lives in
   * the Rust crate (`crates/memphis-embed/src/pipeline.rs::SHUTDOWN_BARRIER`
   * + `impl Drop for EmbedPipeline`): once `embed_shutdown()` arms
   * the barrier, any subsequent Drop of an EmbedPipeline (including
   * the implicit Drop of the static at dlclose time) leaks heap-heavy
   * fields rather than freeing them through a teardown-state allocator.
   * That fix covers every path that initialises the embed pipeline.
   *
   * This option is the **fallback** for surfaces where the Rust-side
   * fix doesn't engage — most concretely, one-shot scripts that load
   * the bridge but never call `embed_store` (so the pipeline static
   * is never initialised, Drop never runs, and the residual SEGV is
   * suspected to live in napi-rs internals or libc atexit ordering).
   * When `hardExit` is true the guard's `'exit'` handler routes
   * through `process.reallyExit(0)` after our own teardown completes,
   * skipping cdylib unload entirely.
   *
   * Default: env-driven (MEMPHIS_NAPI_HARD_EXIT=1) — opt-in only.
   * Production runtimes stay graceful by default to preserve OTel /
   * IPC / file-write integrity. Tests and ops scripts that have
   * nothing to lose can opt in if the residual race is observed.
   *
   * Test seam: setting `false` here forces the graceful path even
   * if the env var is set, useful for tests that need the exit
   * handler to return rather than terminate.
   */
  hardExit?: boolean;
}

function isHardExitEnabled(options: NapiShutdownOptions): boolean {
  if (typeof options.hardExit === 'boolean') return options.hardExit;
  return process.env.MEMPHIS_NAPI_HARD_EXIT === '1';
}

/**
 * Best-effort sync exit handler. Runs on `beforeExit` AND `exit` so we
 * cover both clean returns (event loop drained) and explicit
 * `process.exit(code)` calls.
 *
 * Cleanup steps (embed_shutdown + pino flush) run at most once across
 * both events via the `cleanupRan` flag — repeating them is a no-op
 * for embed_shutdown (idempotent) but pointless for pino.
 *
 * Hard-exit (MEMPHIS_NAPI_HARD_EXIT=1) is honoured ONLY on the `exit`
 * phase, never `beforeExit`. Codex Round 2 #542 caught the regression
 * Round 1 introduced: calling `reallyExit` from `beforeExit` cuts off
 * any subsequent `beforeExit` listener registered after our install,
 * losing operator-registered final-state writes. Round 1 #533 (natural
 * exits not reaching the hard-exit branch) is fixed differently: when
 * cleanupRan is true and we're on `'exit'` with hardExit enabled, the
 * early-return path also fires reallyExit. So:
 *
 *   - Natural exit path:
 *     1. event loop drains → beforeExit fires
 *     2. our handler: cleanup ran=false; embed_shutdown + pino flush;
 *        eventName==='beforeExit' so SKIP reallyExit (lets other
 *        beforeExit listeners run)
 *     3. all beforeExit listeners drain
 *     4. exit fires
 *     5. our handler: cleanupRan=true; eventName==='exit' &&
 *        hardExit → attemptReallyExit() → terminates via _exit(2)
 *
 *   - Explicit process.exit(code) path:
 *     1. exit fires (no beforeExit)
 *     2. our handler: cleanupRan=false; embed_shutdown + pino flush;
 *        eventName==='exit' && hardExit → attemptReallyExit()
 *
 * Both end with reallyExit when hardExit enabled; neither cuts off
 * other beforeExit listeners.
 */
function buildHandler(
  bridge: BridgeModule,
  options: NapiShutdownOptions,
): (eventName: 'beforeExit' | 'exit') => void {
  let cleanupRan = false;
  return function memphisNapiShutdownGuard(eventName: 'beforeExit' | 'exit'): void {
    if (cleanupRan) {
      // Cleanup already ran — natural-exit case: beforeExit ran our
      // cleanup, exit follows. If hard-exit is enabled, terminate now
      // via _exit(2) to skip the cdylib unload race. (Other exit
      // listeners registered before us already ran in registration
      // order; later ones are sacrificed — the trade-off documented
      // in docs/dev/SHUTDOWN-LIFECYCLE.md Layer 2 rubric.)
      if (eventName === 'exit' && isHardExitEnabled(options)) {
        attemptReallyExit();
      }
      return;
    }
    cleanupRan = true;
    // 1. Tell the Rust EmbedPipeline to release its global Mutex
    //    BEFORE the V8 isolate tears down the napi env. Skipping this
    //    is the original issue #270 SEGV signature.
    //
    // Temat 2 dedup (2026-05-12): if `graceful-shutdown.ts` step 5.5
    // already called embed_shutdown, skip the second invocation.
    // Without this guard the duplicate call lands AFTER V8 has begun
    // unmapping the cdylib (graceful-shutdown finished → process.exit
    // → beforeExit listener fires → cdylib partially gone) and
    // OnceLock::is_completed dereferences a freed page → SIGSEGV.
    // See notes/segv-rca-2026-05-12.md for the full stack trace.
    // The Rust side is already idempotent for back-to-back calls, but
    // the bug is the underlying memory being freed BETWEEN them.
    try {
      if (hasEmbedShutdownRun()) {
        // graceful-shutdown.ts already drained the pipeline; skip.
      } else {
        const embedShutdown =
          options.embedShutdownFn ??
          (typeof bridge.embed_shutdown === 'function'
            ? (bridge.embed_shutdown as () => void)
            : undefined);
        if (embedShutdown) {
          embedShutdown();
          markEmbedShutdownCalled('napi-shutdown:beforeExit');
        }
      }
    } catch {
      // Swallowed — the guard runs at exit; surfacing here would
      // bypass the second step that has nothing to do with the embed
      // crate's state.
    }
    // 2. Flush pino sonic-boom destinations. Without this, log lines
    //    queued in the async backend try to fsync() FDs the V8
    //    teardown is in the middle of invalidating.
    try {
      const pinoFlush = options.pinoFlushFn ?? flushAllPinoStreamsSync;
      pinoFlush();
    } catch {
      // Pino flushing failure is never worth crashing exit. The
      // operator gets the next-best signal: the not-yet-flushed log
      // lines simply don't appear, but the process exits cleanly.
    }
    // 3. Track B: hard-exit override (Codex Round 2 #542 refinement).
    //    Only honoured on `'exit'`. When this path fires from
    //    `beforeExit`, we DO NOT call reallyExit — that would cut off
    //    operator-registered beforeExit listeners that haven't run yet
    //    (registered after our install land later in the listener
    //    queue). Instead we let beforeExit drain naturally; `exit`
    //    fires after, hits the cleanupRan-true branch above, and
    //    THERE we call attemptReallyExit().
    //
    //    For explicit `process.exit(code)` callers, no beforeExit
    //    happens — exit fires directly, this branch reaches
    //    attemptReallyExit() on first invocation, eventName==='exit'.
    if (eventName === 'exit' && isHardExitEnabled(options)) {
      attemptReallyExit();
    }
  };
}

/** Helper to call process.reallyExit if available; no-op otherwise. */
function attemptReallyExit(): void {
  try {
    type ProcessWithReallyExit = NodeJS.Process & { reallyExit?: (code?: number) => void };
    const reallyExit = (process as ProcessWithReallyExit).reallyExit;
    if (typeof reallyExit === 'function') {
      // process.exitCode is `string | number | null | undefined` —
      // narrow to a numeric exit code, defaulting to 0.
      const rawCode = process.exitCode;
      const code = typeof rawCode === 'number' ? rawCode : 0;
      reallyExit.call(process, code);
      // `reallyExit` doesn't return — but the type-system can't
      // know that, so this line is unreachable at runtime.
    }
  } catch {
    // Fall through to normal exit if reallyExit isn't available
    // on this Node version.
  }
}

/**
 * Attach the exit guard. Safe to call repeatedly: only the FIRST call
 * registers handlers; subsequent calls are no-ops. Returns whether
 * registration happened on this call (true on first, false on later).
 */
export function installNapiShutdownGuard(
  bridge: BridgeModule | null,
  options: NapiShutdownOptions = {},
): boolean {
  if (installed || !bridge) return false;
  const handler = buildHandler(bridge, options);
  // Wrap the handler so we don't accidentally hand the bound `this`
  // (or the listener-array slot) to any later caller of removeListener.
  // Also pass the event name so the handler can apply the hard-exit
  // override only on the final 'exit' phase (see buildHandler docs).
  cachedBeforeExit = (): void => handler('beforeExit');
  cachedExit = (): void => handler('exit');
  process.on('beforeExit', cachedBeforeExit);
  process.on('exit', cachedExit);
  installed = true;
  return true;
}

/**
 * Test-only: clear the installed flag and remove the registered
 * handlers so a test can re-exercise the registration path. Production
 * code never calls this — there is exactly one bridge per process.
 */
export function __resetNapiShutdownGuardForTests(): void {
  if (cachedBeforeExit) {
    process.off('beforeExit', cachedBeforeExit);
    cachedBeforeExit = null;
  }
  if (cachedExit) {
    process.off('exit', cachedExit);
    cachedExit = null;
  }
  installed = false;
}

/**
 * Test-only: read the current registration flag for assertions.
 */
export function __isNapiShutdownGuardInstalled(): boolean {
  return installed;
}
