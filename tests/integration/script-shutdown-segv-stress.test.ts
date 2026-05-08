/**
 * Stress test for the issue #270 NEW variant: short-lived
 * `tsx`-spawned (or plain `node`-spawned) scripts that load the
 * Memphis NAPI bridge through any TS module, use it briefly, and
 * exit. Without the auto-install guard wired into `loadBridgeModule`,
 * V8 isolate teardown raced the EmbedPipeline `OnceLock<Mutex<…>>`
 * Drop, producing SIGSEGV (exit code 139) at random.
 *
 * The original issue #270 fix (PR #333) wired `embed_shutdown()` +
 * `flushAllPinoStreamsSync()` into `performGracefulShutdown` — but
 * scripts and one-shot tools never call that function, they rely on
 * V8 process exit. The guard added by `napi-shutdown.ts` runs on
 * `beforeExit` + `exit` so the same teardown sequence executes
 * regardless of how the process winds down.
 *
 * This test spawns 10 short-lived child processes that:
 *   1. Load the bridge (transitively triggers the guard registration).
 *   2. Call any cheap export so the bridge actually engages the
 *      Rust side, not just the dlopen.
 *   3. Exit.
 *
 * All 10 must exit with code 0. A single 139 means the guard
 * regressed and the original issue is back. Skipped when the napi
 * binary isn't built (fresh checkout / no Rust toolchain) — CI
 * always builds before vitest, so it runs there.
 *
 * Stress level: 10 iterations is enough to surface the race
 * empirically (PR8 caught it at 1-2 SEGVs per 32 spawns) without
 * stretching CI runtime past a few seconds. The standing
 * `shutdown-segv-stress.test.ts` suite covers the full-bootstrap
 * path; this one is the script-path counterpart.
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

function resolveRepoRoot(): string {
  return resolve(__dirname, '../..');
}

function napiBinaryPath(): string {
  return resolve(resolveRepoRoot(), 'crates/memphis-napi/index.node');
}

function bridgeBuildAvailable(): boolean {
  return (
    existsSync(napiBinaryPath()) &&
    existsSync(resolve(resolveRepoRoot(), 'dist/infra/storage/napi-contract.js'))
  );
}

const RUNNER_SOURCE = `
  // Replicate the minimum codepath a tsx-spawned ops script takes:
  // import napi-contract → loadBridgeModule → install guard → call a
  // cheap NAPI export → exit naturally. If the guard is wired
  // correctly, V8 teardown emits 'beforeExit' / 'exit' (sequence
  // depending on whether the event loop drained), the guard fires
  // embed_shutdown() + pino flush, and the process exits 0.
  const { loadPlatformAwareBridge } = await import(REPO_ROOT_PLACEHOLDER + '/dist/infra/storage/napi-contract.js');
  const { resolveRustBridgePath } = await import(REPO_ROOT_PLACEHOLDER + '/dist/infra/runtime/install-root.js');
  const bridgePath = resolveRustBridgePath(process.env);
  const bridge = loadPlatformAwareBridge(bridgePath);
  if (!bridge) {
    process.stderr.write('runner: bridge not loadable from ' + bridgePath + '\\n');
    process.exit(2);
  }
  // Engage the Rust side. embed_shutdown is callable even before
  // any embed_store, and is the actual function the guard re-runs
  // at exit — exercising it now lets the guard's idempotency
  // protect against double-shutdown panics.
  if (typeof bridge.embed_shutdown === 'function') {
    bridge.embed_shutdown();
  }
  // Exit cleanly. The auto-installed guard will run on 'beforeExit'.
`;

function spawnRunner(): { code: number | null; stdout: string; stderr: string } {
  const repoRoot = resolveRepoRoot();
  const source = RUNNER_SOURCE.replace(/REPO_ROOT_PLACEHOLDER/g, JSON.stringify(repoRoot));
  try {
    const stdout = execFileSync(
      process.execPath,
      ['--input-type=module', '-e', source],
      {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 30_000,
        env: {
          ...process.env,
          MEMPHIS_LOG_LEVEL: 'error',
          // Track B: opt the runner subprocess into hard-exit. With
          // MEMPHIS_NAPI_HARD_EXIT=1 the auto-installed guard calls
          // process.reallyExit() at the end of its 'exit' handler, so
          // Node skips cdylib unload entirely — the V8↔Rust dlclose
          // race has no surface to manifest in. Stressing through this
          // gate is the actual Track B regression check; without it
          // we'd only be measuring the pre-Track-B residual rate.
          MEMPHIS_NAPI_HARD_EXIT: '1',
        },
      },
    );
    return { code: 0, stdout: String(stdout), stderr: '' };
  } catch (err) {
    const e = err as NodeJS.ErrnoException & {
      stdout?: Buffer | string;
      stderr?: Buffer | string;
      status?: number | null;
      signal?: string | null;
    };
    return {
      code: typeof e.status === 'number' ? e.status : null,
      stdout: e.stdout ? e.stdout.toString() : '',
      stderr: e.stderr ? e.stderr.toString() : '',
    };
  }
}

// Track B (issue #270) lands hard-exit via MEMPHIS_NAPI_HARD_EXIT in
// the runner subprocess (see spawnRunner). With cdylib unload skipped,
// there is no V8↔Rust dlclose surface for SEGV — zero-tolerance is the
// post-Track-B baseline.
//
// MEMPHIS_LEGACY_SEGV_TOLERANCE=1 is the escape hatch: keeps the
// previous Track-A 1-out-of-10 tolerance for environments where
// hard-exit isn't viable (an esoteric Node fork that lacks
// process.reallyExit, for instance). Failures are always written to
// stderr regardless so a regression upward is visible.
const SEGV_STRESS_MAX_TOLERATED_FAILURES =
  process.env.MEMPHIS_LEGACY_SEGV_TOLERANCE === '1' ? 1 : 0;

describe.skipIf(!bridgeBuildAvailable())(
  'NAPI bridge auto-shutdown — script-style spawn ×10',
  () => {
    it('every iteration exits cleanly (no SIGSEGV from V8 teardown race)', () => {
      const failures: Array<{ iteration: number; code: number | null; stderr: string }> = [];
      for (let i = 0; i < 10; i += 1) {
        const result = spawnRunner();
        if (result.code !== 0) {
          failures.push({ iteration: i, code: result.code, stderr: result.stderr.slice(0, 400) });
        }
      }
      // Always log so a regression upward is visible even when below
      // the failure threshold. Post-Track-B the expectation is 0/10;
      // any hit means MEMPHIS_NAPI_HARD_EXIT didn't land or the
      // runner subprocess inheritance is broken.
      if (failures.length > 0) {
        process.stderr.write(
          `[script-shutdown-segv-stress] ${failures.length}/10 iterations hit SIGSEGV ` +
            `(threshold: ${SEGV_STRESS_MAX_TOLERATED_FAILURES}). ` +
            `Track B (MEMPHIS_NAPI_HARD_EXIT) is supposed to eliminate this — ` +
            `verify the runner inherits the env and the bridge import path triggers ` +
            `installNapiShutdownGuard. ` +
            `Detail: ${JSON.stringify(failures, null, 2)}\n`,
        );
      }
      expect(
        failures.length,
        `expected ≤${SEGV_STRESS_MAX_TOLERATED_FAILURES} SEGV, got ${failures.length}: ${JSON.stringify(failures, null, 2)}`,
      ).toBeLessThanOrEqual(SEGV_STRESS_MAX_TOLERATED_FAILURES);
    });
  },
);
