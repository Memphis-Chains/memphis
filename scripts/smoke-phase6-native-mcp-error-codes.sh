#!/usr/bin/env bash
set -euo pipefail

BAD_METHOD='{"jsonrpc":"2.0","id":"x1","method":"memphis.bad","params":{"input":"x"}}'
OUT1="$(env DEFAULT_PROVIDER=local-fallback LOCAL_FALLBACK_ENABLED=true npm run -s cli -- mcp --input "$BAD_METHOD" --json)"
echo "$OUT1" | grep -q '"ok": false'
echo "$OUT1" | grep -q '"code": -32601'

OUT2="$(env DEFAULT_PROVIDER=local-fallback LOCAL_FALLBACK_ENABLED=true npm run -s cli -- mcp --input '{bad' --json)"
echo "$OUT2" | grep -q '"ok": false'
echo "$OUT2" | grep -q '"code": -32700'

echo "[smoke-phase6-native-mcp-error-codes] PASS"
