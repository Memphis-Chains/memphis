#!/usr/bin/env bash
set -euo pipefail

REQ='{"jsonrpc":"2.0","id":"serve-once-smoke","method":"memphis.ask","params":{"input":"serve once smoke","provider":"local-fallback"}}'
OUT="$(env DEFAULT_PROVIDER=local-fallback LOCAL_FALLBACK_ENABLED=true npm run -s cli -- mcp serve-once --input "$REQ" --json)"

echo "$OUT" | grep -q '"ok": true'
echo "$OUT" | grep -q '"mode": "mcp-serve-once"'
echo "$OUT" | grep -q '"jsonrpc": "2.0"'

echo "[smoke-phase6-native-mcp-serve-once] PASS"
