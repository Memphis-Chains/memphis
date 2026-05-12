# System chain corruption — 2026-05-12 ~18:20 UTC

## Symptom (live event 2026-05-12 21:21 local)

```
[memphis-security] chain append failed for security event
prompt.fragment.blocked: chain 'system' integrity check failed at
block 1853 (001853.json): prev_hash 754a7c32…9d1b ≠ previous block's
hash 4248ca68…cd62 — primary security-audit log unaffected
```

## Diagnosis

Block 1853 was written by **a test that escaped sandbox isolation** and
appended to the live system chain. Payload signature:

```json
{
  "action": "self_modify.committed",
  "status": "allowed",
  "details": {
    "sessionId": "sess-1",       // ← test fixture string
    "commitHash": "abc123",      // ← test fixture string
    "changedFiles": ["src/test.ts"],
    "branch": "evolve/1778610043943-test-change"
  }
}
```

Both `sessionId: "sess-1"` and `commitHash: "abc123"` are unit-test
fixture values. No real self-modify session would produce those.

The chain timestamps confirm the test ran during the burst window:

| Block | Timestamp (UTC) | Type |
|---|---|---|
| 1851 | 18:20:43.501Z | (production write) |
| 1852 | **18:20:45.369Z** | LLM call audit (production) |
| 1853 | **18:20:45.210Z** | **`self_modify.committed` fixture** (test) |
| 1854 | 18:20:45.738Z | (production write) |

Note 1853's timestamp is BEFORE 1852's — the test wrote with an older
read of the chain head, then the production write at 1852 overwrote
the slot 1853 thought was the previous head. Result: 1853's
`prev_hash` (754a7c32…9d1b — the hash of the chain head as the test
saw it) no longer matches 1852's actual hash (4248ca68…cd62).

Subsequent blocks 1854 → 1870 are internally consistent (each
correctly hash-links to its predecessor), but the chain has a single
break at the 1852→1853 boundary.

## Impact

- **Read-side integrity scans** flag block 1853 (this event fired the
  notification).
- **Write path:** new appends succeed; the error message says "primary
  security-audit log unaffected" — the daemon's fallback path keeps
  recording.
- **Forensic trail:** any future chain replay starting before block
  1853 will halt at the boundary unless the verifier is told to skip.

## Root cause

A `self_modify` unit test (likely from the `tests/unit/self-modify-*`
or `tests/unit/self-coding-*` suite) called the real chain append
function instead of a mocked one. The test was running while the
daemon was active, so writes raced.

Candidate suspects, in priority order:

1. `tests/unit/self-modify-lifecycle.test.ts` — exercises the full
   commit path with `self_modify.committed` audit emit
2. `tests/unit/self-modify-rawenv-threading.test.ts` — mocks soul
   manifest but may not mock `emitRuntimeSecurityEvent` → CaseChainAdapter
3. New tests added today: `tests/unit/self-modify-plan-aware.test.ts`,
   `tests/unit/self-coding-pr-open.test.ts`,
   `tests/unit/self-coding-deploy-verify.test.ts` — each uses a fake
   `sessionRepo` with `{ id: 'sess-1' }` matching the polluted block

The pattern `{ id: 'sess-1' }` is widely shared across these test
fixtures.

## Recovery options (operator decision required)

### A. Accept-and-mark (least destructive)
Add an explicit fork-marker block declaring the corruption + write a
verifier exception. Block 1853 stays. All subsequent blocks stay.
Future integrity scans skip-with-warning past 1853.

**Pros:** No history loss. Cheapest.
**Cons:** Permanent integrity warning in scan output.

### B. Truncate-and-replay
Drop blocks 1853–1870. Replay any production-relevant events from the
fallback audit log (if recoverable). Append a single "chain truncated
2026-05-12 due to test escape" block at position 1853.

**Pros:** Clean chain. Future scans pass.
**Cons:** Loses 17 blocks of audit. Some may be production events I
overwrite-merged into the test-polluted range.

### C. Reseat
Renumber: copy 1854–1870 to 1853–1869, recompute prev_hash on each
(cascades). Append a "renumbered after test escape" block at 1870.

