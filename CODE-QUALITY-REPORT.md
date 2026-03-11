# Memphis v5 — Code Quality Report (Pre-v1.0.0)

Date: 2026-03-11  
Scope: **all `.ts` files in repository (excluding `node_modules`)** across `src/`, `tests/`, `packages/`, scripts, and reference files.

---

## Executive Summary

Overall status: **Good functional maturity, but not release-clean yet**.

What is strong:

- TypeScript compile check passes (`npm run typecheck`)
- Broad automated test suite exists (**104 test files, 241 tests**)
- Architecture is modular by domain (`infra`, `providers`, `cognitive`, `sync`, `mcp`, `tui`)

What blocks “clean pre-1.0” quality:

1. **Lint debt is high**: `121 errors, 12 warnings`
2. **1 failing test** in default TS test suite (`cli.model-d-social.test.ts` timeout)
3. **Very large orchestration functions** (notably CLI/TUI/server)
4. **Error wrapping inconsistency** (`preserve-caught-error` violations)
5. **Some dead/unused code and parameters** across core modules

---

## Evidence Collected

- `npm run -s typecheck` → passes
- `npm run -s lint` → fails with **133 findings** (121 errors, 12 warnings)
- `npm run -s test:ts` → **103 passed, 1 failed** (timeout)
- AST-based structural scan (all `.ts`, excluding node_modules/dist/.git):
  - Files scanned: **266**
  - Functions/methods >50 LOC: **66**
  - Functions with nesting depth >4: **6**
  - `any` keyword occurrences: **18**

---

## Findings by Category

## 1) Code Smells

### HIGH — God functions / oversized control flow

- `src/infra/cli/index.ts:931` `runCli` ~**990 LOC**
- `src/dashboard/web-dashboard.ts:157` `renderDashboard` ~**345 LOC** (large inline HTML/CSS template)
- `src/tui/index.ts:238` `runTuiApp` ~**325 LOC**
- `src/infra/http/server.ts:30` `createHttpServer` ~**289 LOC**

Impact:

- Hard to reason about, test in isolation, and safely change.
- Increased regression risk for minor modifications.

Recommendation:

- Split into focused handlers/composers (command routing, transport setup, rendering, and state machines).

---

### MEDIUM — Deep nesting (>4)

- `src/tui/index.ts:238` depth 7
- `src/infra/cli/interactive-tui.ts:23` depth 6
- `src/mcp/transport/http.ts:7` depth 5
- `src/onboarding/wizard.ts:13` depth 5

Impact:

- Branching complexity and cognitive load.

Recommendation:

- Extract guard clauses and sub-functions for command/key handling.

---

### MEDIUM — Dead code / unused symbols (representative)

Lint detects many; key examples:

- `src/cache/file-cache.ts:5` unused import `path`
- `src/dashboard/web-dashboard.ts:12,13` unused `fs`, `path`
- `src/infra/cli/index.ts:982` unused `cid`
- `src/cognitive/categorizer.ts:17` unused `PATTERN_DATABASE`
- Multiple unused caught errors/params in `src/resilience/fallback.ts`

Impact:

- Noise, misleading intent, and harder maintenance.

---

### LOW — Duplication

Exact duplicate file found:

- `src/security/unicode-normalizer.ts`
- `packages/@memphis/openclaw-plugin/src/unicode-normalizer.ts`

Potentially intentional (package boundary), but should be explicitly shared or generated to avoid drift.

---

## 2) TypeScript Best Practices

### MEDIUM — `any` usage still present

Examples from lint:

- `src/cache/query-cache.ts:10`
- `src/cli/commands/insight.ts:59`
- `src/dashboard/web-dashboard.ts:149,529`
- `src/providers/factory.ts:1`
- `src/security/request-limits.ts:85,130`
- `openclaw-plugin/src/index.ts:44`

Impact:

- Weakened static guarantees in critical glue code.

Recommendation:

- Replace with unions/unknown + narrowing, or explicit interfaces for provider responses.

---

### MEDIUM — Null/undefined and API contracts

- Good usage of Zod for HTTP payload validation in several routes.
- Some areas still return loosely shaped `error` payloads (`{ ok:false, error: string }`) without standardized contract.

Recommendation:

- Standardize error DTO type across HTTP, CLI, MCP boundaries.

---

### LOW — Module organization quality is generally good

- Domain-driven structure is clear.
- Main weakness is concentration of orchestration logic in a few very large files.

---

## 3) Error Handling

### HIGH — Error propagation hygiene violations

`preserve-caught-error` rule failures:

- `src/cognitive/learning.ts:237`
- `src/infra/storage/chain-adapter.ts:94`
- `src/infra/storage/rust-chain-adapter.ts:84`
- `src/resilience/fallback.ts:41`

