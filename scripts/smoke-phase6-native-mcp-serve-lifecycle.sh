#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

PORT=47993
rm -f data/mcp-serve-state.json

env DEFAULT_PROVIDER=local-fallback LOCAL_FALLBACK_ENABLED=true npm run -s cli -- mcp serve --port "$PORT" --duration-ms 0 --json >/tmp/mv4-mcp-serve-lifecycle.out 2>&1 &
PID=$!
sleep 0.8

STATUS="$(npm run -s cli -- mcp serve-status --json)"
echo "$STATUS" | grep -q '"running": true'
echo "$STATUS" | grep -q '"mode": "mcp-serve-status"'

STOP="$(npm run -s cli -- mcp serve-stop --json)"
echo "$STOP" | grep -q '"stopped": true'

wait "$PID" || true
STATUS2="$(npm run -s cli -- mcp serve-status --json)"
echo "$STATUS2" | grep -q '"running": false'

echo "[smoke-phase6-native-mcp-serve-lifecycle] PASS"
