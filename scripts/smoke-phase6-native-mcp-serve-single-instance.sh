#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

PORT=47994
rm -f data/mcp-serve-state.json

env DEFAULT_PROVIDER=local-fallback LOCAL_FALLBACK_ENABLED=true npm run -s cli -- mcp serve --port "$PORT" --duration-ms 0 --json >/tmp/mv4-mcp-serve-single-instance.out 2>&1 &
PID=$!
sleep 0.8

OUT="$(npm run -s cli -- mcp serve --port 47995 --duration-ms 0 --json)"
echo "$OUT" | grep -q '"ok": false'
echo "$OUT" | grep -q '"error": "already_running"'
echo "$OUT" | grep -q '"instanceId": "'

npm run -s cli -- mcp serve-stop --json >/tmp/mv4-mcp-serve-single-instance-stop.out
wait "$PID" || true

echo "[smoke-phase6-native-mcp-serve-single-instance] PASS"
