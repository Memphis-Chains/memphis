# CHANGELOG — Sprint 2

Date: 2026-03-08

## S2.1 CLI Unification

- Canonical CLI runtime kept in `src/infra/cli/index.ts`
- `src/cli/index.ts` reduced to thin entrypoint bridge
- Removed CLI logic duplication

## S2.2 Gateway Integration

- Gateway integrated with current app container/orchestration
- Unified error mapping via `AppError` contract
- requestId propagated in gateway error responses
- Added integration test: `tests/integration/gateway.e2e.test.ts`

## S2.3 Provider Runtime Policy

- Added decentralized provider client+adapter:
  - `src/providers/decentralized-llm/client.ts`
  - `src/providers/decentralized-llm/adapter.ts`
- Container policy now dynamically loads shared/decentralized providers when configured
- Added tests:
  - `tests/unit/decentralized-llm.adapter.test.ts`
  - `tests/integration/provider-policy.e2e.test.ts`

## S2.4 Observability + Ops

- Added provider metrics collector: `src/infra/logging/metrics.ts`
- Metrics recording wired into orchestration generate path
- New metrics endpoints:
  - API: `GET /v1/metrics`
  - Gateway: `GET /metrics`
- Ops runbook added: `docs/OPS-RUNBOOK-S2.4.md`
- Integration test added: `tests/integration/metrics.e2e.test.ts`

## Quality Gate

- lint ✅
- typecheck ✅
- tests ✅
- build ✅
- secret scan ✅
