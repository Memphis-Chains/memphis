# V3 PACK 3-1-3 EVIDENCE

Date: 2026-03-09

## Scope
1. Phase5-v3.2: transition response now links audit event/path.
2. Phase6-v3.2: native MCP envelope negative smoke coverage.
3. Phase8-v3.2: native hard run emits deterministic report artifact.

## Commands validated
```bash
npm run -s test:smoke:phase5-transition
npm run -s test:smoke:phase6-native-mcp-negative
npm run -s test:smoke:phase8-native-report
```

## PASS markers
- `[smoke-phase5-transition] PASS`
- `[smoke-phase6-native-mcp-negative] PASS`
- `[smoke-phase8-native-report] PASS`

## Artifacts
- `data/decision-audit.jsonl`
- `/tmp/mv4-phase8-native/phase8-native-report.json`
