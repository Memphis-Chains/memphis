# Phase8 real two-host capture evidence — 2026-03-10

## Summary
H4.9 blocker was closed by executing external-proof capture with two real hosts.

## Hosts
- nodeAHost: `10.0.0.80`
- nodeBHost: `10.0.0.22`

## Commands used
```bash
A=10.0.0.80; B=10.0.0.22; O=/tmp/mv4-phase8-external-pack
bash -lc "./scripts/phase8-external-proof-pack.sh $O $A $B"
./scripts/phase8-ledger-status.sh
cat /tmp/mv4-phase8-external-pack/phase8-external-host-report.json | grep -E '"nodeAHost"|"nodeBHost"'
```

## Verification outcome
- `phase8-external-proof-pack` => PASS
- Report artifact contains real hosts (not placeholders):
  - `"nodeAHost": "10.0.0.80"`
  - `"nodeBHost": "10.0.0.22"`

## Impact
- H4.9 moved from BLOCKED to DONE.
- External-proof path now validated in real two-host mode, not only local-ready/template mode.
