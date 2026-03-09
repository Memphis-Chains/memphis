#!/usr/bin/env bash
set -euo pipefail

PORT=47992
OUT="$(env DEFAULT_PROVIDER=local-fallback LOCAL_FALLBACK_ENABLED=true npm run -s cli -- mcp serve --port "$PORT" --duration-ms 300 --json)"

echo "$OUT" | grep -q '"mode": "mcp-serve"'
echo "$OUT" | grep -q '"mode": "mcp-serve-stopped"'
echo "$OUT" | grep -q '"reason": "timeout"'

echo "[smoke-phase6-native-mcp-serve-graceful] PASS"
