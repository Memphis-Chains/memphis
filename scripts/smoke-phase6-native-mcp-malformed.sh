#!/usr/bin/env bash
set -euo pipefail

OUT="$(env DEFAULT_PROVIDER=local-fallback LOCAL_FALLBACK_ENABLED=true npm run -s cli -- mcp --input '{bad json' --json)"

echo "$OUT" | grep -q '"ok": false'
echo "$OUT" | grep -q '"code": -32700'
echo "$OUT" | grep -qi 'parse_error'

echo "[smoke-phase6-native-mcp-malformed] PASS"
