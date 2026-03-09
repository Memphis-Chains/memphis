#!/usr/bin/env bash
set -euo pipefail

OUT_DIR="/tmp/mv4-phase6-native-hard"
mkdir -p "$OUT_DIR"

REQ='{"jsonrpc":"2.0","id":"native-hard-1","method":"memphis.ask","params":{"input":"native mcp hard gate","provider":"local-fallback"}}'
START="$(date +%s%3N)"
OUT="$(env DEFAULT_PROVIDER=local-fallback LOCAL_FALLBACK_ENABLED=true npm run -s cli -- mcp --input "$REQ" --json)"
END="$(date +%s%3N)"
LAT="$((END-START))"

echo "$OUT" > "$OUT_DIR/response.json"

echo "$OUT" | grep -q '"ok": true'
echo "$OUT" | grep -q '"jsonrpc": "2.0"'
if [ "$LAT" -gt 15000 ]; then
  echo "native mcp hard gate latency too high: ${LAT}ms" >&2
  exit 1
fi

# malformed negative
if env DEFAULT_PROVIDER=local-fallback LOCAL_FALLBACK_ENABLED=true npm run -s cli -- mcp --input '{bad' --json >/tmp/mv4-phase6-native-hard-neg.out 2>&1; then
  echo "malformed payload unexpectedly passed" >&2
  exit 1
fi

grep -qi 'valid JSON-RPC payload' /tmp/mv4-phase6-native-hard-neg.out

echo "[smoke-phase6-native-mcp-hard] PASS"
