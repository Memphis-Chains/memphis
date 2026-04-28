/**
 * Promise-based lazy singleton — fixes the TOCTOU race in `if (!instance)
 * instance = new X()` patterns.
 *
 * Sprint 1.2 (D1) closes the rustLoopAdapter race in
 * `src/gateway/agent-runtime.ts:37-55` and is the canonical helper that
 * sprint 2.1 (#271 scheduler/loop/vault) will reuse.
 *
 * The bug: Node.js single-threaded event loop does NOT prevent the race.
 * If `getX()` reads `instance`, awaits something (or yields between two
 * synchronous calls in the same tick of an async function), and writes
 * after, two concurrent async paths can both pass the null check before
 * either has finished initialization. The second instance silently
 * overwrites the first; tasks attached to the first are lost.
 *
 * The fix: store `Promise<Instance>` instead of `Instance | null`. Both
 * concurrent callers receive the same Promise; the factory runs exactly
 * once. Failure mode: factory rejection clears the cache so the next
 * caller can retry — without this, a transient init failure would
 * permanently brick the singleton.
 *
 * Usage:
 *   const getScheduler = lazySingleton(async () => createScheduler());
 *   await getScheduler(); // first caller triggers factory
 *   await getScheduler(); // second caller receives same instance
 */

export type LazySingleton<T> = {
  /** Resolve the cached instance, initializing on first call. */
  (): Promise<T>;
  /** Test-only: clear the cached promise so the factory re-runs. */
  reset: () => void;
  /** Inspect whether init has been attempted (cache populated). */
  isInitialized: () => boolean;
};

export function lazySingleton<T>(factory: () => Promise<T>): LazySingleton<T> {
  let cached: Promise<T> | null = null;

  const get = (): Promise<T> => {
    if (cached === null) {
      cached = factory().catch((err) => {
        // Clear cache on rejection so the next caller can retry.
        // Without this, a transient init failure (e.g. one-off NAPI
        // load error during a flaky boot) would brick the singleton
        // for the entire process lifetime.
        cached = null;
        throw err;
      });
    }
    return cached;
  };

  return Object.assign(get, {
    reset: (): void => {
      cached = null;
    },
    isInitialized: (): boolean => cached !== null,
  });
}
