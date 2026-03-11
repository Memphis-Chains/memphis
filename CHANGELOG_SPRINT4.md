# CHANGELOG — Sprint 4 (Productization)

Date: 2026-03-08

## S4.1 Auth hardening

- Added explicit API auth policy module:
  - `src/infra/http/auth-policy.ts`
- Protected/private endpoints now consistently enforced when `MEMPHIS_API_TOKEN` is set
- Integration test added:
  - `tests/integration/auth-policy.e2e.test.ts`

## S4.2 Rate limits + abuse guard

- Added in-memory rate limiter:
  - `src/infra/http/rate-limit.ts`
- Applied limits to sensitive API and gateway routes
- Unified 429 error contract with `retryAfterMs`
- Tests added:
  - `tests/unit/rate-limit.test.ts`
  - `tests/integration/rate-limit.e2e.test.ts`

## S4.3 Config profiles

- Added config profiles module:
  - `src/infra/config/profiles.ts`
- Production safeguards:
  - required `MEMPHIS_API_TOKEN`
  - safe caps for timeout/tokens
  - debug log normalization
- Documentation:
  - `docs/CONFIG-PROFILES.md`
- Unit tests:
  - `tests/unit/config-profiles.test.ts`

## S4.4 Operator UX

- Added health color summary (`green/yellow/red`):
  - `src/infra/ops/health-summary.ts`
- Extended status endpoints with health summary:
  - API: `GET /v1/ops/status`
  - Gateway: `GET /ops/status`
- Go-live checklist:
  - `docs/GO-LIVE-CHECKLIST-V1.md`
- Tests:
  - `tests/unit/health-summary.test.ts`
  - `tests/integration/ops-health-color.e2e.test.ts`

## Sprint 4 Quality Gate

- lint ✅
- typecheck ✅
- tests ✅
- build ✅
- secret scan ✅
