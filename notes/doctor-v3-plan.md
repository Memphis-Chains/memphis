# Plan: Design `doctor-v3` — Architectural Health Checker

## Context

The current `doctor-v2` (917 lines, 6 tiers) covers runtime infrastructure health — reachability, storage, config, security posture. It does **not** cover architectural correctness or code-level Sprint 3 P1/P2/P3 issues that `npm run typecheck && npm run test:ts` would catch.

The roadmap (Sprint 3 through M8) commits to hardening fixes. A subset of those fixes produce **runtime-observable symptoms** that `doctor` could detect. The goal is a new `doctor-v3` that adds an **Architecture tier** (Tier A / Tier 7) to expose structural health signals — provider cooldown state, ResilienceManager cascade health, double SQLite connections, dead code paths, and type-level gaps.

Not all P1/P2/P3 issues are runtime-checkable. The plan distinguishes:
- **Runtime-checkable** → add doctor checks
- **Code-level only** → document as requiring `npm run typecheck` / code review

---

## What Was Already Fixed (Committed)

These P1 issues were fixed in `debdcd4` and are **not** candidates for doctor checks:

| Issue | Fix | Status |
|-------|-----|--------|
| 5.2 Security tests | `tests/security/` with 8 test files | ✅ Fixed |
| 5.5 network-chain atomic write | `write→.tmp→rename` in `network-chain.ts` | ✅ Fixed |
| 5.6 Sync tests | `tests/unit/sync.test.ts` | ✅ Fixed |
| 5.7 Socket leak | `socket.destroy()` on all exits in `protocol.ts` | ✅ Fixed |
| 5.8 Timing leak | XOR length diff into accumulator in `constant-time.ts` | ✅ Fixed |

---

## New Tier: Architecture Health (Tier A)

To be added to `doctor-v2.ts` as a new top-level section, after Tier 6.

### A1 — Provider Cooldown & Fallback State

**Why:** Sprint 3 P1 (5.4) added cooldown check before fallback. The doctor should expose whether any provider is currently in cooldown and whether fallback is same as primary.

**Files:** `src/modules/orchestration/provider-policy.ts`, `src/modules/orchestration/service.ts`

**Check:**
```typescript
// Check: is any provider in cooldown?
const cooldownMap = providerPolicy.getCooldownMap(); // needs new public method
const inCooldown = [...cooldownMap.entries()].filter(([, until]) => Date.now() < until);
const fallbackName = container.getFallbackProvider();
const primaryName = container.getPrimaryProvider();
const fallbackSameAsPrimary = fallbackName === primaryName;
```

**Fix:** Add `ProviderPolicy.getCooldownMap()` (public accessor) and `OrchestrationService.getPrimaryProvider()` / `getFallbackProvider()` getters.

**Level:** `fail` if any required provider in cooldown; `warn` if fallback === primary.

---

### A2 — ResilienceManager Cascade Health

**Why:** P2 (6.5) — only 1/3 strategies works. `healthCheck()` method exists but is never called in doctor.

**File:** `src/resilience/fallback.ts`

**Check:**
```typescript
const resilience = container.resilienceManager;
const health = await resilience.healthCheck();
// health.strategies = { rust: boolean, typescript: boolean, cache: boolean }
// health.status = 'HEALTHY' | 'DEGRADED' | 'DOWN'
```

**Level:** `pass` if ≥2 strategies healthy; `warn` if 1; `fail` if 0.

---

### A3 — HnswIndex Integration Status

**Why:** P2 (6.6) — HnswIndex exists in `src/infra/embeddings/hnsw-index.ts` but is NOT integrated into ResilienceManager cascade.

**Check:** Call `resilienceManager.healthCheck()` and also check if `hnswIndex` is present in the cascade path. Could introspect whether `HnswIndex` is instantiated in the ResilienceManager.

**Level:** `warn` if HnswIndex exists but is not part of the cascade.

---

### A4 — Double SQLite Connection

**Why:** P2 (6.9) — `bootstrap.ts` creates 2 connections (lines 276, 758) and `container.ts` creates a third (line 31) to the same `DATABASE_URL`.

**Check:** Pattern-match or string search in compiled output, or inspect container startup to verify single connection use.

**Alternative (runtime):** At startup, patch `createSqliteClient` to track call sites via a WeakMap. Doctor reads this at runtime.

**Level:** `fail` if >1 connection to same path.

---

### A5 — SyncManager Write Atomicity

**Why:** P1 (5.5) — `SyncManager.writeChain()` (sync-manager.ts:181-200) iterates blocks and calls `appendBlock()` per block, which IS atomic per-block but not as a transaction. The `network-chain.ts` fix (write→.tmp→rename) only covers network sync, not local SyncManager.

**Check:** Inspect SyncManager's `writeChain()` method. If it uses the lock-per-block pattern without a surrounding transaction, flag as `warn`. This is a code-level check that would need static analysis or source reading.

**Level:** `warn` if writeChain() is not a single atomic transaction.

---

### A6 — TUI Decision Screen Dead Code

**Why:** P3 (7.1) — `decision-screen.ts` exists but is never imported or rendered anywhere.

**Check:** Grep for `decision-screen` imports across all `src/tui/` files. If zero imports, flag.

**Level:** `warn` if file exists but has zero imports.

---

### A7 — Hardcoded Version in Demo HTML

**Why:** P3 (7.3) — `demo/index.html:94` has `<div class="logo">△⬡◈ MEMPHIS v5</div>` hardcoded.

