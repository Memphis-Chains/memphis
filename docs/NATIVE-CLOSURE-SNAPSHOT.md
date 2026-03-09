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
1. Expose dedicated native MCP transport endpoint (beyond CLI wrapper path).
2. Link decision history snapshots to chain-level persistence references.
3. Replace local transport simulation with multi-node production transport proof.
