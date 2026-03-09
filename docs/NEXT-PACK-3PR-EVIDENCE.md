# NEXT PACK 3+PR EVIDENCE

Date: 2026-03-09

## Scope
1. Native MCP `serve-once` CLI flow with transport-backed smoke.
2. Phase8 closure ledger append smoke.
3. Evidence anchor for this 3-commit pack.

## Commands
```bash
npm run -s test:smoke:phase6-native-mcp-serve-once
npm run -s test:smoke:phase8-closure-ledger
```

## PASS markers
- `[smoke-phase6-native-mcp-serve-once] PASS`
- `[smoke-phase8-closure-ledger] PASS`

## Artifacts
- `/tmp/mv4-phase8-closure/phase8-closure-manifest.json`
- `data/phase8-closure-ledger.jsonl`