**Check:** Read `demo/index.html` and extract version string. Compare with `package.json` version. Flag mismatch.

**Level:** `warn` if hardcoded version !== package.json version.

---

### A8 — ProviderName Type Completeness

**Why:** P3 (7.5) — `ProviderName` type in `core/types.ts:1` is `'shared-llm' | 'decentralized-llm' | 'local-fallback' | 'ollama' | 'glm'`. But `providers/index.ts:454` implements `'minimax' | 'deepseek'` which are not in the type.

**Check:** At runtime, enumerate all loaded providers (from `listConfiguredProviders`) and check whether each name is a subset of `ProviderName`. Or read the source file and check via regex.

**Level:** `warn` if provider implementations exist that are not in the `ProviderName` union type.

---

### A9 — Insight Type Duplication

**Why:** P3 (7.4) — `Insight` type defined in both `cognitive/types.ts:79` and `cognitive/model-e-types.ts:31` with incompatible schemas.

**Check:** This is a type-level issue. At runtime it manifests as casting errors or `never` types. Could check via a synthetic test: `const check: Insight = { type: 'prediction', ... }` — if TypeScript error, duplication is causing issues. But that's a compile-time check.

**Level:** Document as requiring `npm run typecheck` — not runtime-checkable.

---

### A10 — Soul Memory Completeness

**Why:** P2 (6.1) — `isSoulMemoryEmpty()` may return incomplete results.

**Check:** The doctor already calls `loadSoulMemory()` and checks `!isSoulMemoryEmpty()`. But it doesn't call `isSoulMemoryEmpty()` directly with various edge cases. Could add a deep check: load soul memory, call `isSoulMemoryEmpty()`, then verify internal paths are non-empty.

**Level:** `warn` if soul memory passes the empty check but internal manifest shows unpopulated fields.

---

## Plan Status: Design Complete — Scheduled as Roadmap Sprint After M8

This is a **design document** for `doctor-v3` — an Architecture Health tier for `doctor-v2`.

**Not a production coding task.** This is a **roadmap item** to be added to `ROADMAP-FULL-SPRINT3-TO-M8.md` as a post-M8 sprint (Sprint 4 or beyond), after v1.0.0 GA is shipped.

### Proposed Roadmap Entry

Add to `docs/ROADMAP-FULL-SPRINT3-TO-M8.md` as a new sprint after M8:

```
## Sprint 4 — Doctor v3: Architectural Health (Post-M8)

**Goal:** Extend doctor to detect architectural and code-level health issues
        that are runtime-observable, covering the remaining P2/P3 issues.

**Tier A — Architecture Health (10 checks):**
- A1: Provider cooldown & fallback state (ProviderPolicy.getCooldownMap())
- A2: ResilienceManager cascade health (healthCheck() integration)
- A3: HnswIndex integration status
- A4: Double SQLite connection detection
- A5: SyncManager writeChain() atomicity check
- A6: TUI decision-screen.ts dead code detection
- A7: Hardcoded version in demo/index.html
- A8: ProviderName type completeness (minimax/deepseek)
- A9: Insight type duplication (requires typecheck)
- A10: Soul memory completeness deep-check

**Files:** doctor-v2.ts (+Tier A), provider-policy.ts, service.ts
```

### Follow-Up Action (after plan approval, out of plan mode)

Edit `docs/ROADMAP-FULL-SPRINT3-TO-M8.md` to insert the Sprint 4 section after M8 (before the Full Timeline Overview table), and add Sprint 4 to the Cross-Cutting Themes table.

## Files to Modify

| File | Change |
|------|--------|
| `src/infra/cli/utils/doctor-v2.ts` | Add Tier A (Architecture Health), ~200 new lines |
| `src/modules/orchestration/provider-policy.ts` | Add `getCooldownMap()` public method |
| `src/modules/orchestration/service.ts` | Add `getPrimaryProvider()`, `getFallbackProvider()` getters |
| `src/infra/embeddings/hnsw-index.ts` | No changes (read-only inspection) |
| `src/resilience/fallback.ts` | No changes (already has `healthCheck()`) |

## Auto-Repair (--fix flag)

**Deferred to production.** When the implementation is executed:
- `--fix` repairs **state** only (Tier A items A1–A4 that are auto-repairable: clearing cooldowns, recreating missing dirs, removing stale locks)
- Architectural code-level issues (A5–A10) will be **documented and flagged** but require manual code changes — not auto-repaired

---

## Critical Files

- `src/infra/cli/utils/doctor-v2.ts` — main target
- `src/modules/orchestration/provider-policy.ts` — cooldown map access
- `src/modules/orchestration/service.ts` — primary/fallback provider access
- `src/resilience/fallback.ts` — ResilienceManager cascade health
- `src/sync/sync-manager.ts` — writeChain atomicity check

---

## Reused Patterns

From existing `doctor-v2.ts`:
- `checkChainIntegrity()` pattern for file-based validation
- `ping()` for provider health
- `autoRepair()` pattern for `--fix` flag
- `printDoctorHumanV2()` rendering with tier groupings
- `levelFrom()` helper

---

## Verification (for when implementation runs)

1. `npm run doctor --json | jq '.checks[] | select(.tier == "A")'` — list new Architecture tier checks
2. `npm run doctor --json | jq '.summary'` — verify `ok` field reflects new checks
3. `npm run typecheck && npm run test:ts` — ensure no regressions
4. `npm run lint` — no new lint violations
5. Manual: trigger each fixable condition and verify `--fix` flag handles it correctly
