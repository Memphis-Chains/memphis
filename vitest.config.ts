import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    silent: 'passed-only',
    // 15s was below what the I/O-bound suites actually need. doctor-v2
    // runs 12 full scans at ~6.5s each; cli.ask-session takes 11s alone.
    // On a 4-core host a 544-file run pushes both past 15s and they fail
    // on the clock, not on logic — they pass every time in isolation.
    // 30s keeps a genuine hang visible (it would still time out) while
    // leaving room for slower GitHub Actions runners (2 vCPU).
    testTimeout: 30000,
    include: ['tests/**/*.test.ts'],
    exclude: ['.memphis-intake/**', 'reference/**', 'node_modules/**', 'dist/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary', 'html'],
      reportsDirectory: 'coverage',
      exclude: ['tests/**', 'scripts/**', 'dist/**', '**/*.d.ts'],
      thresholds: {
        statements: 66,
        branches: 57,
        functions: 72,
        lines: 67,
      },
    },
    env: {
      MEMPHIS_API_TOKEN: '',
      RUST_CHAIN_ENABLED: 'true',
      // Pin rate-limit defaults for deterministic test behavior regardless
      // of what the operator's local .env contains.
      MEMPHIS_RATE_LIMIT_SENSITIVE_MAX: '10',
      MEMPHIS_RATE_LIMIT_GLOBAL_MAX: '100',
      // Operator .env must never reach the test suite. SLO_evaluator's
      // default threshold is 3000ms; a local `MEMPHIS_SLO_TURN_P99_MS=90000`
      // made evaluateSlos() read the operator's tuning and report 'pass'
      // for a span the test asserts must be 'fail'. Pin the values the
      // code defaults to, so a test asserts production defaults rather
      // than whatever this machine happens to be configured for.
      MEMPHIS_SLO_TURN_P99_MS: '3000',
      MEMPHIS_SLO_ERROR_RATE_MAX: '0.05',
      // Same class: durable-memory reads the surface consent default.
      // An operator-level `..._DEFAULT_CONSENT=exportable` overrode the
      // per-surface hint the test exercises (chat class → local-only).
      MEMPHIS_SURFACE_TELEGRAM_DEFAULT_CONSENT: 'local-only',
      MEMPHIS_DEFAULT_CONSENT: 'local-only',
      // NB: do NOT set MEMPHIS_NAPI_HARD_EXIT=1 here. Vitest worker
      // forks are long-lived (one process runs many test files in
      // sequence). If the auto-shutdown guard hard-exits the worker
      // when a single test file's `process.on('exit')` fires, vitest's
      // pool sees the worker disappear mid-job and reports "Worker
      // forks emitted error". The hard-exit knob is for genuine
      // one-shot scripts (npm run -s ops:..., test runner subprocesses
      // in tests/integration/script-shutdown-segv-stress.test.ts).
    },
    // Pool intentionally left as default (forks). We tried two
    // workarounds for the CI "Worker exited unexpectedly" race:
    //   1. forks + singleFork: serialised teardowns, but the race
    //      still triggered (so it's not parallelism — it's the
    //      teardown sequence itself, same surface as issue #270).
    //   2. pool: 'threads': worker_threads share the parent V8
    //      isolate (no fork() teardown race), BUT they also share
    //      `process.env`, and Memphis tests mutate env per-file
    //      (RUST_CHAIN_REQUIRE_SIGNATURES, RUST_CHAIN_SIGNER_KEY_HEX,
    //      MEMPHIS_VAULT_*). Cross-test pollution surfaced as
    //      `tests/integration/signed-block-gate.test.ts` failing
    //      with "promise resolved instead of rejecting" — the
    //      reject path needed env unset, but a sibling thread had
    //      set it. Threads is incompatible with current test code.
    //
    // Hard-exit (Track B) eliminates the dlclose race for one-shot
    // scripts but is incompatible with vitest's long-lived worker
    // forks. The worker teardown path keeps relying on the partial
    // mitigations from PR #353/#424 plus the narrow `onUnhandledError`
    // filter below.
    //
    // Codex Round 1 #528 caught the prior implementation gap: the
    // earlier `dangerouslyIgnoreUnhandledErrors: true` swallowed EVERY
    // unhandled error / rejection from the whole test run, not just
    // the post-test worker-exit race. A test that schedules a
    // rejected promise or crashes after its assertions could report
    // green in CI. The narrow `onUnhandledError` callback below only
    // suppresses the specific "Worker forks emitted error" /
    // "Worker exited unexpectedly" signature emitted by the vitest
    // pool when a worker fork's V8↔Rust dlclose race kills it
    // post-tests. Anything else propagates as a hard CI failure.
    //
    // Set MEMPHIS_STRICT_VITEST_RACE=1 to disable even the narrow
    // suppression when investigating a deeper Track B path
    // (e.g. NAPI v3 finalizer registration).
    onUnhandledError(error) {
      if (process.env.MEMPHIS_STRICT_VITEST_RACE === '1') {
        return true; // propagate everything in strict mode
      }
      const message = error?.message ?? '';
      const isPostTestPoolRace =
        message.includes('Worker exited unexpectedly') ||
        message.includes('Worker forks emitted error') ||
        message.includes('[vitest-pool]');
      // Returning `false` suppresses this single error; everything
      // else (return `true`) propagates as a normal CI failure.
      return !isPostTestPoolRace;
    },
  },
});
