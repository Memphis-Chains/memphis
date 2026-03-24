# Phase 3-6 Polish + Hardening

This pack adds targeted reliability improvements for TUI, onboarding, decision validation, and MCP observability.

## Included

- TUI status widget + provider health coverage
- Decision screen resilient loading/error/empty-state rendering
- Onboarding wizard prerequisite checks and setup retry logic
- Doctor diagnostics shape coverage (critical components + bridge export guard)
- Decision lifecycle duplicate protection + strict chain validation
- MCP health monitor checks + recovery recommendations
- MCP observability metrics with Prometheus export format

## New test suites

- `tests/unit/status-widget.test.ts`
- `tests/unit/use-provider-health.test.ts`
- `tests/unit/decision-screen.test.ts`
- `tests/unit/onboarding.wizard.test.ts`
- `tests/unit/onboarding.doctor.test.ts`
- `tests/unit/decision.lifecycle.test.ts`
- `tests/unit/mcp.observability-health.test.ts`
