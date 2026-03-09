# V3 PACK 4-1-3 EVIDENCE

Date: 2026-03-09

## Scope
1. Phase5-v3.3: decision transition response now includes audit linkage + history snapshot path.
2. Phase6-v3.3: malformed JSON-RPC payload negative smoke.
3. Phase8-v3.3: deterministic closure artifact generated from signed/sync/native reports.

## Commands
```bash
npm run -s test:smoke:phase5-transition
npm run -s test:smoke:phase6-native-mcp-negative
npm run -s test:smoke:phase6-native-mcp-malformed
npm run -s test:smoke:phase8-closure-artifact
```

## PASS markers
- `[smoke-phase5-transition] PASS`
- `[smoke-phase6-native-mcp-negative] PASS`
- `[smoke-phase6-native-mcp-malformed] PASS`
- `[smoke-phase8-closure-artifact] PASS`

## Artifact
- `/tmp/mv4-phase8-closure/phase8-closure-artifact.json`
