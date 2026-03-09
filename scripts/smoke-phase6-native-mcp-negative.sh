#!/usr/bin/env bash
set -euo pipefail

BAD_METHOD='{"jsonrpc":"2.0","id":"x1","method":"memphis.bad","params":{"input":"x"}}'
OUT1="$(env DEFAULT_PROVIDER=local-fallback LOCAL_FALLBACK_ENABLED=true npm run -s cli -- mcp --input "$BAD_METHOD" --json)"
echo "$OUT1" | grep -q '"ok": false'
echo "$OUT1" | grep -q '"code": -32601'

BAD_INPUT='{"jsonrpc":"2.0","id":"x2","method":"memphis.ask","params":{"input":""}}'
OUT2="$(env DEFAULT_PROVIDER=local-fallback LOCAL_FALLBACK_ENABLED=true npm run -s cli -- mcp --input "$BAD_INPUT" --json)"
echo "$OUT2" | grep -q '"ok": false'
echo "$OUT2" | grep -q '"code": -32602'
echo "$OUT2" | grep -qi 'missing params.input'

echo "[smoke-phase6-native-mcp-negative] PASS"
