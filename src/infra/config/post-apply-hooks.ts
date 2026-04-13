/**
 * Post-apply hook registry for hot config reload.
 *
 * Sprint 6 shipped the `.env` → `process.env` swap engine but kept the
 * engine pure w.r.t. subsystems — caller responsibility to make
 * caches notice the change. That works for fields read fresh on every
 * use (e.g. `GEN_MAX_TOKENS`); it doesn't work for fields cached
 * inside long-lived service instances (e.g. `DEFAULT_PROVIDER` lives
 * inside `OrchestrationService` for the life of the process).
 *
 * This module gives subsystems a place to register a callback keyed
 * by env name. When `performHotReload` swaps that env, the registered
 * hook runs with `(oldValue, newValue, baseEnv)`. Hook errors are
 * caught and reported in the result; they never abort the swap.
 *
 * Bootstrap is the natural place to register: subsystems that own
 * cached env values call `registerPostApplyHook(...)` once, after they
 * construct, before the bot/HTTP/MCP surfaces start serving.
 */

export interface PostApplyHookContext {
  /** The env key whose value just changed in process.env. */
  key: string;
  /** Previous value (`undefined` if the key was unset). */
  previousValue: string | undefined;
  /** New value (`undefined` if the key was removed). */
  nextValue: string | undefined;
  /** Snapshot of `process.env` at the time the hook fires. */
  rawEnv: NodeJS.ProcessEnv;
}

export type PostApplyHook = (
  ctx: PostApplyHookContext,
) => void | Promise<void>;

export interface PostApplyHookOutcome {
  key: string;
  hookName: string;
  ok: boolean;
  error?: string;
}

interface RegistryEntry {
  hookName: string;
  hook: PostApplyHook;
}

/**
 * One env key can have multiple hooks (e.g. metrics + orchestration both
 * need to react to `DEFAULT_PROVIDER`). Registration order = invocation
 * order; a failing hook does not stop later ones from firing.
 */
const registry = new Map<string, RegistryEntry[]>();

export function registerPostApplyHook(
  envKey: string,
  hookName: string,
  hook: PostApplyHook,
): void {
  const bucket = registry.get(envKey) ?? [];
  bucket.push({ hookName, hook });
  registry.set(envKey, bucket);
}

export function listPostApplyHooks(): Array<{ key: string; hookNames: string[] }> {
  return [...registry.entries()].map(([key, entries]) => ({
    key,
    hookNames: entries.map((e) => e.hookName),
  }));
}

/** Test-only — clears every registered hook. */
export function clearPostApplyHooks(): void {
  registry.clear();
}

/** Test-only — drops hooks for a single key. */
export function unregisterPostApplyHooks(envKey: string): void {
  registry.delete(envKey);
}

export interface RunPostApplyHooksInput {
  /** Successfully-applied changes from the hot-reload engine. */
  changes: Array<{ key: string; oldValue?: string; newValue?: string }>;
  rawEnv?: NodeJS.ProcessEnv;
}

export async function runPostApplyHooks(
  input: RunPostApplyHooksInput,
): Promise<PostApplyHookOutcome[]> {
  const baseEnv = input.rawEnv ?? process.env;
  const outcomes: PostApplyHookOutcome[] = [];
  for (const change of input.changes) {
    const entries = registry.get(change.key);
    if (!entries || entries.length === 0) continue;
    for (const entry of entries) {
      try {
        await entry.hook({
          key: change.key,
          previousValue: change.oldValue,
          nextValue: change.newValue,
          rawEnv: baseEnv,
        });
        outcomes.push({ key: change.key, hookName: entry.hookName, ok: true });
      } catch (error) {
        outcomes.push({
          key: change.key,
          hookName: entry.hookName,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
  return outcomes;
}
