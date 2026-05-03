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
}

/**
 * Best-effort sync exit handler. Runs on `beforeExit` AND `exit` so we
 * cover both clean returns (event loop drained) and explicit
 * `process.exit(code)` calls. Each side guards against the other
 * having already run via the module-level flag.
 */
function buildHandler(
  bridge: BridgeModule,
  options: NapiShutdownOptions,
): () => void {
  let alreadyRan = false;
  return function memphisNapiShutdownGuard(): void {
    if (alreadyRan) return;
    alreadyRan = true;
    // 1. Tell the Rust EmbedPipeline to release its global Mutex
    //    BEFORE the V8 isolate tears down the napi env. Skipping this
    //    is the original issue #270 SEGV signature.
    try {
      const embedShutdown =
        options.embedShutdownFn ??
        (typeof bridge.embed_shutdown === 'function'
          ? (bridge.embed_shutdown as () => void)
          : undefined);
      if (embedShutdown) {
        embedShutdown();
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
  };
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
  cachedBeforeExit = (): void => handler();
  cachedExit = (): void => handler();
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
