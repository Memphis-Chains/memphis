# NATIVE CLOSURE SNAPSHOT

Date: 2026-03-09
Branch baseline: `main`
Anchor commit at snapshot start: `9021012`

## Newly hardened native paths
- Phase5: decision transition returns audit link + persisted history snapshots (`decide history` view added).
- Phase6: native MCP gateway contract + CLI invocation + hard positive/negative smoke path.
- Phase8: native ed25519 smoke + signed/sync validators + native transport integrity smoke.

## Current native gate commands
```bash
npm run -s test:smoke:phase5-transition
npm run -s test:smoke:phase6-native-mcp-hard
npm run -s test:smoke:phase6-native-mcp-negative
npm run -s test:smoke:phase6-native-mcp-malformed
npm run -s test:smoke:phase8-native-ed25519
npm run -s test:smoke:phase8-native-ed25519-verify
npm run -s test:smoke:phase8-native-hard
npm run -s test:smoke:phase8-native-transport
npm run -s test:smoke:phase8-closure-artifact
```

## Remaining deltas
1. Gateway `/exec` hardening pack (remote execution surface reduction).
2. Replace local transport simulation with multi-node production transport proof.

## 2026-03-10 closure checkpoint
- Phase5 canonical refs: closed in active path.
- Phase6 persistent MCP service mode: closed with deterministic lifecycle controls.
- Phase6/8 transport proof hardening: active with proof-smoke scripts and artifact path (`/tmp/mv4-phase6-proof/transport-proof.json`).

## Recent merged anchors
- `e0f82d0` — vnext pack (history filter, MCP error codes, closure checksum)
- `3580a1d` — last-mile pack (mcp serve-once, closure ledger)
- `a41d47c` — same-pack (history integrity, mcp serve-schema, ledger validator)
