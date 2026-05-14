# PR #595 Pre-Merge Review — Coder B → Coder A

**PR:** `fix(audit): guard live audit writes from VITEST (Block 1853 fix + recurrence prevention)`
**Branch:** `fix/audit-write-vitest-guard`
**Stats:** 9 files, +605 lines
**Status:** OPEN, CI: `quality-gate IN_PROGRESS` (started 2026-05-12 20:54:16Z)
**Reviewer:** Coder B
**Disposition:** ~~CLEAN, recommend merge after CI green.~~ **🔴 BLOCKED — CI failure, 6 tests/ops/ tests need MEMPHIS_TEST_ALLOW_AUDIT_WRITE=1 in commandEnv.** Pre-merge review (this doc) MISSED these because they spawn `memphis` subprocess (don't import the audit modules directly). Comment posted on PR with fix shape: https://github.com/Memphis-Chains/memphis/pull/595#issuecomment-4434777271

---

## ✅ ACK — done well

1. **Three primitives, three policies** — `isAuditWriteAllowed` (read-only check), `emitAuditWriteGuardWarning` (throttled stderr soft-skip), `assertAuditWriteAllowed` (throwing hard-fail). The soft/hard split is the right call: passive logging paths early-return + warn, chain-mutation paths throw so callers can't silently get an undefined result.

2. **Three call sites wired:**
   - `writeSecurityAudit` (`src/infra/logging/security-audit.ts`) — soft skip
   - `emitRuntimeSecurityEvent` (`src/security/runtime-security-events.ts`) — soft skip
   - `appendBlock` on `'system' | 'security'` chains (`src/infra/storage/chain-adapter.ts`) — hard throw

   Hard-throw scope is correctly **narrow** — only `system` + `security` chains, not arbitrary operator chains (journal/decisions/...).

3. **Test migration is targeted.** Three test files migrated to `MEMPHIS_TEST_ALLOW_AUDIT_WRITE=1` in `beforeEach`:
   - `tests/integration/chain-format-compat.test.ts`
   - `tests/unit/tier3-session-persistence.test.ts`
   - `tests/unit/task-executor.test.ts`

   I verified 4 other tests that touch audit/security paths — `dual-approval-events.test.ts`, `self-modify-lifecycle.test.ts`, `conflict-detection.test.ts`, `vault-boundary.test.ts` — and **all 4 use mocks** (`vi.fn` / `vi.spyOn` / `vi.mock`) so they bypass the guard entirely. No additional migration needed.

4. **Throttled stderr warnings** — `warnedContexts` Set prevents spam from a leaking suite. Plus `resetAuditWriteGuardWarnings()` test seam for unit tests of the guard itself.

5. **Forensic note kept** — `notes/system-chain-corruption-2026-05-12.md` preserved as permanent record of block 1853 root cause.

6. **Memphis convention compliance:**
   - No `} catch {}` silent-catch added
   - No `process.cwd()` defaults
   - No unguarded `JSON.parse`
   - `process.env` mutations only in test files (allowed pattern)

---

## 🟢 NIT-level findings (Codex round-N candidates, not blockers)

### N1. `MEMPHIS_TEST_ALLOW_AUDIT_WRITE` not in `src/config/env-registry.ts`

Memphis convention (per inline comments in many files): env vars should pass through the centralised env-registry accessor for discoverability + type safety.

`MEMPHIS_TEST_ALLOW_AUDIT_WRITE` is a test-only flag, never read by operator-facing code paths, so an argument exists for keeping it out of the registry. But if Codex flags it, Coder A can:
- Add it as `MEMPHIS_TEST_ALLOW_AUDIT_WRITE` env-registry entry with a comment "test-only, never read by runtime", OR
- Document in `tools/training/README.md` or a test-conventions doc that integration tests touching audit paths need this env in beforeEach.

Trivial either way; bundle into Codex round-N hotfix if it comes up.

### N2. `VITEST` also bypasses env-registry

`isAuditWriteAllowed` reads `rawEnv.VITEST` directly. This is vitest-native (auto-set by the runner), so it can't legitimately be moved into the registry without losing the auto-set magic. Comment-only suggestion: add `// VITEST is set by vitest itself; reading it directly is the canonical way to detect a test runner.` to short-circuit the inevitable question.

---

## 🔴 BLOCKER — found post-CI

### B1. tests/ops/ subprocess tests missing env opt-in (6 failures)

`tests/ops/incident-bundle-manifest-verify.test.ts` (5 failures, 18 commandEnv sites) and `tests/ops/strict-incident-handoff.test.ts` (1 failure, 3 commandEnv sites) spawn a real `memphis` subprocess via execFile. The subprocess inherits `VITEST=true` from the parent test, then hits the guard when it tries to write `system` chain events (e.g., manifest verification result). Subprocess exits with code 1; test asserts code 0; fail.

**Why my pre-merge review missed it:** I grep'd for direct `appendBlock('system'/'security', ...)` / `writeSecurityAudit` / `emitRuntimeSecurityEvent` references in test files. The 4 candidates I found all use vi.fn mocks. But these `tests/ops/` files don't import those modules directly — they import them transitively via the spawned subprocess. Subprocess inherits VITEST=true from parent → guard fires inside the subprocess → subprocess exit 1 → test assertion fails.

**Lesson for next pre-merge review:** Also grep for `spawn`, `execFile`, `child_process` patterns when the PR introduces an env-based guard — subprocess inheritance is a real propagation path.

**Fix shape (proposed in my comment):**

```diff
- const commandEnv = { MEMPHIS_DATA_DIR: path.join(dir, '.memphis-data') };
+ const commandEnv = {
+   MEMPHIS_DATA_DIR: path.join(dir, '.memphis-data'),
+   MEMPHIS_TEST_ALLOW_AUDIT_WRITE: '1',
+ };
```

I quoted "21 sites total" as the brute-force count.

**Coder A's actual fix (`1322d39b`) — cleaner:**

Instead of 21 commandEnv site edits, Coder A made **2 helper-level edits** that cover the same 14 sites (count miscalibrated mine; correct is 11+3):

- `tests/ops/incident-bundle-manifest-verify.test.ts`: `runCommand` helper's spawn env (covers 11 commandEnv sites that use it)
- `tests/ops/strict-incident-handoff.test.ts`: `runStrictHandoff` helper's spawnSync env (covers 3 sites)

This is the better refactor — DRY, single source of truth per file. My fix-shape suggestion ("brute force per-site") would have created 14 spots to forget on the next test addition. Coder A's helper-level approach makes the env opt-in property of the helper itself, future tests inherit it.

**Additional audit (already in Coder A's commit message):** Other ops/* tests that spawn `memphis` subprocesses (`rotate-key-bundle`, `guard-failure-drill`, `strict-handoff-fixture-validator`, …) passed in CI 25761610287 — they don't currently hit chain-write paths. If any add one later, same helper-pattern applies.

**Status after fix push `1322d39b`:** CI quality-gate IN_PROGRESS started 2026-05-12 21:04:25Z. Local test run (30 passed + 2 skipped) confirmed green pre-push.

## Verification commands

```bash
gh pr view 595
gh pr diff 595
gh pr checks 595 --watch

# Repro the guard locally
npm test -- tests/unit/audit-write-guard.test.ts
npm test -- tests/integration/chain-format-compat.test.ts
```

## Disposition

**Merge as soon as CI green.** Block 1853 recurrence prevention shipped, daemon restart can resume.

Optional: fold N1 into the Codex round-N bundled hotfix that's coming for #593 + #594 findings. Don't open a separate PR for it.
