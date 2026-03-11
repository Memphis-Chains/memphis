# CHANGELOG — Sprint 3

Date: 2026-03-08

## S3.1 Ask → Persist → Recall

- Added session recall endpoint:
  - `GET /v1/sessions/:sessionId/events`
- Verified end-to-end flow: generate persists metadata, recall returns stored events
- Integration test: `tests/integration/session-recall.e2e.test.ts`

## S3.2 Session APIs v1

- Added session list endpoint:
  - `GET /v1/sessions`
- Extended session repository contract with `listSessions()`
- SQLite implementation updated accordingly
- Integration test: `tests/integration/session-apis.e2e.test.ts`

## S3.3 Provider Failover Policy v2

- Added provider cooldown policy module:
  - `src/modules/orchestration/provider-policy.ts`
- Orchestration now marks provider failures/success and applies cooldown
- Fallback flow improved to continue service when primary is cooling down
- Tests:
  - `tests/unit/provider-policy.test.ts`
  - `tests/integration/provider-failover-v2.e2e.test.ts`

## S3.4 Ops Status Endpoint

- Added API endpoint:
  - `GET /v1/ops/status`
- Added gateway endpoint:
  - `GET /ops/status`
- Returned runtime summary includes provider health, metrics snapshot, uptime, timestamp
- Integration test: `tests/integration/ops-status.e2e.test.ts`

## Sprint 3 Quality Gate

- lint ✅
- typecheck ✅
- tests ✅
- build ✅
- secret scan ✅
