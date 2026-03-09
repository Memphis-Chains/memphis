# V3 PACK 2-1-3 EVIDENCE

Date: 2026-03-09

## Scope
1. Phase5-v3: decision transition audit append path in CLI.
2. Phase6-v3: native MCP CLI invocation smoke.
3. Phase8-v3: native ed25519 proof validator + combined native-hard gate.

## Commands validated
```bash
npm run -s test:smoke:phase5-transition
npm run -s test:smoke:phase6-native-mcp-gateway
npm run -s test:smoke:phase8-native-ed25519
npm run -s test:smoke:phase8-native-ed25519-verify
npm run -s test:smoke:phase8-native-hard
```

## PASS markers
- `[smoke-phase5-transition] PASS`
- `[smoke-phase6-native-mcp-gateway] PASS`
- `[validate-phase8-native-ed25519] PASS`
- `[smoke-phase8-native-hard] PASS`

## Notes
- Audit events are appended to `data/decision-audit.jsonl` during decide transition flow.
- Native MCP gateway invocation is wrapped via `mcp --input <jsonrpc>` command path.
