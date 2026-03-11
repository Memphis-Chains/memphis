# OPS RUNBOOK S2.4 — Observability + Ops

## New endpoints

- API: `GET /v1/metrics`
- Gateway: `GET /metrics`

## What to check

1. Provider success/failure counters
2. Provider avg latency
3. requestId present on error responses

## Quick triage

```bash
curl -s http://127.0.0.1:3000/v1/metrics | jq .
curl -s http://127.0.0.1:19089/metrics | jq .
```

## Expected baseline

- `local-fallback` should show non-zero calls after smoke chat
- `failure` should remain 0 in normal local fallback path