Impact:

- Root cause context may be lost, reducing observability and postmortem quality.

Recommendation:

- Wrap as `new Error(message, { cause: error })` or dedicated `AppError` with `cause`.

---

### MEDIUM — Swallowed/ignored caught errors

Multiple caught `error` variables unused (`backup/rollback.ts`, `cache/index.ts`, `resilience/fallback.ts`), indicating potential silent failure paths.

Recommendation:

- Log at appropriate level and attach context fields (operation, key IDs, retries, provider).

---

## 4) Testing Coverage & Quality

### Strengths

- Large and diverse suite: unit/integration/e2e/cognitive/mcp/tui/sync.
- Coverage appears broad for core flows and adapters.

### HIGH — Current red test

- `tests/unit/cli.model-d-social.test.ts` timed out (15s)

Impact:

- CI instability / hidden race or heavy operation in CLI social command path.

Recommendation:

- Isolate I/O and external deps in this test; use deterministic fakes and tighter command scope.

---

### MEDIUM — Likely under-tested source modules (heuristic)

Based on source basename not referenced in test corpus, candidates include:

- `src/backup/rollback.ts`
- `src/dashboard/web-dashboard.ts`
- `src/security/constant-time.ts`
- `src/security/request-limits.ts`
- `src/sync/sync-manager.ts`, `src/sync/conflict-resolver.ts`, `src/sync/chain-diff.ts`
- `src/cache/file-cache.ts`, `src/cache/query-cache.ts`
- `src/tui/dashboard-data.ts`, `src/tui/screens/*`

Note: heuristic can produce false positives, but these modules should be reviewed for direct tests.

---

## 5) Maintainability

### MEDIUM — Readability pressure from command orchestration files

- CLI/TUI/server files combine parsing, business orchestration, rendering, and side-effects.

Recommendation:

- Introduce layers:
  - command parser → command dispatcher → command handlers
  - HTTP route registration → per-domain router modules
  - TUI state machine + action handlers separate from rendering

---

### LOW — Comments/docs

- Most modules are understandable from naming.
- Very large functions need short architectural comments at split boundaries.

---

## Severity Matrix (Top Issues)

## Critical

- None found.

## High

1. Lint error volume (121 errors) blocks code-health gate.
2. 1 failing TS test (`cli.model-d-social` timeout).
3. Missing `cause` in rethrown/wrapped errors in multiple core modules.
4. Extreme function size (`runCli` ~990 LOC).

## Medium

1. Deep nesting in TUI/MCP/onboarding flows.
2. Remaining `any` in runtime code paths.
3. Unused imports/vars/params and likely dead branches.
4. Under-tested modules (security/dashboard/sync/cache candidates).

## Low

1. Duplicate unicode normalizer implementation across package boundary.
2. Minor style consistency and error DTO normalization opportunities.

---

## Refactoring Priorities (Recommended Order)

### Priority 0 (Immediate gate to green)

1. Fix failing test: `tests/unit/cli.model-d-social.test.ts` timeout.
2. Resolve lint **errors** in `src/**` and `openclaw-plugin/src/**` first.
3. Exclude build artifacts (`packages/.../dist`) from lint scope or adjust config to avoid false CI noise.

### Priority 1 (Stability and debuggability)

1. Fix all `preserve-caught-error` violations by attaching `cause`.
2. Eliminate unused caught errors by logging + context or rethrowing.
3. Standardize error response contracts across HTTP/CLI/MCP.

### Priority 2 (Maintainability / complexity reduction)

1. Split `runCli` into command modules and command registry.
2. Split `createHttpServer` route wiring by domain (`health`, `vault`, `metrics`, `sessions`, `chat`).
3. Split `runTuiApp` into input handler, renderer loop, and command executor.
4. Extract dashboard HTML template to dedicated view/template file.

### Priority 3 (Type rigor + test strengthening)

1. Replace runtime `any` with typed interfaces/`unknown` guards.
2. Add/expand tests for currently weakly represented modules (security, dashboard, sync manager/conflict, cache).
3. Add coverage reporting threshold gate before v1.0 (e.g., changed-lines threshold or module minimums).

---

## Pre-v1.0.0 Exit Criteria (Suggested)

- `npm run lint` = **0 errors** (warnings budget optional)
- `npm run test:ts` = **all pass**
- `npm run typecheck` = pass
- No `preserve-caught-error` violations
- `runCli` and `runTuiApp` split into testable sub-units with reduced per-function LOC

---

## Final Assessment

Memphis v5 is close in functionality, but **code-health polish is not yet v1.0-ready**.  
The fastest path is: **green tests + lint cleanup + error-cause hygiene**, then reduce complexity hotspots (`cli`, `tui`, `http server`) before final stabilization.
