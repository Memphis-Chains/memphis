# Guard Failure Drill

Use this drill to validate expected behavior for two critical startup guard failures:

1. invalid trust-root in strict mode
2. stale revocation cache

## Run

```bash
npm run -s ops:drill-guards
```

Machine-readable mode:

```bash
npm run -s ops:drill-guards -- --json
```

## Expected Output

You should see:

- `[PASS] trust-root-invalid-strict ... exitCode=103 ...`
- `[PASS] revocation-stale ... stale=true ...`

Any `[FAIL]` line means guard behavior drifted and must be investigated before release.

## What This Verifies

- strict trust-root failures map to `ERR_TRUST_ROOT` (`103`)
- startup trust-root status is recorded as invalid
- stale revocation cache is detected as fail-closed condition (`stale=true`)

## Operator Action On Failure

1. run `npm run -s test:ts -- tests/integration/startup-security-alerts.e2e.test.ts tests/integration/revocation-cache-guard.e2e.test.ts`
2. inspect latest changes touching:
   - `src/app/bootstrap.ts`
   - `src/infra/runtime/startup-guards.ts`
   - `src/infra/http/server.ts`
3. do not promote release until drill returns all `[PASS]`.
