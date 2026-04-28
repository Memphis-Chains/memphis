import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    silent: 'passed-only',
    testTimeout: 15000,
    include: ['tests/**/*.test.ts'],
    exclude: ['.memphis-intake/**', 'reference/**', 'node_modules/**', 'dist/**'],
    env: {
      MEMPHIS_API_TOKEN: '',
      RUST_CHAIN_ENABLED: 'true',
      // Pin rate-limit defaults for deterministic test behavior regardless
      // of what the operator's local .env contains.
      MEMPHIS_RATE_LIMIT_SENSITIVE_MAX: '10',
      MEMPHIS_RATE_LIMIT_GLOBAL_MAX: '100',
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
    // Real fix is Track B (issue #270 — explicit teardown order in
    // graceful-shutdown / NAPI). Until then, the diagnostic stdout
    // capture above (Part 1) at least makes failures legible so we
    // can ship the rest of Track A alongside the worker race.
  },
});
