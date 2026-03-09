#!/usr/bin/env bash
set -euo pipefail

REQ='{"jsonrpc":"2.0","id":"native-mcp-1","method":"memphis.ask","params":{"input":"native mcp gateway smoke","provider":"local-fallback"}}'
OUT="$(env DEFAULT_PROVIDER=local-fallback LOCAL_FALLBACK_ENABLED=true npm run -s cli -- mcp --input "$REQ" --json)"

echo "$OUT" | grep -q '"ok": true'
echo "$OUT" | grep -q '"jsonrpc": "2.0"'
echo "$OUT" | grep -q '"providerUsed": "local-fallback"'

echo "[smoke-phase6-native-mcp-gateway] PASS"
