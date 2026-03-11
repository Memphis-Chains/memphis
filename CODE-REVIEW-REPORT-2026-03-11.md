# CODE REVIEW REPORT — 2026-03-11

## Overall Health Score: **74/100**

## Positive Findings
- TypeScript strict mode is enabled (`tsconfig.json`).
- CI already enforces lint/typecheck/tests in `.github/workflows/ci.yml`.
- Crypto-sensitive operations (vault, hashing) are centralized instead of ad-hoc in many modules.
- CLI command surface is now routed through modular handlers (`src/infra/cli/handlers/*`) rather than only direct sequential function calls.

---

## P0 (Critical)

### 1. Missing hard fail for complexity debt in production command paths (P0)
- Location: `src/infra/cli/commands/storage.ts:24`, `src/infra/cli/commands/system.ts:15`
- Problem: High-complexity command handlers still gate many production operations in single functions.
- Impact: maintainability + reliability risk (higher regression chance in critical workflows).
- Fix:

**Before**
```ts
export async function handleStorageCommand(context: CliContext): Promise<boolean> {
  // many command branches in one function
}
```

**After**
```ts
// dispatcher.ts
const handled = await dispatchCommand(context, [
  systemCommandHandler,
  embedCommandHandler,
  vaultCommandHandler,
  storageCommandHandler,
  ...
]);
```

---

## P1 (High)

### 2. Circular dependency detection was not enforced in standard CI flow (P1)
- Location: repo-wide (dependency hygiene process)
- Problem: circular checks existed ad-hoc, not integrated into regular quality workflow.
- Impact: architecture erosion over time, harder testability.
- Fix: enforce regular cycle scan (`npx madge --circular src/`) in quality pipeline or nightly check.

### 3. Pre-commit guardrails were missing (P1)
- Location: `.husky/pre-commit`, `package.json`
- Problem: no local gate before commit caused lint debt to enter history.
- Impact: slower feedback loop, noisier CI.
- Fix:

**After**
```sh
# .husky/pre-commit
npm run lint
```

---

## P2 (Medium)

### 4. ESLint quality thresholds existed but were not codified (P2)
- Location: `eslint.config.mjs`
- Problem: complexity/max-lines were not explicitly tracked.
- Impact: long-term readability and review cost increase.
- Fix:

**After**
```js
'@typescript-eslint/no-explicit-any': 'error',
'max-lines-per-function': ['warn', { max: 50, skipBlankLines: true, skipComments: true }],
complexity: ['warn', 10],
```

### 5. Selected lint errors in runtime path (P2)
- Location: `src/infra/cli/commands/backup.ts`, `src/infra/cli/utils/doctor-v2.ts`, `src/infra/storage/chain-adapter.ts`
- Problem: useless assignments / unused variables.
- Impact: maintainability and static-analysis noise.
- Fix: removed unused assignments/imports and normalized variable declarations.

### 6. Error wrapping lost root cause context in one path (P2)
- Location: `src/infra/cli/commands/system.ts:73`
- Problem: thrown error lacked `cause`.
- Impact: slower debugging.
- Fix:

**Before**
```ts
throw new Error(`chain verification failed: ...`);
```

**After**
```ts
throw new Error(`chain verification failed: ...`, { cause: error });
```

---

## P3 (Low)

### 7. Formatting/consistency not validated in CI (P3)
- Location: `.github/workflows/ci.yml`
- Problem: prettier check was missing.
- Impact: style drift.
- Fix: add `npm run format:check` step.

### 8. Router integration coverage gap (P3)
- Location: `tests/integration/cli-router.integration.test.ts`
- Problem: no dedicated dispatch test before refactor.
- Impact: accidental routing regressions.
- Fix: added integration tests for dispatch to system/storage/interaction handlers.

---

## Security Review (OWASP Top 10 lens)
- No immediate critical injection primitive discovered in reviewed CLI router changes.
- Vault flows remain centralized in storage adapters.
- Recommendation: add explicit threat-model notes and security tests for command argument sanitization around file-based operations (`--file`, backup restore paths).

## Performance Review
- No newly introduced O(n²) paths in this refactor.
- Existing hotspot risk remains in several large functions (warnings from complexity/max-lines).
- Recommendation: incremental decomposition of top 10 longest/highest complexity functions.

## Architecture Review
- Dispatcher now follows command-handler pattern (`src/infra/cli/handlers/*`).
- Circular scan result at review time: **No circular dependency found** (`madge --circular src/`).

## TypeScript/Rust Practices
- TS strict mode: enabled.
- `any` as a type in `src/`: currently blocked by lint (`@typescript-eslint/no-explicit-any: error`).
- Recommendation: keep no-explicit-any strict in runtime paths; allow test-only exceptions where mocking requires flexibility.

## Testing Gaps
- Added integration test for CLI routing.
- Coverage delta should be checked in CI metrics (not all projects export explicit coverage gates yet).
- Recommendation: add explicit coverage threshold for `src/infra/cli/**`.

---

## Actionable Next Steps (ordered)
1. Break down `handleStorageCommand` and `handleSystemCommand` into subcommand-level handlers.
2. Promote complexity/max-lines from warning to error after phased refactor.
3. Add mandatory madge cycle check in CI.
4. Add CLI argument sanitization tests for backup/import paths.
5. Add coverage threshold gate for CLI modules.
