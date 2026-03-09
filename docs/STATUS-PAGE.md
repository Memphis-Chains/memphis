# Runtime Status Page (single source)

## Current state
- Overall: **GREEN**
- Profile: local Ollama production mode (`decentralized-llm` via bridge `127.0.0.1:11435`)
- Baseline: `v0.2.0-rc.2`

## Health signals
- CI quality gate: expected GREEN on merge PRs
- Nightly runtime smoke (local timer): expected GREEN daily
- Bridge health timer: expected ACTIVE
- Recovery drill (local/manual): expected PASS (weekly)

## State model
- **GREEN**: smoke PASS + no open runtime incident
- **YELLOW**: intermittent failures, auto-recovery working, incident open
- **RED**: repeated failures or bridge/runtime unavailable

## Operator quick links
- `docs/OPERATOR-5MIN-RUNBOOK.md`
- `docs/OLLAMA-BRIDGE-RUNBOOK.md`
- `docs/GO-LIVE-CHECKLIST-V1.md`
