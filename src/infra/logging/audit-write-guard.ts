/**
 * Audit-write guard — refuses live audit/system-chain writes from tests
 * unless the test explicitly opts in.
 *
 * Why this exists: 2026-05-12 block 1853 incident. A `self_modify`-style
 * test escaped sandbox isolation and appended a `self_modify.committed`
 * audit event (sessionId="sess-1", commitHash="abc123" — obvious test
 * fixtures) to the production `~/.memphis/chains/system/`. The
 * resulting prev_hash mismatch corrupted the chain at block 1853 and
 * fires an integrity warning on every subsequent scan. The fallback
 * audit log absorbed the failed append so production audit wasn't
 * lost, but the chain itself now carries a forensic scar.
 *
 * Forensic doc: notes/system-chain-corruption-2026-05-12.md
 *
 * Guard policy:
 *   - When `VITEST=true` (set automatically by vitest), every
 *     audit-write call site checks `isAuditWriteAllowed`.
 *   - Default verdict in VITEST: **deny**. The call site decides what
 *     to do — `writeSecurityAudit` early-returns silently;
 *     `emitRuntimeSecurityEvent` early-returns silently; `appendBlock`
 *     for `system` / `security` chains THROWS so callers that
 *     forgot to mock get a clear failure signal.
 *   - Tests that legitimately need audit writes (integration tests
 *     exercising the full chain path) set
 *     `MEMPHIS_TEST_ALLOW_AUDIT_WRITE=1` in their `beforeEach`. Use
 *     a tmpdir `MEMPHIS_HOME` so the writes land in throwaway state,
 *     not the operator's real `~/.memphis/`.
 *
 * Production code paths (no `VITEST` set) are never guarded — the
 * guard is purely test-isolation.
 */

let warnedContexts = new Set<string>();

export function isAuditWriteAllowed(rawEnv: NodeJS.ProcessEnv = process.env): boolean {
  // Outside vitest, audit-write is always allowed. The guard is a
  // test-isolation tool, not a runtime feature gate.
  if (rawEnv.VITEST !== 'true') return true;
  const allow = (rawEnv.MEMPHIS_TEST_ALLOW_AUDIT_WRITE ?? '').trim().toLowerCase();
  return allow === '1' || allow === 'true' || allow === 'on';
}

/**
 * One-shot stderr warning when an audit write is skipped. Throttled
 * per-context-string to keep the test output readable (a single
 * leaking suite would otherwise spam thousands of warnings).
 */
export function emitAuditWriteGuardWarning(context: string): void {
  if (warnedContexts.has(context)) return;
  warnedContexts.add(context);
  process.stderr.write(
    `[audit-guard] skipped audit write (${context}) — running under VITEST without ` +
      `MEMPHIS_TEST_ALLOW_AUDIT_WRITE=1. If this is an integration test that legitimately ` +
      `needs to write audit/system chain blocks, set the env in beforeEach and use a tmpdir ` +
      `MEMPHIS_HOME. Forensic note: notes/system-chain-corruption-2026-05-12.md\n`,
  );
}

/** Test seam — reset throttle (used by guard's own unit tests). */
export function resetAuditWriteGuardWarnings(): void {
  warnedContexts = new Set<string>();
}

/**
 * Throwing variant for callers (like `appendBlock` on system/security
 * chains) where a silent skip would leave the caller with an
 * undefined result and a downstream crash. Throws an Error the
 * standard try/catch absorbs in `emitRuntimeSecurityEvent`; direct
 * callers see a clear failure with the same remediation message.
 */
export function assertAuditWriteAllowed(
  context: string,
  rawEnv: NodeJS.ProcessEnv = process.env,
): void {
  if (isAuditWriteAllowed(rawEnv)) return;
  throw new Error(
    `[audit-guard] refused audit write (${context}) — VITEST=true and ` +
      `MEMPHIS_TEST_ALLOW_AUDIT_WRITE is not set. If this is an integration test ` +
      `that legitimately needs audit/system chain writes, set ` +
      `MEMPHIS_TEST_ALLOW_AUDIT_WRITE=1 + use a tmpdir MEMPHIS_HOME. ` +
      `See notes/system-chain-corruption-2026-05-12.md`,
  );
}