**Pros:** Compact chain.
**Cons:** Every block's hash changes — invalidates any external
reference (audit replay, forensic snapshots, signed manifests).
**Risk:** if anything outside the chain has cached block 1854+ hashes,
those refs go stale silently.

### D. Defer (do nothing now)
Treat as ongoing structural debt. Daemon keeps working. Operator
revisits when there's bandwidth.

**Recommendation: A**, with **B as the upgrade path** if anyone ever
needs the chain to scan-clean for an external audit.

## Followup engineering — prevent recurrence

Whichever option above is chosen, this is the real fix:

1. Audit every `tests/unit/self-modify-*.test.ts` and
   `tests/unit/self-coding-*.test.ts` for direct calls into
   `CaseChainAdapter.appendCaseEntry` /
   `emitRuntimeSecurityEvent` without a sandboxed `MEMPHIS_CHAINS_DIR`.
2. Add a guard: `emitRuntimeSecurityEvent` should refuse to write
   when `process.env.VITEST === 'true'` and the chain target is the
   real `~/.memphis/chains/system/`, unless an explicit opt-in env
   is set (e.g. `MEMPHIS_TEST_ALLOW_REAL_CHAIN=1` for the rare
   integration test that needs it).
3. Re-run the suspect tests with strict-isolation enabled to confirm
   the test scope is the cause.

## State at time of writing

- Daemon: active, PID 324661, uptime ~1h25m
- System chain: 1870 blocks, broken at 1853 boundary only (single
  point of corruption; all other links verified)
- Primary security-audit log: **intact** (fallback path absorbed the
  failed appends)
- No data loss in user-facing state

## Resolution — Opcja A applied (2026-05-12 22:30 local)

**Operator decision:** Opcja A (accept + fork-marker) **+ engineering
guard**.

### What changed in this PR (`fix/audit-write-vitest-guard`)

1. **Block 1853 stays on disk.** The corrupted prev_hash link is
   accepted as a permanent forensic scar; chain integrity scans
   continue to report the mismatch at the 1852→1853 boundary. This
   doc IS the fork-marker — future readers see corruption + RCA + why
   it's intentionally not repaired.

2. **New guard module** `src/infra/logging/audit-write-guard.ts`:
   - `isAuditWriteAllowed(rawEnv)` — returns `false` when
     `VITEST=true` and `MEMPHIS_TEST_ALLOW_AUDIT_WRITE` is not set.
   - `emitAuditWriteGuardWarning(context)` — throttled stderr warning
     for soft-skip call sites.
   - `assertAuditWriteAllowed(context, rawEnv)` — throwing variant
     for callers that need a hard signal.

3. **Three call sites wired:**
   - `writeSecurityAudit` (audit log file) — soft skip.
   - `emitRuntimeSecurityEvent` (audit + chain mirror) — soft skip.
   - `appendBlock('system' | 'security', ...)` — hard throw.

4. **Test migration** — three existing test files needed the opt-in
   env in `beforeEach` because they legitimately exercise the audit
   path via tmpdir:
   - `tests/integration/chain-format-compat.test.ts`
   - `tests/unit/tier3-session-persistence.test.ts` (hydrate-audit suite)
   - `tests/unit/task-executor.test.ts` (chain-event dedup)

### Effect

A future test that forgets to mock `emitRuntimeSecurityEvent` and
runs against the operator's live `~/.memphis/` will:

- For the **audit log** file path: silently no-op + emit a one-shot
  stderr warning explaining the remediation.
- For the **system chain** append path: throw with the remediation
  message. The throw is caught by `emitRuntimeSecurityEvent`'s own
  try/catch and printed to stderr; direct callers see the clear
  error.

Either way, the operator's chain stays intact. The 1853 incident
cannot recur.

### Followup (deferred, separate sprints)

- **Truncate-and-replay (Opcja B)** — keep as upgrade path if any
  future external audit requires a scan-clean chain.
- **Per-chain target dir audit** — eventually the daemon could pin
  the `system` chain to a writable-only-by-daemon directory so even
  a misconfigured test can't reach it. Larger change; deferred.
