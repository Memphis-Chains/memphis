# PHASE8 SOVEREIGNTY MIN GATE

Date: 2026-03-09
Scope: minimum sovereignty proof slice (signed block + two-node sync)

## Commands

```bash
./scripts/smoke-phase8-signed-chain.sh
./scripts/smoke-phase8-two-node-sync.sh
```

## Expected markers
- `[smoke-phase8-signed-chain] PASS`
- `[smoke-phase8-two-node-sync] PASS`

## Artifacts
- `/tmp/mv4-phase8/signed-proof.json`
- `/tmp/mv4-phase8-sync/sync-proof.json`

## Gate verdict (current)
- Status: PASS (minimum sovereignty slice, simulation harness)
- Note: next hardening step should replace simulated sign/sync internals with native cryptographic + transport implementations.
