# PHASE6 MCP HARD GATE EVIDENCE

Date: 2026-03-09
Scope: stricter MCP-style E2E hardening gate

## Commands

```bash
./scripts/smoke-phase6-mcp-hard.sh
npm run -s test:smoke:phase6-mcp-hard
```

## Assertions
- response shape contains: `id`, `output`, `providerUsed`
- trace includes attempts with positive latency (`trace.attempts[].latencyMs > 0`)
- wall-clock gate threshold: `<= 15000ms`

## Artifacts
- `/tmp/mv4-phase6-hard/request.json`
- `/tmp/mv4-phase6-hard/response.json`
- `/tmp/mv4-phase6-hard/report.json`

## PASS marker
- `[smoke-phase6-mcp-hard] PASS`

## Verdict
- Status: PASS (hard gate simulation)
- Next: replace simulated JSON-RPC wrapper with native MCP bridge endpoint invocation and authenticated transport checks.
