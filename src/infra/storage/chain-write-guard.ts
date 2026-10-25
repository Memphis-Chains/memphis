/**
 * Live-chain write guard — refuses chain writes that would land in the
 * operator's real runtime directory while running under VITEST.
 *
 * Why this exists: 2026-10-24 incident. `tests/unit/chain-integrity.test.ts`
 * passed a rawEnv that carried `RUST_CHAIN_ENABLED: 'false'` but no
 * `MEMPHIS_DATA_DIR`, so the chain adapter fell back to the default
 * `~/.memphis` and appended fixture blocks (`one`, `two`, `cli-check`) to
 * the operator's LIVE journal chain. 98 such blocks accumulated between
 * 2026-10-16 and 2026-10-24 — 58% of the journal chain was test litter.
 *
 * The audit-write guard (`audit-write-guard.ts`) already refused writes to
 * the `system`/`security` chains from VITEST. It deliberately left the
 * other chains unguarded, assuming tests mock the chain adapter. This
 * test called the real `appendBlock` instead, so nothing stopped it.
 *
 * Guard policy:
 *   - Outside VITEST: never interferes. This is a test-isolation tool.
 *   - Inside VITEST: a chain write is allowed only when the resolved
 *     chains directory lives under the OS temp directory. The isolated
 *     test runtime (`tests/helpers/isolated-runtime.ts`) points
 *     `MEMPHIS_DATA_DIR` at a `mkdtemp` directory, and every test that
 *     writes chains uses `mkdtempSync` too — so temp-dir is exactly the
 *     set of legitimate targets.
 *   - A test that genuinely needs to write outside temp opts in with
 *     `MEMPHIS_TEST_ALLOW_LIVE_CHAIN_WRITE=1`.
 *
 * The check runs against the RESOLVED chains directory, not the env map:
 * the env map is the thing that goes wrong (it omits MEMPHIS_DATA_DIR),
 * so trusting it would defeat the guard.
 */

import { tmpdir } from 'node:os';
import { resolve, sep } from 'node:path';

function isTruthy(value: string | undefined): boolean {
  const normalized = (value ?? '').trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'on';
}

/** True when `target` is inside the OS temp directory. */
export function isUnderTempDir(target: string): boolean {
  const resolvedTarget = resolve(target);
  const resolvedTmp = resolve(tmpdir());
  return (
    resolvedTarget === resolvedTmp ||
    resolvedTarget.startsWith(resolvedTmp.endsWith(sep) ? resolvedTmp : resolvedTmp + sep)
  );
}

/**
 * Throws when a VITEST process tries to write a chain outside the OS
 * temp directory. Call with the RESOLVED chains directory.
 */
export function assertChainWriteAllowed(
  chainsDir: string,
  rawEnv: NodeJS.ProcessEnv = process.env,
): void {
  if (rawEnv.VITEST !== 'true') return;
  if (isTruthy(rawEnv.MEMPHIS_TEST_ALLOW_LIVE_CHAIN_WRITE)) return;
  if (isUnderTempDir(chainsDir)) return;
  throw new Error(
    `[chain-write-guard] refused chain write to ${chainsDir} — running under VITEST and the ` +
      `resolved path is outside the OS temp directory (${resolve(tmpdir())}). A test wrote to the ` +
      `operator's LIVE chain. Set MEMPHIS_DATA_DIR to a mkdtemp directory, or set ` +
      `MEMPHIS_TEST_ALLOW_LIVE_CHAIN_WRITE=1 if the test genuinely needs it. ` +
      `Incident reference: 2026-10-24 journal chain pollution.`,
  );
}
